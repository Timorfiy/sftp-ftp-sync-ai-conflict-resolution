import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder } from 'util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { redactedErrorMessage } from '../security/redaction';
import {
  requireSafeLocalPath,
  SafeLocalPathError,
} from '../helper/safeLocalPath';
import {
  conflictBridgeResponseSchema,
  conflictIdSchema,
  conflictStatusSchema,
  CONFLICT_PROTOCOL_VERSION,
  MAX_DIFF_BYTES_PER_SIDE,
  MCP_CONFIG_ENV,
  MCP_SERVER_NAME,
  mcpLaunchConfigurationSchema,
  McpLaunchConfiguration,
  TOOL_DESCRIPTIONS,
  toolInputSchemas,
} from './conflictContract';

interface StoredRecord {
  version: 2;
  id: string;
  revision: number;
  status: string;
  reason?: string;
  detectedAt: string;
  updatedAt: string;
  workspaceRoot: string;
  localFile: string;
  remoteFile: string;
  reportFile: string;
  remoteSnapshot: string | null;
  localSnapshot?: string | null;
  snapshotError?: string;
  localSnapshotError?: string;
  staleReason?: string;
  local?: { mtime: number; size: number; sha256: string | null };
  remote?: { mtime: number; size: number; sha256: string | null };
  candidate?: {
    source: 'submitted' | 'acknowledged';
    sha256: string;
    preparedAt: string;
  };
  result?: {
    uploadedAt?: string;
    cancelledAt?: string;
    failedAt?: string;
    orphanedAt?: string;
    error?: string;
  };
}

interface LocatedRecord {
  record: StoredRecord;
  directory: string;
  workspace: McpLaunchConfiguration['workspaces'][number];
}

class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

const terminalStatuses = new Set(['uploaded', 'cancelled', 'failed', 'orphaned']);
const mutableStatuses = new Set(['capturing', 'pending', 'reviewing']);

function safeMessage(error: unknown): string {
  const text = redactedErrorMessage(error);
  return text.replace(/[A-Za-z]:[\\/][^\s"']+|\/(?:[^\s/"']+\/)+[^\s"']+/g, '<path>').slice(0, 800);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T;
  } catch (_error) {
    return undefined;
  }
}

async function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(value), {
    encoding: 'utf8',
    flag: 'wx',
  });
  await fs.promises.rename(temporary, file);
}

function loadConfiguration(): McpLaunchConfiguration {
  const raw = process.env[MCP_CONFIG_ENV];
  if (!raw) {
    throw new Error(`${MCP_CONFIG_ENV} is missing.`);
  }
  try {
    return mcpLaunchConfigurationSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('MCP launch configuration is invalid. Restart the editor workspace to regenerate it.');
  }
}

function workspaceStateRoot(
  config: McpLaunchConfiguration,
  workspace: McpLaunchConfiguration['workspaces'][number]
): string {
  return path.join(config.stateRoot, 'workspaces', workspace.bucket);
}

async function locateRecord(
  config: McpLaunchConfiguration,
  conflictId: string,
  workspaceBucket?: string
): Promise<LocatedRecord> {
  conflictIdSchema.parse(conflictId);
  const workspaces = workspaceBucket
    ? config.workspaces.filter(item => item.bucket === workspaceBucket)
    : config.workspaces;
  if (workspaceBucket && workspaces.length === 0) {
    throw new ToolFailure('wrong_workspace', 'The workspace is not open in this editor window.');
  }
  const matches: LocatedRecord[] = [];
  for (const workspace of workspaces) {
    const directory = path.join(workspaceStateRoot(config, workspace), conflictId);
    const expectedReport = path.join(directory, 'conflict.json');
    try {
      await requireSafeLocalPath(workspaceStateRoot(config, workspace), expectedReport, {
        type: 'file',
      });
    } catch (error) {
      if (error instanceof SafeLocalPathError) {
        if (error.reason === 'unavailable') {
          continue;
        }
        throw new ToolFailure('invalid_record', 'The conflict record failed path validation.');
      }
      throw error;
    }
    const record = await readJson<StoredRecord>(expectedReport);
    if (!record || record.version !== 2 || record.id !== conflictId) {
      continue;
    }
    if (
      path.resolve(record.reportFile) !== path.resolve(expectedReport) ||
      path.resolve(record.workspaceRoot) !== path.resolve(workspace.root)
    ) {
      throw new ToolFailure('invalid_record', 'The conflict record failed workspace validation.');
    }
    conflictStatusSchema.parse(record.status);
    matches.push({ record, directory, workspace });
  }
  if (matches.length === 0) {
    throw new ToolFailure('not_found', 'No conflict with that ID exists in the open workspaces.');
  }
  if (matches.length > 1) {
    throw new ToolFailure(
      'workspace_required',
      'This conflict ID exists in multiple roots; pass the workspace bucket returned by conflicts_list.'
    );
  }
  return matches[0];
}

async function publicRecord(located: LocatedRecord): Promise<Record<string, unknown>> {
  const { record, directory, workspace } = located;
  try {
    await requireSafeLocalPath(workspace.root, record.localFile, {
      allowMissingLeaf: true,
      type: 'file',
    });
    if (record.remoteSnapshot) {
      await requireSafeLocalPath(directory, record.remoteSnapshot, {
        allowMissingLeaf: true,
        type: 'file',
      });
    }
    if (record.localSnapshot) {
      await requireSafeLocalPath(directory, record.localSnapshot, {
        allowMissingLeaf: true,
        type: 'file',
      });
    }
  } catch (error) {
    if (error instanceof SafeLocalPathError) {
      throw new ToolFailure('invalid_record', 'The conflict record failed path validation.');
    }
    throw error;
  }
  return {
    conflictId: record.id,
    workspace: workspace.bucket,
    workspaceName: workspace.name,
    path: path.relative(workspace.root, record.localFile).replace(/\\/g, '/'),
    remotePath: record.remoteFile.replace(/\\/g, '/'),
    status: record.status,
    revision: record.revision,
    reason: record.reason,
    detectedAt: record.detectedAt,
    updatedAt: record.updatedAt,
    staleReason: record.staleReason,
    local: record.local,
    remote: record.remote,
    remoteSnapshot: record.remoteSnapshot
      ? { available: true }
      : {
          available: false,
          reason: safeMessage(record.snapshotError || 'Remote snapshot is unavailable.'),
        },
    localRecovery: record.localSnapshot
      ? { available: true }
      : {
          available: false,
          reason: safeMessage(
            record.localSnapshotError || 'A local recovery snapshot is unavailable.'
          ),
        },
    candidate: record.candidate
      ? {
          source: record.candidate.source,
          sha256: record.candidate.sha256,
          preparedAt: record.candidate.preparedAt,
        }
      : null,
    result:
      record.status === 'failed'
        ? {
            failedAt: record.result?.failedAt,
            error: record.result?.error ? safeMessage(record.result.error) : 'Upload failed.',
          }
        : record.result,
  };
}

function requireMutableRecord(located: LocatedRecord): void {
  if (!mutableStatuses.has(located.record.status)) {
    throw new ToolFailure(
      'terminal_conflict',
      `Conflict status ${located.record.status} cannot be mutated.`
    );
  }
}

async function listRecords(
  config: McpLaunchConfiguration,
  includeTerminal: boolean,
  limit: number
): Promise<Record<string, unknown>[]> {
  const records: LocatedRecord[] = [];
  for (const workspace of config.workspaces) {
    const root = workspaceStateRoot(config, workspace);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !conflictIdSchema.safeParse(entry.name).success) {
        continue;
      }
      const directory = path.join(root, entry.name);
      const expectedReport = path.join(directory, 'conflict.json');
      try {
        await requireSafeLocalPath(root, expectedReport, { type: 'file' });
      } catch (error) {
        if (error instanceof SafeLocalPathError) {
          throw new ToolFailure('invalid_record', 'A conflict record failed path validation.');
        }
        throw error;
      }
      const record = await readJson<StoredRecord>(expectedReport);
      if (!record || record.version !== 2 || record.id !== entry.name) {
        continue;
      }
      if (
        path.resolve(record.reportFile) !== path.resolve(expectedReport) ||
        path.resolve(record.workspaceRoot) !== path.resolve(workspace.root)
      ) {
        throw new ToolFailure('invalid_record', 'A conflict record failed workspace validation.');
      }
      conflictStatusSchema.parse(record.status);
      if (!includeTerminal && terminalStatuses.has(record.status)) {
        continue;
      }
      records.push({ record, directory, workspace });
    }
  }
  const selected = records
    .sort((a, b) => Date.parse(b.record.updatedAt) - Date.parse(a.record.updatedAt))
    .slice(0, limit);
  return Promise.all(selected.map(record => publicRecord(record)));
}

async function ensureRegularFile(file: string, allowedRoot: string): Promise<fs.Stats> {
  try {
    return (await requireSafeLocalPath(allowedRoot, file, { type: 'file' }))!;
  } catch (error) {
    if (error instanceof SafeLocalPathError) {
      if (error.reason === 'unavailable') {
        throw new ToolFailure('unavailable', 'The requested conflict content is unavailable.');
      }
      if (error.reason === 'outside_root') {
        throw new ToolFailure('invalid_record', 'The conflict file failed path validation.');
      }
      throw new ToolFailure('unsupported_file', 'Only regular files without symbolic links can be read.');
    }
    throw error;
  }
}

function binaryContent(message: string): never {
  throw new ToolFailure('binary_content', message);
}

function isContinuationByte(value: number): boolean {
  return value >= 0x80 && value <= 0xbf;
}

function utf8SequenceLength(bytes: Buffer, index: number): number {
  const first = bytes[index];
  let length: number;
  if (first <= 0x7f) {
    length = 1;
  } else if (first >= 0xc2 && first <= 0xdf) {
    length = 2;
  } else if (first >= 0xe0 && first <= 0xef) {
    length = 3;
  } else if (first >= 0xf0 && first <= 0xf4) {
    length = 4;
  } else {
    binaryContent('Conflict content is not valid UTF-8 text.');
  }
  if (index + length > bytes.length) {
    binaryContent('Conflict content ends with an incomplete UTF-8 character.');
  }
  for (let offset = 1; offset < length; offset += 1) {
    if (!isContinuationByte(bytes[index + offset])) {
      binaryContent('Conflict content is not valid UTF-8 text.');
    }
  }
  const second = bytes[index + 1];
  if (
    (first === 0xe0 && second < 0xa0) ||
    (first === 0xed && second > 0x9f) ||
    (first === 0xf0 && second < 0x90) ||
    (first === 0xf4 && second > 0x8f)
  ) {
    binaryContent('Conflict content is not valid UTF-8 text.');
  }
  return length;
}

function decodeUtf8Prefix(
  bytes: Buffer,
  maxBytes: number,
  allowFirstCharacterOverrun: boolean
): { text: string; bytesUsed: number } {
  let cursor = 0;
  let bytesUsed = 0;
  while (cursor < bytes.length && cursor < maxBytes) {
    const length = utf8SequenceLength(bytes, cursor);
    const next = cursor + length;
    if (next > maxBytes && !(allowFirstCharacterOverrun && cursor === 0)) {
      break;
    }
    bytesUsed = next;
    cursor = next;
  }
  const selected = bytes.subarray(0, bytesUsed);
  if (selected.includes(0)) {
    binaryContent('Binary conflict content is not exposed to the agent.');
  }
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(selected),
      bytesUsed,
    };
  } catch (_error) {
    binaryContent('Conflict content is not valid UTF-8 text.');
  }
}

async function alignUtf8Offset(
  handle: Awaited<ReturnType<typeof fs.promises.open>>,
  requestedOffset: number,
  fileSize: number
): Promise<number> {
  if (requestedOffset <= 0 || requestedOffset >= fileSize) {
    return Math.min(requestedOffset, fileSize);
  }
  const probeStart = Math.max(0, requestedOffset - 3);
  const relativeOffset = requestedOffset - probeStart;
  const probe = Buffer.alloc(Math.min(fileSize - probeStart, relativeOffset + 4));
  const { bytesRead } = await handle.read(probe, 0, probe.length, probeStart);
  const bytes = probe.subarray(0, bytesRead);
  if (!isContinuationByte(bytes[relativeOffset])) {
    return requestedOffset;
  }
  let lead = relativeOffset - 1;
  while (lead >= 0 && isContinuationByte(bytes[lead])) {
    lead -= 1;
  }
  if (lead < 0) {
    binaryContent('Conflict content is not valid UTF-8 text.');
  }
  const length = utf8SequenceLength(bytes, lead);
  if (relativeOffset >= lead + length) {
    binaryContent('Conflict content is not valid UTF-8 text.');
  }
  return probeStart + lead;
}

async function readChunk(
  located: LocatedRecord,
  side: 'local' | 'remote',
  offset: number,
  maxBytes: number
): Promise<Record<string, unknown>> {
  const { record, directory, workspace } = located;
  const file = side === 'local' ? record.localFile : record.remoteSnapshot;
  if (!file) {
    throw new ToolFailure(
      'snapshot_unavailable',
      safeMessage(record.snapshotError || 'The remote snapshot is unavailable.')
    );
  }
  await ensureRegularFile(file, side === 'local' ? workspace.root : directory);
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    const actualOffset = await alignUtf8Offset(handle, offset, stat.size);
    const readLength = Math.min(stat.size - actualOffset, maxBytes + 3);
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, actualOffset);
    const decoded = decodeUtf8Prefix(
      buffer.subarray(0, bytesRead),
      maxBytes,
      true
    );
    const nextOffset =
      actualOffset + decoded.bytesUsed < stat.size
        ? actualOffset + decoded.bytesUsed
        : null;
    return {
      ...(await publicRecord(located)),
      side,
      offset: actualOffset,
      ...(actualOffset === offset ? {} : { requestedOffset: offset }),
      bytesRead: decoded.bytesUsed,
      nextOffset,
      truncated: nextOffset !== null,
      sha256: await hashFile(file),
      content: decoded.text,
    };
  } finally {
    await handle.close();
  }
}

async function readBoundedText(
  file: string,
  allowedRoot: string
): Promise<{ text: string; truncated: boolean }> {
  const stat = await ensureRegularFile(file, allowedRoot);
  const max = Math.min(stat.size, MAX_DIFF_BYTES_PER_SIDE);
  const handle = await fs.promises.open(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, max + 3));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const decoded = decodeUtf8Prefix(buffer.subarray(0, bytesRead), max, false);
    return {
      text: decoded.text,
      truncated: stat.size > decoded.bytesUsed,
    };
  } finally {
    await handle.close();
  }
}

function boundedDiff(remote: string, local: string): { diff: string; truncated: boolean } {
  const remoteLines = remote.split(/\r?\n/);
  const localLines = local.split(/\r?\n/);
  const lines = ['--- remote', '+++ local'];
  const maxLines = 4000;
  const count = Math.max(remoteLines.length, localLines.length);
  for (let index = 0; index < count && lines.length < maxLines; index += 1) {
    const before = remoteLines[index];
    const after = localLines[index];
    if (before === after) {
      lines.push(` ${before ?? ''}`);
    } else {
      if (before !== undefined) {
        lines.push(`-${before}`);
      }
      if (after !== undefined && lines.length < maxLines) {
        lines.push(`+${after}`);
      }
    }
  }
  return { diff: lines.join('\n'), truncated: count >= maxLines };
}

async function sendBridgeRequest(
  config: McpLaunchConfiguration,
  located: LocatedRecord,
  request: Record<string, unknown>,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const requestId = randomUUID();
  const requestsDirectory = path.join(located.directory, 'requests');
  const responsesDirectory = path.join(located.directory, 'responses');
  try {
    await Promise.all([
      requireSafeLocalPath(located.directory, requestsDirectory, { type: 'directory' }),
      requireSafeLocalPath(located.directory, responsesDirectory, { type: 'directory' }),
    ]);
  } catch (error) {
    if (error instanceof SafeLocalPathError) {
      throw new ToolFailure('invalid_record', 'The conflict bridge path failed validation.');
    }
    throw error;
  }
  const requestFile = path.join(requestsDirectory, `${requestId}.json`);
  const responseFile = path.join(responsesDirectory, `${requestId}.json`);
  await atomicWriteJson(requestFile, {
    version: CONFLICT_PROTOCOL_VERSION,
    requestId,
    capability: config.capability,
    createdAt: new Date().toISOString(),
    ...request,
  });
  const started = Date.now();
  try {
    for (;;) {
      if (signal.aborted) {
        throw new ToolFailure('cancelled', 'The tool call was cancelled.');
      }
      try {
        await requireSafeLocalPath(responsesDirectory, responseFile, {
          allowMissingLeaf: true,
          type: 'file',
        });
      } catch (error) {
        if (error instanceof SafeLocalPathError) {
          throw new ToolFailure('invalid_response', 'The extension response path failed validation.');
        }
        throw error;
      }
      const raw = await readJson<unknown>(responseFile);
      if (raw) {
        const response = conflictBridgeResponseSchema.parse(raw);
        if (response.requestId !== requestId) {
          throw new ToolFailure('invalid_response', 'The extension returned an invalid response.');
        }
        if (!response.accepted) {
          throw new ToolFailure(
            response.stale ? 'stale' : response.error || 'rejected',
            response.message || 'The live extension rejected the request.',
            {
              revision: response.revision,
              status: response.status,
              stale: response.stale || false,
            }
          );
        }
        return response;
      }
      if (Date.now() - started > 15_000) {
        throw new ToolFailure(
          'extension_timeout',
          'The live extension did not answer within 15 seconds. Reload the editor and retry.'
        );
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    await fs.promises.rm(requestFile, { force: true }).catch(() => undefined);
  }
}

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function toolHandler<T extends Record<string, unknown>>(
  handler: (input: T, signal: AbortSignal) => Promise<Record<string, unknown>>
) {
  return async (input: T, extra: { signal: AbortSignal }) => {
    try {
      return toolResult({ ok: true, ...(await handler(input, extra.signal)) });
    } catch (error) {
      const failure =
        error instanceof ToolFailure
          ? error
          : new ToolFailure('internal_error', safeMessage(error));
      return {
        ...toolResult({
          ok: false,
          error: {
            code: failure.code,
            message: safeMessage(failure.message),
            ...(failure.details || {}),
          },
        }),
        isError: true,
      };
    }
  };
}

export function createConflictMcpServer(
  config: McpLaunchConfiguration,
  instructions: string
): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: config.extensionVersion },
    { instructions }
  );

  server.registerTool(
    'conflicts_list',
    {
      description: TOOL_DESCRIPTIONS.conflicts_list,
      inputSchema: toolInputSchemas.conflicts_list,
      annotations: { readOnlyHint: true },
    },
    toolHandler(async ({ includeTerminal, limit }) => ({
      conflicts: await listRecords(config, Boolean(includeTerminal), Number(limit)),
    }))
  );

  server.registerTool(
    'conflicts_get',
    {
      description: TOOL_DESCRIPTIONS.conflicts_get,
      inputSchema: toolInputSchemas.conflicts_get,
      annotations: { readOnlyHint: true },
    },
    toolHandler(async ({ conflictId, workspace }) =>
      publicRecord(await locateRecord(config, String(conflictId), workspace as string | undefined))
    )
  );

  server.registerTool(
    'conflicts_read',
    {
      description: TOOL_DESCRIPTIONS.conflicts_read,
      inputSchema: toolInputSchemas.conflicts_read,
      annotations: { readOnlyHint: true },
    },
    toolHandler(async ({ conflictId, workspace, side, offset, maxBytes }) =>
      readChunk(
        await locateRecord(config, String(conflictId), workspace as string | undefined),
        side as 'local' | 'remote',
        Number(offset),
        Number(maxBytes)
      )
    )
  );

  server.registerTool(
    'conflicts_diff',
    {
      description: TOOL_DESCRIPTIONS.conflicts_diff,
      inputSchema: toolInputSchemas.conflicts_diff,
      annotations: { readOnlyHint: true },
    },
    toolHandler(async ({ conflictId, workspace }) => {
      const located = await locateRecord(
        config,
        String(conflictId),
        workspace as string | undefined
      );
      if (!located.record.remoteSnapshot) {
        throw new ToolFailure(
          'snapshot_unavailable',
          safeMessage(located.record.snapshotError || 'The remote snapshot is unavailable.')
        );
      }
      const [remote, local] = await Promise.all([
        readBoundedText(located.record.remoteSnapshot, located.directory),
        readBoundedText(located.record.localFile, located.workspace.root),
      ]);
      const result = boundedDiff(remote.text, local.text);
      return {
        ...(await publicRecord(located)),
        diff: result.diff,
        truncated: result.truncated || remote.truncated || local.truncated,
      };
    })
  );

  server.registerTool(
    'conflicts_submit_local',
    {
      description: TOOL_DESCRIPTIONS.conflicts_submit_local,
      inputSchema: toolInputSchemas.conflicts_submit_local,
      annotations: { destructiveHint: true },
    },
    toolHandler(async (input, signal) => {
      const located = await locateRecord(
        config,
        String(input.conflictId),
        input.workspace as string | undefined
      );
      requireMutableRecord(located);
      return sendBridgeRequest(
        config,
        located,
        {
          kind: 'submit_local',
          expectedRevision: Number(input.expectedRevision),
          expectedLocalSha256: input.expectedLocalSha256,
          content: input.content,
        },
        signal
      );
    })
  );

  server.registerTool(
    'conflicts_acknowledge_local',
    {
      description: TOOL_DESCRIPTIONS.conflicts_acknowledge_local,
      inputSchema: toolInputSchemas.conflicts_acknowledge_local,
    },
    toolHandler(async (input, signal) => {
      const located = await locateRecord(
        config,
        String(input.conflictId),
        input.workspace as string | undefined
      );
      requireMutableRecord(located);
      return sendBridgeRequest(config, located, {
        kind: 'acknowledge_local',
        expectedRevision: Number(input.expectedRevision),
        expectedLocalSha256: input.expectedLocalSha256,
      }, signal);
    })
  );

  server.registerTool(
    'conflicts_resolve',
    {
      description: TOOL_DESCRIPTIONS.conflicts_resolve,
      inputSchema: toolInputSchemas.conflicts_resolve,
      annotations: { destructiveHint: true },
    },
    toolHandler(async (input, signal) => {
      const located = await locateRecord(
        config,
        String(input.conflictId),
        input.workspace as string | undefined
      );
      requireMutableRecord(located);
      return sendBridgeRequest(config, located, {
        kind: 'resolve',
        expectedRevision: Number(input.expectedRevision),
        action: input.action,
      }, signal);
    })
  );

  server.registerTool(
    'conflicts_wait',
    {
      description: TOOL_DESCRIPTIONS.conflicts_wait,
      inputSchema: toolInputSchemas.conflicts_wait,
      annotations: { readOnlyHint: true },
    },
    toolHandler(async (input, signal) => {
      const deadline = Date.now() + Number(input.timeoutSeconds) * 1000;
      for (;;) {
        if (signal.aborted) {
          throw new ToolFailure('cancelled', 'The wait was cancelled.');
        }
        const located = await locateRecord(
          config,
          String(input.conflictId),
          input.workspace as string | undefined
        );
        if (
          located.record.revision !== Number(input.expectedRevision) &&
          !terminalStatuses.has(located.record.status)
        ) {
          return {
            terminal: false,
            stale: true,
            ...(await publicRecord(located)),
          };
        }
        if (terminalStatuses.has(located.record.status)) {
          return {
            terminal: true,
            stale: false,
            ...(await publicRecord(located)),
          };
        }
        if (Date.now() >= deadline) {
          return {
            terminal: false,
            stale: false,
            timedOut: true,
            ...(await publicRecord(located)),
          };
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    })
  );

  return server;
}

export async function runConflictMcpServer(): Promise<void> {
  const config = loadConfiguration();
  const instructionsPath = path.join(__dirname, '..', 'resources', 'mcp', 'conflict-resolution-instructions.md');
  const instructions = await fs.promises.readFile(instructionsPath, 'utf8');
  const server = createConflictMcpServer(config, instructions);
  await server.connect(new StdioServerTransport());
}

if (process.env[MCP_CONFIG_ENV]) {
  void runConflictMcpServer().catch(error => {
    process.stderr.write(`SFTP Sync AI MCP server failed: ${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
}
