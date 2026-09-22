import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as fileOperations from '../../core/fileBaseOperations';
import type { FileStats } from '../../core/fs/fileSystem';
import localFs from '../../core/localFs';
import logger from '../../logger';
import { diff } from '../diff';
import type { FileTransferContext } from './transfer';
import type { RemoteBaseline } from './remoteBaseline';

export const CONFLICT_PROTOCOL_VERSION = 2;

export type UploadConflictReason =
  | 'remote-changed'
  | 'baseline-missing'
  | 'timestamp-unavailable';

export type ConflictStatus =
  | 'capturing'
  | 'pending'
  | 'reviewing'
  | 'resolving'
  | 'uploading'
  | 'uploaded'
  | 'cancelled'
  | 'failed'
  | 'orphaned';

export type ConflictDecisionAction = 'overwrite' | 'overwrite_all' | 'cancel';
export type ConflictDecisionSource = 'mcp' | 'cursor' | 'batch';

interface ConflictFileMetadata {
  mtime: number;
  size: number;
  sha256: string | null;
}

interface ConflictDecision {
  requestId?: string;
  action: ConflictDecisionAction;
  source: ConflictDecisionSource;
  requestedAt: string;
  acceptedAt: string;
}

export interface ConflictRecord {
  version: 2;
  id: string;
  status: ConflictStatus;
  revision: number;
  reason: UploadConflictReason;
  detectedAt: string;
  updatedAt: string;
  workspaceRoot: string;
  sessionId: string;
  batchId: string;
  localFile: string;
  remoteFile: string;
  remoteSnapshot: string | null;
  reportFile: string;
  local: ConflictFileMetadata;
  remote: ConflictFileMetadata;
  baseline: Pick<RemoteBaseline, 'mtime' | 'size'> | null;
  snapshotError?: string;
  staleReason?: string;
  remoteMissingAt?: string;
  decision?: ConflictDecision;
  result?: {
    uploadedAt?: string;
    cancelledAt?: string;
    failedAt?: string;
    orphanedAt?: string;
    error?: string;
  };
}

export interface ConflictSession {
  root: string;
  record: ConflictRecord;
}

export interface ConflictReportRef {
  root: string;
  id: string;
}

interface BridgeRequest {
  version: 2;
  requestId?: string;
  kind: 'open_diff' | 'resolve';
  expectedRevision: number;
  action?: ConflictDecisionAction;
  source?: 'mcp';
  createdAt?: string;
}

interface RequestEnvelope {
  request: BridgeRequest;
  requestId: string;
  responseFile: string;
}

const TERMINAL_STATUSES = new Set<ConflictStatus>([
  'uploaded',
  'cancelled',
  'failed',
  'orphaned',
]);
const RECENT_TERMINAL_LIMIT = 100;
const REQUEST_POLL_MS = 200;
const extensionSessionId = `${Date.now()}-${process.pid}-${randomUUID()}`;
const workspaceRoots = new Set<string>();
const writeQueues = new Map<string, Promise<void>>();
const resolvedSessions = new Set<string>();
const activeQuickPicks = new Map<string, vscode.QuickPick<vscode.QuickPickItem>>();
let manualUiQueue: Promise<void> = Promise.resolve();
let extensionVersion = '3.5.0';
let conflictSequence = 0;

function now(): string {
  return new Date().toISOString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotFoundError(error: any): boolean {
  return error?.code === 'ENOENT' || error?.code === 2 || error?.message === 'file not exist';
}

function isTerminal(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_STATUSES.has(status as ConflictStatus);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'file';
}

function workspaceConflictRoot(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), '.kent-tmp', 'sftp-conflicts');
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T;
  } catch (_error) {
    return undefined;
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  try {
    await fs.promises.rename(temporary, file);
  } catch (error) {
    try {
      await fs.promises.copyFile(temporary, file);
      await fs.promises.unlink(temporary);
    } catch (_copyError) {
      throw error;
    }
  }
}

function queueWrite(root: string, operation: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(root) || Promise.resolve();
  const current = previous.then(operation, operation);
  writeQueues.set(root, current.then(() => undefined, () => undefined));
  return current;
}

async function writeIndexRecord(root: string, record: ConflictRecord): Promise<void> {
  return queueWrite(root, async () => {
    const indexFile = path.join(root, 'index.json');
    const existing = await readJson<{ conflicts?: any[] }>(indexFile);
    const withoutCurrent = (existing?.conflicts || []).filter(item => item?.id !== record.id);
    const active = withoutCurrent.filter(
      item => item?.version === 2 && !isTerminal(item?.status)
    );
    const terminal = withoutCurrent
      .filter(item => item?.version !== 2 || isTerminal(item?.status))
      .slice(-RECENT_TERMINAL_LIMIT);
    const conflicts = [...terminal, ...active, record];
    await atomicWriteJson(indexFile, {
      version: CONFLICT_PROTOCOL_VERSION,
      updatedAt: now(),
      conflicts,
    });
    await atomicWriteJson(record.reportFile, record);
  });
}

async function updateSession(
  session: ConflictSession,
  status: ConflictStatus,
  changes: Partial<ConflictRecord> = {}
): Promise<void> {
  Object.assign(session.record, changes);
  session.record.status = status;
  session.record.updatedAt = now();
  await writeIndexRecord(session.root, session.record);
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

async function hashFileOrNull(file: string): Promise<string | null> {
  try {
    return await hashFile(file);
  } catch (_error) {
    return null;
  }
}

function metadataMatches(
  a: Pick<FileStats, 'mtime' | 'size'>,
  b: Pick<FileStats, 'mtime' | 'size'>
): boolean {
  return Math.floor(a.mtime / 1000) === Math.floor(b.mtime / 1000) && a.size === b.size;
}

function encodePowerShell(value: string): string {
  return Buffer.from(value, 'utf16le').toString('base64');
}

function notifyWindows(title: string, message: string): void {
  if (process.platform !== 'win32') {
    return;
  }
  try {
    const script = `Add-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\n$kentTitle=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodePowerShell(title)}'))\n$kentText=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodePowerShell(message.slice(0, 220))}'))\n$kentNotify=New-Object System.Windows.Forms.NotifyIcon\n$kentNotify.Icon=[System.Drawing.SystemIcons]::Warning\n$kentNotify.BalloonTipIcon=[System.Windows.Forms.ToolTipIcon]::Warning\n$kentNotify.BalloonTipTitle=$kentTitle\n$kentNotify.BalloonTipText=$kentText\n$kentNotify.Visible=$true\n[System.Media.SystemSounds]::Exclamation.Play()\n$kentNotify.ShowBalloonTip(10000)\nStart-Sleep -Seconds 12\n$kentNotify.Dispose()`;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
      { detached: true, windowsHide: true, stdio: 'ignore' }
    );
    child.on('error', error => {
      logger.warn(`Could not show Windows conflict notification: ${cleanError(error)}`);
    });
    child.unref();
  } catch (error) {
    logger.warn(`Could not start Windows conflict notification: ${cleanError(error)}`);
  }
}

async function writeBridge(root: string): Promise<void> {
  await atomicWriteJson(path.join(root, 'bridge.json'), {
    version: CONFLICT_PROTOCOL_VERSION,
    protocolVersion: CONFLICT_PROTOCOL_VERSION,
    extensionVersion,
    pid: process.pid,
    sessionId: extensionSessionId,
    startedAt: now(),
  });
}

async function orphanPreviousSession(root: string): Promise<void> {
  const indexFile = path.join(root, 'index.json');
  const index = await readJson<{ conflicts?: any[] }>(indexFile);
  if (!Array.isArray(index?.conflicts)) {
    return;
  }
  let changed = false;
  const reportWrites: Array<Promise<void>> = [];
  const conflicts = index!.conflicts!.map(item => {
    if (
      item?.version === 2 &&
      !isTerminal(item.status) &&
      item.sessionId !== extensionSessionId
    ) {
      changed = true;
      const updatedAt = now();
      const orphaned = {
        ...item,
        status: 'orphaned',
        updatedAt,
        result: { ...(item.result || {}), orphanedAt: updatedAt },
      };
      if (typeof orphaned.reportFile === 'string') {
        reportWrites.push(atomicWriteJson(orphaned.reportFile, orphaned));
      }
      return orphaned;
    }
    return item;
  });
  if (changed) {
    await Promise.all(reportWrites);
    await atomicWriteJson(indexFile, {
      version: CONFLICT_PROTOCOL_VERSION,
      updatedAt: now(),
      conflicts,
    });
  }
}

export async function initializeConflictBridge(
  workspaces: readonly string[],
  version: string
): Promise<void> {
  extensionVersion = version;
  await Promise.all(
    workspaces.map(async workspace => {
      const root = workspaceConflictRoot(workspace);
      workspaceRoots.add(root);
      await fs.promises.mkdir(root, { recursive: true });
      await orphanPreviousSession(root);
      await writeBridge(root);
    })
  );
}

export async function disposeConflictBridge(): Promise<void> {
  await Promise.all(
    Array.from(workspaceRoots).map(async root => {
      const bridgeFile = path.join(root, 'bridge.json');
      const bridge = await readJson<{ sessionId?: string }>(bridgeFile);
      if (bridge?.sessionId === extensionSessionId) {
        try {
          await fs.promises.unlink(bridgeFile);
        } catch (_error) {
          // The bridge is advisory. A missing or already-removed file is harmless.
        }
      }
    })
  );
  workspaceRoots.clear();
}

export async function captureConflict(
  workspaceRoot: string,
  batchId: string,
  context: FileTransferContext,
  reason: UploadConflictReason,
  remote: Pick<FileStats, 'mtime' | 'size'>,
  baseline?: RemoteBaseline
): Promise<ConflictSession> {
  const root = workspaceConflictRoot(workspaceRoot);
  if (!workspaceRoots.has(root)) {
    workspaceRoots.add(root);
    await fs.promises.mkdir(root, { recursive: true });
    await writeBridge(root);
  }

  const detectedAt = now();
  const id = `${detectedAt.replace(/[:.]/g, '-')}-${process.pid}-${++conflictSequence}-${safeName(path.basename(context.srcFsPath))}`;
  const directory = path.join(root, id);
  const extension = path.extname(context.srcFsPath) || '.bin';
  const remoteSnapshot = path.join(directory, `remote${extension}`);
  const reportFile = path.join(directory, 'conflict.json');
  await fs.promises.mkdir(path.join(directory, 'requests'), { recursive: true });
  await fs.promises.mkdir(path.join(directory, 'responses'), { recursive: true });

  const record: ConflictRecord = {
    version: 2,
    id,
    status: 'capturing',
    revision: 1,
    reason,
    detectedAt,
    updatedAt: detectedAt,
    workspaceRoot: path.resolve(workspaceRoot),
    sessionId: extensionSessionId,
    batchId,
    localFile: context.srcFsPath,
    remoteFile: context.targetFsPath,
    remoteSnapshot,
    reportFile,
    local: {
      mtime: context.sourceMtime,
      size: context.sourceSize,
      sha256: await hashFileOrNull(context.srcFsPath),
    },
    remote: {
      mtime: remote.mtime,
      size: remote.size,
      sha256: null,
    },
    baseline: baseline ? { mtime: baseline.mtime, size: baseline.size } : null,
  };
  const session = { root, record };
  await writeIndexRecord(root, record);
  notifyWindows(
    'SFTP Neo — конфликт',
    `Загрузка ${path.basename(context.srcFsPath)} остановлена: серверный файл изменён.`
  );

  try {
    await fileOperations.transferFile(
      context.targetFsPath,
      remoteSnapshot,
      context.targetFs,
      localFs
    );
    record.remote.sha256 = await hashFile(remoteSnapshot);
    await updateSession(session, 'pending', { snapshotError: undefined });
  } catch (error) {
    await updateSession(session, 'pending', {
      remoteSnapshot: null,
      snapshotError: cleanError(error),
    });
    logger.warn(
      `Could not capture remote conflict snapshot for ${context.targetFsPath}: ${cleanError(error)}`
    );
  }

  return session;
}

async function openNativeDiff(
  session: ConflictSession,
  context: FileTransferContext
): Promise<void> {
  if (!isTerminal(session.record.status)) {
    await updateSession(session, 'reviewing');
  }
  try {
    const snapshot = session.record.remoteSnapshot;
    if (snapshot && fs.existsSync(snapshot)) {
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(snapshot),
        vscode.Uri.file(context.srcFsPath),
        `${path.basename(context.srcFsPath)} (remote ↔ local)`
      );
    } else {
      await diff(vscode.Uri.file(context.srcFsPath));
    }
  } catch (error) {
    logger.warn(`Could not open conflict diff for ${context.targetFsPath}: ${cleanError(error)}`);
    throw error;
  }
}

async function replaceSnapshot(source: string, destination: string): Promise<void> {
  await fs.promises.copyFile(source, destination);
  try {
    await fs.promises.unlink(source);
  } catch (_error) {
    // A stale temporary snapshot is harmless and remains under .kent-tmp.
  }
}

async function refreshRemoteSnapshot(
  session: ConflictSession,
  context: FileTransferContext,
  remote: Pick<FileStats, 'mtime' | 'size'>
): Promise<string | null> {
  const directory = path.dirname(session.record.reportFile);
  const extension = path.extname(context.srcFsPath) || '.bin';
  const permanent = path.join(directory, `remote${extension}`);
  const temporary = path.join(directory, `remote-check-${randomUUID()}${extension}`);
  try {
    await fileOperations.transferFile(
      context.targetFsPath,
      temporary,
      context.targetFs,
      localFs
    );
    const remoteHash = await hashFile(temporary);
    const changed = remoteHash !== session.record.remote.sha256;
    if (changed || !session.record.remoteSnapshot) {
      await replaceSnapshot(temporary, permanent);
      session.record.remoteSnapshot = permanent;
    } else {
      await fs.promises.unlink(temporary);
    }
    session.record.remote = {
      mtime: remote.mtime,
      size: remote.size,
      sha256: remoteHash,
    };
    session.record.snapshotError = undefined;
    return changed ? remoteHash : null;
  } catch (error) {
    session.record.remoteSnapshot = null;
    session.record.snapshotError = cleanError(error);
    try {
      await fs.promises.unlink(temporary);
    } catch (_cleanupError) {
      // Nothing else to clean up.
    }
    return 'snapshot-error';
  }
}

export async function revalidateConflict(
  session: ConflictSession,
  context: FileTransferContext
): Promise<{ valid: boolean; revision: number }> {
  const localStat = await fs.promises.stat(context.srcFsPath);
  const localHash = await hashFileOrNull(context.srcFsPath);
  const localChanged = localHash !== session.record.local.sha256;
  let remoteChanged = false;
  let remoteMissing = false;
  let remote: FileStats | undefined;

  try {
    remote = await context.targetFs.lstat(context.targetFsPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      remoteMissing = true;
    } else {
      throw error;
    }
  }

  if (remoteMissing) {
    session.record.remoteMissingAt = now();
    session.record.local = {
      mtime: localStat.mtimeMs,
      size: localStat.size,
      sha256: localHash,
    };
    await writeIndexRecord(session.root, session.record);
    return { valid: true, revision: session.record.revision };
  }

  if (remote) {
    const metadataChanged = !metadataMatches(remote, session.record.remote);
    if (metadataChanged || remote.mtime <= 0) {
      remoteChanged = (await refreshRemoteSnapshot(session, context, remote)) !== null;
    }
  }

  if (localChanged || remoteChanged) {
    session.record.revision += 1;
    session.record.local = {
      mtime: localStat.mtimeMs,
      size: localStat.size,
      sha256: localHash,
    };
    session.record.decision = undefined;
    session.record.result = undefined;
    session.record.staleReason = [
      localChanged ? 'local-changed' : '',
      remoteChanged ? 'remote-changed' : '',
    ]
      .filter(Boolean)
      .join(',');
    await updateSession(session, 'pending');
    return { valid: false, revision: session.record.revision };
  }

  if (remote) {
    session.record.remote.mtime = remote.mtime;
    session.record.remote.size = remote.size;
  }
  session.record.local = {
    mtime: localStat.mtimeMs,
    size: localStat.size,
    sha256: localHash,
  };
  session.record.staleReason = undefined;
  await writeIndexRecord(session.root, session.record);
  return { valid: true, revision: session.record.revision };
}

function conflictDetail(reason: UploadConflictReason): string {
  switch (reason) {
    case 'remote-changed':
      return 'The remote modification time or byte size no longer matches the last observed version.';
    case 'baseline-missing':
      return 'This existing remote file differs from local metadata, but no previous remote baseline is stored yet.';
    case 'timestamp-unavailable':
      return 'The FTP server did not provide an exact remote modification time, so a safe comparison is not possible.';
  }
}

function showQuickPickOnce(
  session: ConflictSession,
  context: FileTransferContext
): Promise<ConflictDecisionAction | 'open_diff' | undefined> {
  return new Promise(resolve => {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = `SFTP Neo blocked upload of ${path.basename(context.srcFsPath)}`;
    quickPick.placeholder = conflictDetail(session.record.reason);
    quickPick.ignoreFocusOut = true;
    quickPick.items = [
      { label: 'Open Diff', description: 'Compare the captured remote file with local content' },
      { label: 'Overwrite', description: 'Upload this file' },
      { label: 'Overwrite All', description: 'Upload every remaining conflict in this batch' },
      { label: 'Cancel upload', description: 'Keep the remote file unchanged' },
    ];
    activeQuickPicks.set(session.record.id, quickPick);
    let finished = false;
    const finish = (value: ConflictDecisionAction | 'open_diff' | undefined) => {
      if (finished) {
        return;
      }
      finished = true;
      activeQuickPicks.delete(session.record.id);
      accepted.dispose();
      hidden.dispose();
      quickPick.dispose();
      resolve(value);
    };
    const accepted = quickPick.onDidAccept(() => {
      const label = quickPick.selectedItems[0]?.label;
      if (label === 'Open Diff') {
        finish('open_diff');
      } else if (label === 'Overwrite') {
        finish('overwrite');
      } else if (label === 'Overwrite All') {
        finish('overwrite_all');
      } else if (label === 'Cancel upload') {
        finish('cancel');
      }
    });
    const hidden = quickPick.onDidHide(() => {
      finish(resolvedSessions.has(session.record.id) ? undefined : 'cancel');
    });
    quickPick.show();
  });
}

async function showManualUi(
  session: ConflictSession,
  context: FileTransferContext
): Promise<ConflictDecisionAction | undefined> {
  while (!resolvedSessions.has(session.record.id)) {
    const choice = await showQuickPickOnce(session, context);
    if (!choice) {
      return undefined;
    }
    if (choice === 'open_diff') {
      await openNativeDiff(session, context).catch(() => undefined);
      continue;
    }
    return choice;
  }
  return undefined;
}

function enqueueManualUi(
  session: ConflictSession,
  context: FileTransferContext
): Promise<ConflictDecisionAction | undefined> {
  let result: ConflictDecisionAction | undefined;
  const operation = manualUiQueue.then(async () => {
    result = await showManualUi(session, context);
  });
  manualUiQueue = operation.then(() => undefined, () => undefined);
  return operation.then(() => result);
}

async function pendingRequests(session: ConflictSession): Promise<RequestEnvelope[]> {
  const requestsDirectory = path.join(path.dirname(session.record.reportFile), 'requests');
  const responsesDirectory = path.join(path.dirname(session.record.reportFile), 'responses');
  let entries: string[];
  try {
    entries = (await fs.promises.readdir(requestsDirectory))
      .filter(entry => entry.endsWith('.json'))
      .sort();
  } catch (_error) {
    return [];
  }

  const pending: RequestEnvelope[] = [];
  for (const entry of entries) {
    const requestFile = path.join(requestsDirectory, entry);
    const requestId = path.basename(entry, '.json');
    const responseFile = path.join(responsesDirectory, `${requestId}.json`);
    if (fs.existsSync(responseFile)) {
      continue;
    }
    const request = await readJson<BridgeRequest>(requestFile);
    if (request) {
      pending.push({ request, requestId, responseFile });
    }
  }
  return pending;
}

async function respond(
  envelope: RequestEnvelope,
  session: ConflictSession,
  result: Record<string, unknown>
): Promise<void> {
  await atomicWriteJson(envelope.responseFile, {
    version: CONFLICT_PROTOCOL_VERSION,
    requestId: envelope.requestId,
    conflictId: session.record.id,
    revision: session.record.revision,
    status: session.record.status,
    respondedAt: now(),
    ...result,
  });
}

async function acceptDecision(
  session: ConflictSession,
  context: FileTransferContext,
  action: ConflictDecisionAction,
  source: ConflictDecisionSource,
  expectedRevision: number,
  requestId?: string
): Promise<{ accepted: boolean; stale: boolean }> {
  if (expectedRevision !== session.record.revision) {
    return { accepted: false, stale: true };
  }

  if (action !== 'cancel') {
    const validation = await revalidateConflict(session, context);
    if (!validation.valid) {
      return { accepted: false, stale: true };
    }
  }

  const acceptedAt = now();
  const decision: ConflictDecision = {
    requestId,
    action,
    source,
    requestedAt: acceptedAt,
    acceptedAt,
  };
  if (action === 'cancel') {
    await updateSession(session, 'cancelled', {
      decision,
      result: { cancelledAt: acceptedAt },
    });
  } else {
    await updateSession(session, 'resolving', { decision });
  }
  return { accepted: true, stale: false };
}

function closeManualUi(session: ConflictSession): void {
  resolvedSessions.add(session.record.id);
  activeQuickPicks.get(session.record.id)?.hide();
}

export async function waitForConflictDecision(
  session: ConflictSession,
  context: FileTransferContext
): Promise<ConflictDecisionAction> {
  let manualDecision: ConflictDecisionAction | undefined;
  void enqueueManualUi(session, context).then(choice => {
    manualDecision = choice;
  });

  for (;;) {
    if (manualDecision) {
      const decision = manualDecision;
      manualDecision = undefined;
      const accepted = await acceptDecision(
        session,
        context,
        decision,
        'cursor',
        session.record.revision
      );
      if (accepted.accepted) {
        closeManualUi(session);
        const superseded = await pendingRequests(session);
        await Promise.all(
          superseded.map(envelope =>
            respond(envelope, session, {
              accepted: false,
              error: 'already_resolved',
              decision: session.record.decision,
            })
          )
        );
        return decision;
      }
    }

    const requests = await pendingRequests(session);
    for (const envelope of requests) {
      const request = envelope.request;
      if (request.version !== CONFLICT_PROTOCOL_VERSION) {
        await respond(envelope, session, { accepted: false, error: 'unsupported_protocol' });
        continue;
      }
      if (request.expectedRevision !== session.record.revision) {
        await respond(envelope, session, { accepted: false, stale: true });
        continue;
      }
      if (request.kind === 'open_diff') {
        try {
          await openNativeDiff(session, context);
          await respond(envelope, session, { accepted: true, opened: true });
        } catch (error) {
          await respond(envelope, session, {
            accepted: false,
            error: cleanError(error),
          });
        }
        continue;
      }
      if (
        request.kind !== 'resolve' ||
        !request.action ||
        !['overwrite', 'overwrite_all', 'cancel'].includes(request.action)
      ) {
        await respond(envelope, session, { accepted: false, error: 'invalid_request' });
        continue;
      }

      const accepted = await acceptDecision(
        session,
        context,
        request.action,
        'mcp',
        request.expectedRevision,
        envelope.requestId
      );
      if (!accepted.accepted) {
        await respond(envelope, session, { accepted: false, stale: accepted.stale });
        continue;
      }

      closeManualUi(session);
      await respond(envelope, session, { accepted: true, action: request.action });
      return request.action;
    }

    await delay(REQUEST_POLL_MS);
  }
}

export async function acceptBatchOverwrite(
  session: ConflictSession,
  context: FileTransferContext
): Promise<boolean> {
  const validation = await revalidateConflict(session, context);
  if (!validation.valid) {
    return false;
  }
  const acceptedAt = now();
  await updateSession(session, 'resolving', {
    decision: {
      action: 'overwrite_all',
      source: 'batch',
      requestedAt: acceptedAt,
      acceptedAt,
    },
  });
  return true;
}

export async function markConflictUploading(session: ConflictSession): Promise<ConflictReportRef> {
  await updateSession(session, 'uploading');
  return { root: session.root, id: session.record.id };
}

async function updateConflictByReference(
  reference: ConflictReportRef,
  status: ConflictStatus,
  changes: Partial<ConflictRecord>
): Promise<void> {
  const index = await readJson<{ conflicts?: ConflictRecord[] }>(
    path.join(reference.root, 'index.json')
  );
  const record = index?.conflicts?.find(item => item.id === reference.id);
  if (!record) {
    return;
  }
  const session = { root: reference.root, record };
  await updateSession(session, status, changes);
}

export async function markConflictUploaded(reference: ConflictReportRef): Promise<void> {
  const uploadedAt = now();
  await updateConflictByReference(reference, 'uploaded', {
    result: { uploadedAt },
  });
}

export async function markConflictFailed(
  reference: ConflictReportRef,
  error: unknown
): Promise<void> {
  const failedAt = now();
  await updateConflictByReference(reference, 'failed', {
    result: { failedAt, error: cleanError(error) },
  });
}
