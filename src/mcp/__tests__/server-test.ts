import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { workspaceBucketId } from '../../fileHandlers/transfer/conflictStateStore';
import { createConflictMcpServer } from '../server';
import {
  MAX_DIFF_BYTES_PER_SIDE,
  MAX_READ_BYTES,
  type McpLaunchConfiguration,
} from '../conflictContract';

const root = path.join(process.cwd(), '.jest-conflict-data', 'mcp-contract');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture() {
  const workspace = path.join(root, randomUUID(), 'workspace');
  const stateRoot = path.join(root, randomUUID(), 'conflict-state-v2');
  const bucket = workspaceBucketId(workspace);
  const conflictId = `${new Date().toISOString().replace(/[:.]/g, '-')}-contract.txt`;
  const directory = path.join(stateRoot, 'workspaces', bucket, conflictId);
  const localFile = path.join(workspace, 'site', 'index.txt');
  const remoteSnapshot = path.join(directory, 'remote.txt');
  const reportFile = path.join(directory, 'conflict.json');
  await fs.promises.mkdir(path.dirname(localFile), { recursive: true });
  await fs.promises.mkdir(path.join(directory, 'requests'), { recursive: true });
  await fs.promises.mkdir(path.join(directory, 'responses'), { recursive: true });
  await fs.promises.writeFile(localFile, 'local line\n');
  await fs.promises.writeFile(remoteSnapshot, 'remote line\n');
  await fs.promises.writeFile(
    reportFile,
    JSON.stringify({
      version: 2,
      id: conflictId,
      revision: 1,
      status: 'pending',
      reason: 'remote-changed',
      detectedAt: '2026-09-23T12:00:00.000Z',
      updatedAt: '2026-09-23T12:00:00.000Z',
      sessionId: 'test',
      workspaceRoot: workspace,
      batchId: 'batch',
      localFile,
      remoteFile: '/site/index.txt',
      reportFile,
      remoteSnapshot,
      localSnapshot: null,
      local: {
        mtime: 1,
        size: 11,
        sha256: sha256('local line\n'),
      },
      remote: {
        mtime: 2,
        size: 12,
        sha256: sha256('remote line\n'),
      },
      baseline: null,
    })
  );
  const config: McpLaunchConfiguration = {
    version: 1,
    extensionVersion: '0.1.0-test',
    stateRoot,
    capability: `${randomUUID()}${randomUUID()}`,
    workspaces: [{ bucket, root: workspace, name: 'Fixture' }],
  };
  const server = createConflictMcpServer(config, 'Inspect, prepare, resolve, and wait.');
  const client = new Client({ name: 'fake-agent', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    clientTransport,
    serverTransport,
    config,
    conflictId,
    workspace,
    stateRoot,
    localFile,
    remoteSnapshot,
    reportFile,
    directory,
  };
}

async function createDirectoryLink(target: string, link: string): Promise<void> {
  await fs.promises.mkdir(target, { recursive: true });
  await fs.promises.rm(link, { recursive: true, force: true });
  await fs.promises.symlink(
    target,
    link,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
}

function structured(result: any): any {
  if (!('structuredContent' in result)) {
    throw new Error('Expected a normal MCP tool result.');
  }
  return result.structuredContent;
}

describe('conflict MCP server contract', () => {
  test('publishes English instructions and the canonical bounded tool set', async () => {
    const data = await fixture();
    try {
      expect(data.client.getInstructions()).toContain('Inspect, prepare, resolve, and wait.');
      const listed = await data.client.listTools();
      expect(listed.tools.map(tool => tool.name)).toEqual([
        'conflicts_list',
        'conflicts_get',
        'conflicts_read',
        'conflicts_diff',
        'conflicts_submit_local',
        'conflicts_acknowledge_local',
        'conflicts_resolve',
        'conflicts_wait',
      ]);
      expect(listed.tools.every(tool => tool.inputSchema.type === 'object')).toBe(true);
    } finally {
      await data.clientTransport.close();
      await data.serverTransport.close();
    }
  });

  test('lists, gets, reads, and diffs without leaking absolute state paths', async () => {
    const data = await fixture();
    try {
      const list = structured(
        await data.client.callTool({ name: 'conflicts_list', arguments: {} })
      );
      expect(list.ok).toBe(true);
      expect(list.conflicts).toHaveLength(1);
      expect(list.conflicts[0]).toMatchObject({
        conflictId: data.conflictId,
        workspaceName: 'Fixture',
        path: 'site/index.txt',
        status: 'pending',
      });

      const read = structured(
        await data.client.callTool({
          name: 'conflicts_read',
          arguments: {
            conflictId: data.conflictId,
            workspace: data.config.workspaces[0].bucket,
            side: 'remote',
            maxBytes: 64,
          },
        })
      );
      expect(read.content).toBe('remote line\n');
      expect(read.truncated).toBe(false);

      const diff = structured(
        await data.client.callTool({
          name: 'conflicts_diff',
          arguments: {
            conflictId: data.conflictId,
            workspace: data.config.workspaces[0].bucket,
          },
        })
      );
      expect(diff.diff).toContain('-remote line');
      expect(diff.diff).toContain('+local line');

      const serialized = JSON.stringify({ list, read, diff });
      expect(serialized).not.toContain(data.stateRoot);
      expect(serialized).not.toContain(data.workspace.replace(/\\/g, '\\\\'));
    } finally {
      await data.clientTransport.close();
      await data.serverTransport.close();
    }
  });

  test('locates unique multi-root records while preserving disambiguation and path safety', async () => {
    const data = await fixture();
    try {
      const firstWorkspace = data.config.workspaces[0];
      const secondWorkspace = path.join(root, randomUUID(), 'workspace');
      const secondBucket = workspaceBucketId(secondWorkspace);
      const secondDirectory = path.join(
        data.stateRoot,
        'workspaces',
        secondBucket,
        data.conflictId
      );
      const secondLocalFile = path.join(secondWorkspace, 'site', 'index.txt');
      const secondRemoteSnapshot = path.join(secondDirectory, 'remote.txt');
      const secondReportFile = path.join(secondDirectory, 'conflict.json');
      const originalRecord = JSON.parse(
        await fs.promises.readFile(data.reportFile, 'utf8')
      );
      const writeSecondRecord = async () => {
        await fs.promises.mkdir(path.dirname(secondLocalFile), { recursive: true });
        await fs.promises.mkdir(path.join(secondDirectory, 'requests'), {
          recursive: true,
        });
        await fs.promises.mkdir(path.join(secondDirectory, 'responses'), {
          recursive: true,
        });
        await fs.promises.writeFile(secondLocalFile, 'second local line\n');
        await fs.promises.writeFile(secondRemoteSnapshot, 'second remote line\n');
        await fs.promises.writeFile(
          secondReportFile,
          JSON.stringify({
            ...originalRecord,
            workspaceRoot: secondWorkspace,
            localFile: secondLocalFile,
            reportFile: secondReportFile,
            remoteSnapshot: secondRemoteSnapshot,
          })
        );
      };
      data.config.workspaces.push({
        bucket: secondBucket,
        root: secondWorkspace,
        name: 'Second Fixture',
      });
      await writeSecondRecord();
      await fs.promises.rm(data.directory, { recursive: true });

      const unique = structured(
        await data.client.callTool({
          name: 'conflicts_get',
          arguments: { conflictId: data.conflictId },
        })
      );
      expect(unique).toMatchObject({
        ok: true,
        conflictId: data.conflictId,
        workspace: secondBucket,
        workspaceName: 'Second Fixture',
      });

      const unknown = structured(
        await data.client.callTool({
          name: 'conflicts_get',
          arguments: { conflictId: `${data.conflictId}-unknown` },
        })
      );
      expect(unknown.error.code).toBe('not_found');

      await fs.promises.mkdir(path.join(data.directory, 'requests'), {
        recursive: true,
      });
      await fs.promises.mkdir(path.join(data.directory, 'responses'), {
        recursive: true,
      });
      await fs.promises.writeFile(data.localFile, 'local line\n');
      await fs.promises.writeFile(data.remoteSnapshot, 'remote line\n');
      await fs.promises.writeFile(data.reportFile, JSON.stringify(originalRecord));

      const duplicate = structured(
        await data.client.callTool({
          name: 'conflicts_get',
          arguments: { conflictId: data.conflictId },
        })
      );
      expect(duplicate.error.code).toBe('workspace_required');

      const explicit = structured(
        await data.client.callTool({
          name: 'conflicts_get',
          arguments: {
            conflictId: data.conflictId,
            workspace: secondBucket,
          },
        })
      );
      expect(explicit).toMatchObject({
        ok: true,
        workspace: secondBucket,
        workspaceName: 'Second Fixture',
      });

      await fs.promises.rm(data.directory, { recursive: true });
      const outside = path.join(root, randomUUID(), 'outside-report');
      await fs.promises.mkdir(outside, { recursive: true });
      await fs.promises.writeFile(
        path.join(outside, 'conflict.json'),
        JSON.stringify(originalRecord)
      );
      await createDirectoryLink(outside, data.directory);

      const unsafe = structured(
        await data.client.callTool({
          name: 'conflicts_get',
          arguments: { conflictId: data.conflictId },
        })
      );
      expect(unsafe.error.code).toBe('invalid_record');
      expect(JSON.stringify(unsafe)).not.toContain(outside);
      expect(firstWorkspace.bucket).not.toBe(secondBucket);
    } finally {
      await data.clientTransport.close();
      await data.serverTransport.close();
    }
  });

  test('reads UTF-8 safely across byte boundaries and preserves sequential offsets', async () => {
    const data = await fixture();
    try {
      const text = `${'a'.repeat(MAX_READ_BYTES - 1)}€\n`;
      await fs.promises.writeFile(data.remoteSnapshot, text);
      const first = structured(
        await data.client.callTool({
          name: 'conflicts_read',
          arguments: {
            conflictId: data.conflictId,
            side: 'remote',
          },
        })
      );
      expect(first).toMatchObject({
        offset: 0,
        bytesRead: MAX_READ_BYTES - 1,
        nextOffset: MAX_READ_BYTES - 1,
        truncated: true,
      });
      const second = structured(
        await data.client.callTool({
          name: 'conflicts_read',
          arguments: {
            conflictId: data.conflictId,
            side: 'remote',
            offset: first.nextOffset,
          },
        })
      );
      expect(first.content + second.content).toBe(text);
      expect(second).toMatchObject({
        offset: MAX_READ_BYTES - 1,
        content: '€\n',
        nextOffset: null,
        truncated: false,
      });

      const insideCodePoint = structured(
        await data.client.callTool({
          name: 'conflicts_read',
          arguments: {
            conflictId: data.conflictId,
            side: 'remote',
            offset: MAX_READ_BYTES,
            maxBytes: 4,
          },
        })
      );
      expect(insideCodePoint).toMatchObject({
        requestedOffset: MAX_READ_BYTES,
        offset: MAX_READ_BYTES - 1,
        bytesRead: 4,
        content: '€\n',
      });
    } finally {
      await data.clientTransport.close();
      await data.serverTransport.close();
    }
  });

  test('diff truncation does not classify a split UTF-8 character as binary', async () => {
    const data = await fixture();
    try {
      const prefix = `${'a\n'.repeat(
        Math.floor((MAX_DIFF_BYTES_PER_SIDE - 1) / 2)
      )}a`;
      const text = `${prefix}€\n`;
      await Promise.all([
        fs.promises.writeFile(data.remoteSnapshot, text),
        fs.promises.writeFile(data.localFile, text),
      ]);
      const result = await data.client.callTool({
        name: 'conflicts_diff',
        arguments: {
          conflictId: data.conflictId,
        },
      });
      expect('isError' in result && result.isError).toBe(false);
      expect(structured(result)).toMatchObject({
        ok: true,
        truncated: true,
      });
    } finally {
      await data.clientTransport.close();
      await data.serverTransport.close();
    }
  });

  test('rejects traversal, binary snapshots, and stale waits with explicit results', async () => {
    const data = await fixture();
    try {
      await fs.promises.writeFile(data.remoteSnapshot, Buffer.from([0, 1, 2, 3]));
      const binary = await data.client.callTool({
        name: 'conflicts_read',
        arguments: {
          conflictId: data.conflictId,
          side: 'remote',
        },
      });
      expect('isError' in binary && binary.isError).toBe(true);
      expect(structured(binary).error.code).toBe('binary_content');

      await fs.promises.writeFile(data.remoteSnapshot, Buffer.from([0xc3, 0x28]));
      const invalidUtf8 = await data.client.callTool({
        name: 'conflicts_read',
        arguments: {
          conflictId: data.conflictId,
          side: 'remote',
        },
      });
      expect('isError' in invalidUtf8 && invalidUtf8.isError).toBe(true);
      expect(structured(invalidUtf8).error.code).toBe('binary_content');

      const traversal = await data.client.callTool({
        name: 'conflicts_get',
        arguments: { conflictId: '../outside' },
      });
      expect('isError' in traversal && traversal.isError).toBe(true);
      expect(JSON.stringify(traversal)).toContain('path separators');

      const report = path.join(
        data.stateRoot,
        'workspaces',
        data.config.workspaces[0].bucket,
        data.conflictId,
        'conflict.json'
      );
      const record = JSON.parse(await fs.promises.readFile(report, 'utf8'));
      record.revision = 2;
      await fs.promises.writeFile(report, JSON.stringify(record));
      const wait = structured(
        await data.client.callTool({
          name: 'conflicts_wait',
          arguments: {
            conflictId: data.conflictId,
            expectedRevision: 1,
            timeoutSeconds: 1,
          },
        })
      );
      expect(wait).toMatchObject({ ok: true, stale: true, revision: 2 });
    } finally {
      await data.clientTransport.close();
      await data.serverTransport.close();
    }
  });

  test('rejects ancestor directory links for workspace files and snapshots', async () => {
    const localData = await fixture();
    try {
      const outside = path.join(root, randomUUID(), 'outside-local');
      await fs.promises.mkdir(outside, { recursive: true });
      await fs.promises.writeFile(path.join(outside, 'index.txt'), 'outside-workspace-secret');
      await createDirectoryLink(outside, path.dirname(localData.localFile));

      for (const request of [
        { name: 'conflicts_get', arguments: { conflictId: localData.conflictId } },
        {
          name: 'conflicts_read',
          arguments: { conflictId: localData.conflictId, side: 'local' },
        },
        { name: 'conflicts_diff', arguments: { conflictId: localData.conflictId } },
      ]) {
        const result = await localData.client.callTool(request);
        expect(result.isError).toBe(true);
        expect(['invalid_record', 'unsupported_file']).toContain(
          structured(result).error.code
        );
        expect(JSON.stringify(result)).not.toContain('outside-workspace-secret');
        expect(JSON.stringify(result)).not.toContain(outside);
      }
    } finally {
      await localData.clientTransport.close();
      await localData.serverTransport.close();
    }

    const snapshotData = await fixture();
    try {
      const outside = path.join(root, randomUUID(), 'outside-snapshot');
      const linked = path.join(snapshotData.directory, 'linked');
      await fs.promises.mkdir(outside, { recursive: true });
      await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'outside-snapshot-secret');
      await createDirectoryLink(outside, linked);
      const record = JSON.parse(
        await fs.promises.readFile(snapshotData.reportFile, 'utf8')
      );
      record.remoteSnapshot = path.join(linked, 'secret.txt');
      await fs.promises.writeFile(snapshotData.reportFile, JSON.stringify(record));

      for (const request of [
        { name: 'conflicts_get', arguments: { conflictId: snapshotData.conflictId } },
        {
          name: 'conflicts_read',
          arguments: { conflictId: snapshotData.conflictId, side: 'remote' },
        },
        { name: 'conflicts_diff', arguments: { conflictId: snapshotData.conflictId } },
      ]) {
        const result = await snapshotData.client.callTool(request);
        expect(result.isError).toBe(true);
        expect(['invalid_record', 'unsupported_file']).toContain(
          structured(result).error.code
        );
        expect(JSON.stringify(result)).not.toContain('outside-snapshot-secret');
        expect(JSON.stringify(result)).not.toContain(outside);
      }
    } finally {
      await snapshotData.clientTransport.close();
      await snapshotData.serverTransport.close();
    }
  });

  test('rejects unavailable snapshots, wrong workspaces, oversized input, and terminal mutation', async () => {
    const data = await fixture();
    try {
      const wrongWorkspace = await data.client.callTool({
        name: 'conflicts_get',
        arguments: {
          conflictId: data.conflictId,
          workspace: 'b'.repeat(64),
        },
      });
      expect(structured(wrongWorkspace).error.code).toBe('wrong_workspace');

      const oversized = await data.client.callTool({
        name: 'conflicts_submit_local',
        arguments: {
          conflictId: data.conflictId,
          expectedRevision: 1,
          expectedLocalSha256: sha256('local line\n'),
          content: 'x'.repeat(2 * 1024 * 1024 + 1),
        },
      });
      expect('isError' in oversized && oversized.isError).toBe(true);

      const report = path.join(
        data.stateRoot,
        'workspaces',
        data.config.workspaces[0].bucket,
        data.conflictId,
        'conflict.json'
      );
      const record = JSON.parse(await fs.promises.readFile(report, 'utf8'));
      record.remoteSnapshot = null;
      record.snapshotError = `Unavailable under ${data.stateRoot}`;
      await fs.promises.writeFile(report, JSON.stringify(record));
      const unavailable = await data.client.callTool({
        name: 'conflicts_diff',
        arguments: { conflictId: data.conflictId },
      });
      expect(structured(unavailable).error.code).toBe('snapshot_unavailable');
      expect(JSON.stringify(unavailable)).not.toContain(data.stateRoot);

      record.status = 'orphaned';
      record.updatedAt = '2026-09-23T12:01:00.000Z';
      await fs.promises.writeFile(report, JSON.stringify(record));
      const terminal = await data.client.callTool({
        name: 'conflicts_resolve',
        arguments: {
          conflictId: data.conflictId,
          expectedRevision: 1,
          action: 'cancel',
        },
      });
      expect(structured(terminal).error.code).toBe('terminal_conflict');
      expect(
        await fs.promises.readdir(
          path.join(path.dirname(report), 'requests')
        )
      ).toHaveLength(0);
    } finally {
      await data.clientTransport.close();
      await data.serverTransport.close();
    }
  });
});
