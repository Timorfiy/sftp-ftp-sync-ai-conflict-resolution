const mockQuickPicks: any[] = [];

jest.mock('vscode', () => ({
  Uri: {
    file: jest.fn(fsPath => ({ fsPath })),
  },
  commands: {
    executeCommand: jest.fn(async () => undefined),
  },
  window: {
    createQuickPick: jest.fn(() => {
      let acceptHandler = () => undefined;
      let hideHandler = () => undefined;
      const quickPick: any = {
        items: [],
        selectedItems: [],
        show: jest.fn(),
        hide: jest.fn(() => hideHandler()),
        dispose: jest.fn(),
        onDidAccept: jest.fn(handler => {
          acceptHandler = handler;
          return { dispose: jest.fn() };
        }),
        onDidHide: jest.fn(handler => {
          hideHandler = handler;
          return { dispose: jest.fn() };
        }),
        accept(label: string) {
          quickPick.selectedItems = [{ label }];
          acceptHandler();
        },
      };
      mockQuickPicks.push(quickPick);
      return quickPick;
    }),
  },
}));

jest.mock('child_process', () => ({
  spawn: jest.fn(() => ({
    on: jest.fn(),
    unref: jest.fn(),
  })),
}));

jest.mock('../../../core/fileBaseOperations', () => ({
  transferFile: jest.fn(),
}));

jest.mock('../../diff', () => ({
  diff: jest.fn(async () => undefined),
}));

jest.mock('../../../logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as fileOperations from '../../../core/fileBaseOperations';
import { FileType } from '../../../core/fs/fileSystem';
import { TransferDirection } from '../../../core/transferTask';
import {
  acceptBatchOverwrite,
  atomicWriteJson,
  captureConflict,
  disposeConflictBridge,
  initializeConflictBridge,
  markConflictFailed,
  markConflictUploaded,
  markConflictUploading,
  waitForConflictDecision,
} from '../conflictBridge';

const testRoot = path.join(process.cwd(), '.jest-conflict-data');

function delay(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fixture() {
  const workspace = path.join(testRoot, randomUUID());
  const localFile = path.join(workspace, 'local.txt');
  const remoteFile = path.join(workspace, 'fake-remote.txt');
  await fs.promises.mkdir(workspace, { recursive: true });
  await fs.promises.writeFile(localFile, 'local content\n');
  await fs.promises.writeFile(remoteFile, 'remote content\n');
  await initializeConflictBridge([workspace], '3.5.0-test');
  const remoteStat = await fs.promises.stat(remoteFile);
  const targetFs = {
    lstat: jest.fn(async () => ({
      type: FileType.File,
      mode: 0o644,
      size: (await fs.promises.stat(remoteFile)).size,
      mtime: (await fs.promises.stat(remoteFile)).mtimeMs,
      atime: remoteStat.atimeMs,
    })),
  } as any;
  const context: any = {
    srcFsPath: localFile,
    targetFsPath: remoteFile,
    srcFs: {} as any,
    targetFs,
    fileType: FileType.File,
    transferDirection: TransferDirection.LOCAL_TO_REMOTE,
    sourceMtime: (await fs.promises.stat(localFile)).mtimeMs,
    sourceSize: (await fs.promises.stat(localFile)).size,
  };
  const remote = await targetFs.lstat(remoteFile);
  return { workspace, localFile, remoteFile, context, remote };
}

describe('Kent conflict bridge coordinator', () => {
  beforeEach(() => {
    mockQuickPicks.length = 0;
    jest.clearAllMocks();
    (fileOperations.transferFile as jest.Mock).mockImplementation(
      async (source: string, destination: string) => {
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        await fs.promises.copyFile(source, destination);
      }
    );
  });

  afterEach(async () => {
    await disposeConflictBridge();
  });

  test('MCP decision resumes the live promise, closes QuickPick, and records upload callback', async () => {
    const data = await fixture();
    const session = await captureConflict(
      data.workspace,
      'batch-one',
      data.context,
      'remote-changed',
      data.remote
    );
    const decisionPromise = waitForConflictDecision(session, data.context);
    await delay(20);
    const requestId = `request-${randomUUID()}`;
    const requests = path.join(path.dirname(session.record.reportFile), 'requests');
    await atomicWriteJson(path.join(requests, `${requestId}.json`), {
      version: 2,
      requestId,
      kind: 'resolve',
      expectedRevision: 1,
      action: 'overwrite',
      source: 'mcp',
      createdAt: new Date().toISOString(),
    });

    await expect(decisionPromise).resolves.toBe('overwrite');
    expect(mockQuickPicks[0].hide).toHaveBeenCalledTimes(1);
    const response = JSON.parse(
      await fs.promises.readFile(
        path.join(path.dirname(session.record.reportFile), 'responses', `${requestId}.json`),
        'utf8'
      )
    );
    expect(response.accepted).toBe(true);

    const reference = await markConflictUploading(session);
    let record = JSON.parse(await fs.promises.readFile(session.record.reportFile, 'utf8'));
    expect(record.status).toBe('uploading');
    await markConflictUploaded(reference);
    record = JSON.parse(await fs.promises.readFile(session.record.reportFile, 'utf8'));
    expect(record.status).toBe('uploaded');
    expect(record.result.uploadedAt).toBeTruthy();
  });

  test('transfer error callback records failed and never uploaded', async () => {
    const data = await fixture();
    const session = await captureConflict(
      data.workspace,
      'batch-failed',
      data.context,
      'remote-changed',
      data.remote
    );
    const reference = await markConflictUploading(session);
    await markConflictFailed(reference, new Error('fake upload error'));
    const record = JSON.parse(await fs.promises.readFile(session.record.reportFile, 'utf8'));
    expect(record.status).toBe('failed');
    expect(record.result.error).toBe('fake upload error');
    expect(record.result.uploadedAt).toBeUndefined();
  });

  test('local change makes an overwrite-all decision stale and increments revision', async () => {
    const data = await fixture();
    const session = await captureConflict(
      data.workspace,
      'batch-stale',
      data.context,
      'remote-changed',
      data.remote
    );
    await fs.promises.writeFile(data.localFile, 'changed while reviewing\n');

    await expect(acceptBatchOverwrite(session, data.context)).resolves.toBe(false);
    expect(session.record.status).toBe('pending');
    expect(session.record.revision).toBe(2);
    expect(session.record.staleReason).toContain('local-changed');
  });

  test('unknown remote timestamp is re-downloaded and hash change rejects stale decision', async () => {
    const data = await fixture();
    data.remote.mtime = 0;
    data.context.targetFs.lstat = jest.fn(async () => ({
      ...data.remote,
      size: (await fs.promises.stat(data.remoteFile)).size,
      mtime: 0,
    }));
    const session = await captureConflict(
      data.workspace,
      'batch-unknown-time',
      data.context,
      'timestamp-unavailable',
      data.remote
    );
    await fs.promises.writeFile(data.remoteFile, 'remote changed during review\n');

    await expect(acceptBatchOverwrite(session, data.context)).resolves.toBe(false);
    expect(session.record.revision).toBe(2);
    expect(session.record.remote.sha256).toBeTruthy();
    expect(session.record.staleReason).toContain('remote-changed');
  });

  test('snapshot failures remain pending with a reportable error', async () => {
    const data = await fixture();
    (fileOperations.transferFile as jest.Mock).mockRejectedValueOnce(
      new Error('snapshot unavailable')
    );
    const session = await captureConflict(
      data.workspace,
      'batch-snapshot-error',
      data.context,
      'remote-changed',
      data.remote
    );
    expect(session.record.status).toBe('pending');
    expect(session.record.remoteSnapshot).toBeNull();
    expect(session.record.snapshotError).toBe('snapshot unavailable');
  });

  test('Cursor wins a race and an already queued MCP request receives already_resolved', async () => {
    const data = await fixture();
    const session = await captureConflict(
      data.workspace,
      'batch-race',
      data.context,
      'remote-changed',
      data.remote
    );
    const decisionPromise = waitForConflictDecision(session, data.context);
    await delay(20);
    const requestId = `request-${randomUUID()}`;
    const directory = path.dirname(session.record.reportFile);
    await atomicWriteJson(path.join(directory, 'requests', `${requestId}.json`), {
      version: 2,
      requestId,
      kind: 'resolve',
      expectedRevision: 1,
      action: 'cancel',
      source: 'mcp',
    });
    mockQuickPicks[0].accept('Overwrite');

    await expect(decisionPromise).resolves.toBe('overwrite');
    const response = JSON.parse(
      await fs.promises.readFile(
        path.join(directory, 'responses', `${requestId}.json`),
        'utf8'
      )
    );
    expect(response.accepted).toBe(false);
    expect(response.error).toBe('already_resolved');
    expect(session.record.decision?.source).toBe('cursor');
  });

  test('old extension-session conflicts become orphaned on initialization', async () => {
    const workspace = path.join(testRoot, randomUUID());
    const stateRoot = path.join(workspace, '.kent-tmp', 'sftp-conflicts');
    const id = 'old-session-conflict';
    const reportFile = path.join(stateRoot, id, 'conflict.json');
    const oldRecord = {
      version: 2,
      id,
      status: 'uploading',
      revision: 1,
      sessionId: 'old-session',
      reportFile,
    };
    await atomicWriteJson(reportFile, oldRecord);
    await atomicWriteJson(path.join(stateRoot, 'index.json'), {
      version: 2,
      conflicts: [oldRecord],
    });

    await initializeConflictBridge([workspace], '3.5.0-test');

    const record = JSON.parse(await fs.promises.readFile(reportFile, 'utf8'));
    expect(record.status).toBe('orphaned');
    expect(record.result.orphanedAt).toBeTruthy();
  });
});
