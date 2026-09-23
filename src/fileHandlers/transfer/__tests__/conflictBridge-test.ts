const mockQuickPicks: any[] = [];
const showErrorMessage = jest.fn(async () => undefined);

jest.mock('vscode', () => ({
  Uri: {
    file: jest.fn(fsPath => ({ fsPath })),
  },
  commands: {
    executeCommand: jest.fn(async () => undefined),
  },
  workspace: {
    textDocuments: [],
  },
  window: {
    showErrorMessage,
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
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as fileOperations from '../../../core/fileBaseOperations';
import { FileType } from '../../../core/fs/fileSystem';
import { TransferDirection } from '../../../core/transferTask';
import { RedactionScope } from '../../../security/redaction';
import {
  acceptBatchOverwrite,
  atomicWriteJson,
  captureConflict,
  disposeConflictBridge,
  getConflictMcpConfiguration,
  initializeConflictBridge,
  isConflictPathActive,
  markConflictFailed,
  markConflictUploaded,
  markConflictUploading,
  revalidateConflict,
  waitForConflictDecision,
} from '../conflictBridge';

const testRoot = path.join(process.cwd(), '.jest-conflict-data');

function delay(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForJson(file: string): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(file)) {
      return JSON.parse(await fs.promises.readFile(file, 'utf8'));
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${path.basename(file)}`);
}

async function sendRequest(
  session: any,
  capability: string,
  request: Record<string, unknown>
): Promise<any> {
  const requestId = randomUUID();
  const directory = path.dirname(session.record.reportFile);
  await atomicWriteJson(path.join(directory, 'requests', `${requestId}.json`), {
    version: 3,
    requestId,
    capability,
    createdAt: new Date().toISOString(),
    ...request,
  });
  return waitForJson(path.join(directory, 'responses', `${requestId}.json`));
}

async function fixture(localRelative = 'local.txt') {
  const workspace = path.join(testRoot, randomUUID());
  const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
  const localFile = path.join(workspace, localRelative);
  const remoteFile = path.join(workspace, 'fake-remote.txt');
  await fs.promises.mkdir(path.dirname(localFile), { recursive: true });
  await fs.promises.writeFile(localFile, 'local content\n');
  await fs.promises.writeFile(remoteFile, 'remote content\n');
  await initializeConflictBridge([workspace], '3.5.0-test', { globalStorageRoot });
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
  return { workspace, globalStorageRoot, localFile, remoteFile, context, remote };
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

  test('clean multi-root initialization writes no workspace or global state', async () => {
    const workspaces = [
      path.join(testRoot, randomUUID(), 'one'),
      path.join(testRoot, randomUUID(), 'two'),
    ];
    const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
    await Promise.all(workspaces.map(workspace => fs.promises.mkdir(workspace, { recursive: true })));

    await initializeConflictBridge(workspaces, '3.5.0-test', { globalStorageRoot });

    expect(fs.existsSync(globalStorageRoot)).toBe(false);
    for (const workspace of workspaces) {
      expect(
        fs.existsSync(path.join(workspace, '.kent-tmp', 'sftp-conflicts'))
      ).toBe(false);
    }
  });

  test('disposing the bridge cancels a waiting conflict without leaving its UI or polling alive', async () => {
    const data = await fixture();
    const beforeRemote = await fs.promises.readFile(data.remoteFile);
    const session = await captureConflict(
      data.workspace,
      'dispose-pending',
      data.context,
      'remote-changed',
      data.remote
    );
    const waiting = waitForConflictDecision(session, data.context);
    await delay(20);
    expect(mockQuickPicks).toHaveLength(1);

    await disposeConflictBridge();

    await expect(waiting).resolves.toBe('cancel');
    expect(mockQuickPicks[0].hide).toHaveBeenCalledTimes(1);
    expect(mockQuickPicks[0].dispose).toHaveBeenCalledTimes(1);
    expect(await fs.promises.readFile(data.remoteFile)).toEqual(beforeRemote);
    await expect(waitForConflictDecision(session, data.context)).resolves.toBe('cancel');
    expect(mockQuickPicks).toHaveLength(1);
  });

  test('stale upload callbacks cannot mutate records or path guards after reinitialization', async () => {
    const data = await fixture();
    const oldSession = await captureConflict(
      data.workspace,
      'old-generation',
      data.context,
      'remote-changed',
      data.remote
    );
    const oldReference = await markConflictUploading(oldSession);
    const oldReport = oldSession.record.reportFile;

    await initializeConflictBridge([data.workspace], '3.5.0-test', {
      globalStorageRoot: path.join(testRoot, randomUUID(), 'replacement-global'),
    });
    await expect(markConflictUploading(oldSession)).rejects.toThrow(
      'Conflict bridge session expired.'
    );
    const newSession = await captureConflict(
      data.workspace,
      'new-generation',
      data.context,
      'remote-changed',
      data.remote
    );
    expect(isConflictPathActive(data.localFile)).toBe(true);

    await expect(markConflictUploaded(oldReference)).resolves.toBeUndefined();
    await expect(
      markConflictFailed(oldReference, new Error('stale failure'))
    ).resolves.toBeUndefined();

    const oldRecord = JSON.parse(await fs.promises.readFile(oldReport, 'utf8'));
    expect(oldRecord.status).toBe('uploading');
    expect(oldRecord.result).toBeUndefined();
    expect(isConflictPathActive(data.localFile)).toBe(true);
    expect(newSession.record.status).toBe('pending');
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
    expect(isConflictPathActive(data.localFile)).toBe(true);
    const decisionPromise = waitForConflictDecision(session, data.context);
    await delay(20);
    const capability = getConflictMcpConfiguration(
      '3.5.0-test',
      new Map()
    ).capability;
    const requests = path.join(path.dirname(session.record.reportFile), 'requests');
    const responses = path.join(path.dirname(session.record.reportFile), 'responses');
    const acknowledgeId = randomUUID();
    await atomicWriteJson(path.join(requests, `${acknowledgeId}.json`), {
      version: 3,
      requestId: acknowledgeId,
      capability,
      kind: 'acknowledge_local',
      expectedRevision: 1,
      expectedLocalSha256: session.record.local.sha256,
      createdAt: new Date().toISOString(),
    });
    const acknowledge = await waitForJson(path.join(responses, `${acknowledgeId}.json`));
    expect(acknowledge.accepted).toBe(true);

    const requestId = randomUUID();
    await atomicWriteJson(path.join(requests, `${requestId}.json`), {
      version: 3,
      requestId,
      capability,
      kind: 'resolve',
      expectedRevision: acknowledge.revision,
      action: 'upload',
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

  test('MCP upload requires a candidate and submitted text is atomic, recoverable, and local-only', async () => {
    const data = await fixture(path.join('nested', 'local.txt'));
    const beforeRemote = await fs.promises.readFile(data.remoteFile);
    const beforeLocal = await fs.promises.readFile(data.localFile);
    const beforeMode = (await fs.promises.lstat(data.localFile)).mode & 0o777;
    const session = await captureConflict(
      data.workspace,
      'batch-submit',
      data.context,
      'remote-changed',
      data.remote
    );
    const capability = getConflictMcpConfiguration('3.5.0-test', new Map()).capability;
    const decisionPromise = waitForConflictDecision(session, data.context);
    await delay(20);

    const missingCandidate = await sendRequest(session, capability, {
      kind: 'resolve',
      expectedRevision: 1,
      action: 'upload',
    });
    expect(missingCandidate).toMatchObject({
      accepted: false,
      error: 'candidate_required',
      revision: 1,
    });

    const submitted = await sendRequest(session, capability, {
      kind: 'submit_local',
      expectedRevision: 1,
      expectedLocalSha256: session.record.local.sha256,
      content: 'agent merged content\n',
    });
    expect(submitted).toMatchObject({ accepted: true, revision: 2 });
    expect(await fs.promises.readFile(data.localFile, 'utf8')).toBe(
      'agent merged content\n'
    );
    expect((await fs.promises.lstat(data.localFile)).mode & 0o777).toBe(beforeMode);
    expect(await fs.promises.readFile(session.record.localSnapshot!)).toEqual(beforeLocal);
    expect(await fs.promises.readFile(data.remoteFile)).toEqual(beforeRemote);

    const resolved = await sendRequest(session, capability, {
      kind: 'resolve',
      expectedRevision: 2,
      action: 'upload',
    });
    expect(resolved.accepted).toBe(true);
    await expect(decisionPromise).resolves.toBe('overwrite');
    const reference = await markConflictUploading(session);
    await markConflictUploaded(reference);
    expect(isConflictPathActive(data.localFile)).toBe(false);
  });

  test('dirty buffers, bad capabilities, and recovery budget exhaustion reject submission', async () => {
    const data = await fixture();
    const session = await captureConflict(
      data.workspace,
      'batch-rejections',
      data.context,
      'remote-changed',
      data.remote
    );
    const capability = getConflictMcpConfiguration('3.5.0-test', new Map()).capability;
    const decisionPromise = waitForConflictDecision(session, data.context);
    await delay(20);

    const unauthorized = await sendRequest(session, `${capability}x`, {
      kind: 'submit_local',
      expectedRevision: 1,
      expectedLocalSha256: session.record.local.sha256,
      content: 'blocked',
    });
    expect(unauthorized).toMatchObject({ accepted: false, error: 'unauthorized' });

    (vscode.workspace.textDocuments as any[]).push({
      isClosed: false,
      isDirty: true,
      uri: { fsPath: data.localFile },
    });
    const dirty = await sendRequest(session, capability, {
      kind: 'submit_local',
      expectedRevision: 1,
      expectedLocalSha256: session.record.local.sha256,
      content: 'blocked',
    });
    expect(dirty).toMatchObject({ accepted: false, error: 'dirty_buffer' });
    (vscode.workspace.textDocuments as any[]).length = 0;

    const cancelled = await sendRequest(session, capability, {
      kind: 'resolve',
      expectedRevision: 1,
      action: 'cancel',
    });
    expect(cancelled.accepted).toBe(true);
    await expect(decisionPromise).resolves.toBe('cancel');

    await initializeConflictBridge([data.workspace], '3.5.0-test', {
      globalStorageRoot: path.join(testRoot, randomUUID(), 'tiny-global'),
      policy: { maxSnapshotBytes: 1, maxTotalBytes: 2 },
    });
    const limited = await captureConflict(
      data.workspace,
      'batch-budget',
      data.context,
      'remote-changed',
      data.remote
    );
    const limitedCapability = getConflictMcpConfiguration(
      '3.5.0-test',
      new Map()
    ).capability;
    const limitedDecision = waitForConflictDecision(limited, data.context);
    await delay(20);
    const budget = await sendRequest(limited, limitedCapability, {
      kind: 'submit_local',
      expectedRevision: 1,
      expectedLocalSha256: limited.record.local.sha256,
      content: 'blocked',
    });
    expect(budget).toMatchObject({ accepted: false, error: 'recovery_unavailable' });
    const limitedCancel = await sendRequest(limited, limitedCapability, {
      kind: 'resolve',
      expectedRevision: 1,
      action: 'cancel',
    });
    expect(limitedCancel.accepted).toBe(true);
    await expect(limitedDecision).resolves.toBe('cancel');
  });

  test('failed atomic replacement rolls the local file back and does not create a candidate', async () => {
    const data = await fixture();
    const original = await fs.promises.readFile(data.localFile);
    const session = await captureConflict(
      data.workspace,
      'batch-rollback',
      data.context,
      'remote-changed',
      data.remote
    );
    const capability = getConflictMcpConfiguration('3.5.0-test', new Map()).capability;
    const decisionPromise = waitForConflictDecision(session, data.context);
    await delay(20);
    const originalRename = fs.promises.rename.bind(fs.promises);
    const rename = jest.spyOn(fs.promises, 'rename').mockImplementation(
      async (source: fs.PathLike, destination: fs.PathLike) => {
      if (
        String(source).endsWith('.tmp') &&
        path.resolve(String(destination)) === path.resolve(data.localFile)
      ) {
        throw new Error('induced atomic replace failure');
      }
      return originalRename(source, destination);
      }
    );
    const response = await sendRequest(session, capability, {
      kind: 'submit_local',
      expectedRevision: 1,
      expectedLocalSha256: session.record.local.sha256,
      content: 'must roll back',
    });
    rename.mockRestore();
    expect(response.accepted).toBe(false);
    expect(await fs.promises.readFile(data.localFile)).toEqual(original);
    expect(session.record.candidate).toBeUndefined();
    const cancel = await sendRequest(session, capability, {
      kind: 'resolve',
      expectedRevision: 1,
      action: 'cancel',
    });
    expect(cancel.accepted).toBe(true);
    await expect(decisionPromise).resolves.toBe('cancel');
  });

  test('symbolic-link local files are rejected before an extension-mediated write', async () => {
    const data = await fixture();
    const session = await captureConflict(
      data.workspace,
      'batch-symlink',
      data.context,
      'remote-changed',
      data.remote
    );
    const capability = getConflictMcpConfiguration('3.5.0-test', new Map()).capability;
    const decisionPromise = waitForConflictDecision(session, data.context);
    await delay(20);
    const originalLstat = fs.promises.lstat.bind(fs.promises);
    const lstat = jest.spyOn(fs.promises, 'lstat').mockImplementation(async file => {
      const stat = await originalLstat(file);
      if (path.resolve(String(file)) !== path.resolve(data.localFile)) {
        return stat;
      }
      return {
        ...stat,
        isFile: () => false,
        isSymbolicLink: () => true,
      } as fs.Stats;
    });
    const response = await sendRequest(session, capability, {
      kind: 'submit_local',
      expectedRevision: 1,
      expectedLocalSha256: session.record.local.sha256,
      content: 'blocked',
    });
    lstat.mockRestore();
    expect(response).toMatchObject({ accepted: false, error: 'unsupported_file' });
    const cancel = await sendRequest(session, capability, {
      kind: 'resolve',
      expectedRevision: 1,
      action: 'cancel',
    });
    expect(cancel.accepted).toBe(true);
    await expect(decisionPromise).resolves.toBe('cancel');
  });

  test('ancestor directory links reject capture before state or remote changes', async () => {
    const data = await fixture();
    const outside = path.join(testRoot, randomUUID(), 'outside-capture');
    const linkedDirectory = path.join(data.workspace, 'linked');
    const linkedFile = path.join(linkedDirectory, 'secret.txt');
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'outside original\n');
    await createDirectoryLink(outside, linkedDirectory);
    const linkedStat = await fs.promises.stat(linkedFile);
    const context = {
      ...data.context,
      srcFsPath: linkedFile,
      sourceMtime: linkedStat.mtimeMs,
      sourceSize: linkedStat.size,
    };
    const beforeRemote = await fs.promises.readFile(data.remoteFile);

    await expect(
      captureConflict(
        data.workspace,
        'batch-ancestor-link-capture',
        context,
        'remote-changed',
        data.remote
      )
    ).rejects.toThrow('unsupported_file');
    expect(await fs.promises.readFile(linkedFile, 'utf8')).toBe('outside original\n');
    expect(await fs.promises.readFile(data.remoteFile)).toEqual(beforeRemote);
    expect(await fs.promises.readdir(outside)).toEqual(['secret.txt']);
  });

  test('ancestor directory links reject submit and acknowledge without outside writes', async () => {
    const data = await fixture(path.join('nested', 'local.txt'));
    const originalLocal = await fs.promises.readFile(data.localFile);
    const beforeRemote = await fs.promises.readFile(data.remoteFile);
    const session = await captureConflict(
      data.workspace,
      'batch-ancestor-link-mutation',
      data.context,
      'remote-changed',
      data.remote
    );
    const capability = getConflictMcpConfiguration('3.5.0-test', new Map()).capability;
    const decisionPromise = waitForConflictDecision(session, data.context);
    const outside = path.join(testRoot, randomUUID(), 'outside-mutation');
    await fs.promises.mkdir(outside, { recursive: true });
    await fs.promises.writeFile(path.join(outside, 'local.txt'), originalLocal);
    await createDirectoryLink(outside, path.dirname(data.localFile));
    await delay(20);

    const submitted = await sendRequest(session, capability, {
      kind: 'submit_local',
      expectedRevision: 1,
      expectedLocalSha256: session.record.local.sha256,
      content: 'must stay inside workspace\n',
    });
    expect(submitted).toMatchObject({ accepted: false, error: 'unsupported_file' });

    const acknowledged = await sendRequest(session, capability, {
      kind: 'acknowledge_local',
      expectedRevision: 1,
      expectedLocalSha256: session.record.local.sha256,
    });
    expect(acknowledged).toMatchObject({ accepted: false, error: 'unsupported_file' });
    expect(await fs.promises.readFile(path.join(outside, 'local.txt'))).toEqual(originalLocal);
    expect(await fs.promises.readFile(data.remoteFile)).toEqual(beforeRemote);
    expect(await fs.promises.readdir(outside)).toEqual(['local.txt']);

    const cancelled = await sendRequest(session, capability, {
      kind: 'resolve',
      expectedRevision: 1,
      action: 'cancel',
    });
    expect(cancelled).toMatchObject({ accepted: true, status: 'cancelled' });
    await expect(decisionPromise).resolves.toBe('cancel');
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

  test('remote deletion rejects an inspected MCP candidate as stale without recreating it', async () => {
    const data = await fixture();
    const session = await captureConflict(
      data.workspace,
      'batch-remote-deleted',
      data.context,
      'remote-changed',
      data.remote
    );
    const capability = getConflictMcpConfiguration('3.5.0-test', new Map()).capability;
    const decisionPromise = waitForConflictDecision(session, data.context);
    await delay(20);

    const submitted = await sendRequest(session, capability, {
      kind: 'submit_local',
      expectedRevision: 1,
      expectedLocalSha256: session.record.local.sha256,
      content: 'candidate prepared before remote deletion\n',
    });
    expect(submitted).toMatchObject({ accepted: true, revision: 2 });
    await fs.promises.unlink(data.remoteFile);

    const stale = await sendRequest(session, capability, {
      kind: 'resolve',
      expectedRevision: 2,
      action: 'upload',
    });
    expect(stale).toMatchObject({
      accepted: false,
      stale: true,
      revision: 3,
    });
    expect(session.record.staleReason).toBe('remote-missing');
    expect(session.record.remoteMissingAt).toBeTruthy();
    expect(session.record.candidate).toBeUndefined();
    expect(fs.existsSync(data.remoteFile)).toBe(false);

    await expect(revalidateConflict(session, data.context)).resolves.toMatchObject({
      valid: false,
      revision: 3,
    });
    const cancelled = await sendRequest(session, capability, {
      kind: 'resolve',
      expectedRevision: 3,
      action: 'cancel',
    });
    expect(cancelled.accepted).toBe(true);
    await expect(decisionPromise).resolves.toBe('cancel');
    expect(fs.existsSync(data.remoteFile)).toBe(false);
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

  test('successive remote revalidations retain only the authoritative snapshot', async () => {
    const data = await fixture();
    const session = await captureConflict(
      data.workspace,
      'batch-repeated-revalidation',
      data.context,
      'remote-changed',
      data.remote
    );
    const directory = path.dirname(session.record.reportFile);

    await fs.promises.writeFile(data.remoteFile, 'remote changed once\n');
    await expect(revalidateConflict(session, data.context)).resolves.toMatchObject({
      valid: false,
      revision: 2,
    });
    const firstReplacement = session.record.remoteSnapshot;
    expect(firstReplacement).toBeTruthy();

    await fs.promises.writeFile(data.remoteFile, 'remote changed twice and grew\n');
    await expect(revalidateConflict(session, data.context)).resolves.toMatchObject({
      valid: false,
      revision: 3,
    });
    const secondReplacement = session.record.remoteSnapshot;
    expect(secondReplacement).toBeTruthy();
    expect(secondReplacement).not.toBe(firstReplacement);

    const snapshots = (await fs.promises.readdir(directory)).filter(name =>
      /^remote(?:-[0-9a-f-]+)?\.[^\\/]+$/i.test(name)
    );
    expect(snapshots).toEqual([path.basename(secondReplacement!)]);
    expect(fs.existsSync(firstReplacement!)).toBe(false);

    const unreferenced = path.join(directory, `remote-${randomUUID()}.txt`);
    await fs.promises.writeFile(unreferenced, 'crash leftover');
    await disposeConflictBridge();
    await initializeConflictBridge([data.workspace], '3.5.0-test', {
      globalStorageRoot: data.globalStorageRoot,
      sessionId: 'restarted-session',
      processIsAlive: () => false,
      now: () => new Date(Date.now() + 120_000),
      policy: { leaseStaleMs: 1 },
    });

    const restarted = JSON.parse(
      await fs.promises.readFile(session.record.reportFile, 'utf8')
    );
    expect(restarted.status).toBe('orphaned');
    expect(restarted.remoteSnapshot).toBe(secondReplacement);
    expect(fs.existsSync(secondReplacement!)).toBe(true);
    expect(fs.existsSync(unreferenced)).toBe(false);
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

  test('oversized snapshots are not downloaded and leave a stable limit reason', async () => {
    const data = await fixture();
    await initializeConflictBridge([data.workspace], '3.5.0-test', {
      globalStorageRoot: data.globalStorageRoot,
      policy: { maxSnapshotBytes: data.remote.size - 1 },
    });
    (fileOperations.transferFile as jest.Mock).mockClear();

    const session = await captureConflict(
      data.workspace,
      'batch-oversized',
      data.context,
      'remote-changed',
      data.remote
    );

    expect(fileOperations.transferFile).not.toHaveBeenCalled();
    expect(session.record.status).toBe('pending');
    expect(session.record.remoteSnapshot).toBeNull();
    expect(session.record.snapshotError).toContain('per snapshot');
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
    const requestId = randomUUID();
    const capability = getConflictMcpConfiguration(
      '3.5.0-test',
      new Map()
    ).capability;
    const directory = path.dirname(session.record.reportFile);
    await atomicWriteJson(path.join(directory, 'requests', `${requestId}.json`), {
      version: 3,
      requestId,
      capability,
      kind: 'resolve',
      expectedRevision: 1,
      action: 'cancel',
      createdAt: new Date().toISOString(),
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

  test('manual recovery opens the exact local conflict troubleshooting section', async () => {
    const data = await fixture();
    const session = await captureConflict(
      data.workspace,
      'batch-troubleshoot',
      data.context,
      'timestamp-unavailable',
      data.remote
    );
    const decisionPromise = waitForConflictDecision(session, data.context);
    await delay(20);

    mockQuickPicks[0].accept('Troubleshoot');
    await delay(20);

    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'sftpSyncAI.openTroubleshooting',
      'ftp-timestamps'
    );
    mockQuickPicks[1].accept('Cancel upload');
    await expect(decisionPromise).resolves.toBe('cancel');
  });

  test('old extension-session conflicts become orphaned on initialization', async () => {
    const workspace = path.join(testRoot, randomUUID());
    const stateRoot = path.join(workspace, '.kent-tmp', 'sftp-conflicts');
    const id = 'old-session-conflict';
    const reportFile = path.join(stateRoot, id, 'conflict.json');
    const remoteSnapshot = path.join(stateRoot, id, 'remote.txt');
    await fs.promises.mkdir(path.dirname(remoteSnapshot), { recursive: true });
    await fs.promises.writeFile(remoteSnapshot, 'legacy snapshot');
    const oldRecord = {
      version: 2,
      id,
      status: 'uploading',
      detectedAt: '2026-09-23T10:00:00.000Z',
      updatedAt: '2026-09-23T10:00:00.000Z',
      revision: 1,
      sessionId: 'old-session',
      reportFile,
      remoteSnapshot,
    };
    await atomicWriteJson(reportFile, oldRecord);
    await atomicWriteJson(path.join(stateRoot, 'index.json'), {
      version: 2,
      conflicts: [oldRecord],
    });

    const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
    await initializeConflictBridge([workspace], '3.5.0-test', {
      globalStorageRoot,
      processIsAlive: () => false,
      now: () => new Date('2026-09-23T12:00:00.000Z'),
      policy: { leaseStaleMs: 1 },
    });

    const importedRoot = path.join(
      globalStorageRoot,
      'conflict-state-v2',
      'workspaces'
    );
    const [bucket] = await fs.promises.readdir(importedRoot);
    const importedReport = path.join(importedRoot, bucket, id, 'conflict.json');
    const record = JSON.parse(await fs.promises.readFile(importedReport, 'utf8'));
    expect(record.status).toBe('orphaned');
    expect(record.result.orphanedAt).toBeTruthy();
    expect(await fs.promises.readFile(record.remoteSnapshot, 'utf8')).toBe(
      'legacy snapshot'
    );
    expect(fs.existsSync(stateRoot)).toBe(false);
  });

  test('persists redacted conflict failure and tool-visible error strings', async () => {
    const data = await fixture();
    const session = await captureConflict(
      data.workspace,
      'redaction-batch',
      data.context,
      'remote-changed',
      data.remote
    );
    const reference = await markConflictUploading(session);
    const canary = 'conflict-password-canary-2d719b2c';
    const scope = new RedactionScope();
    scope.register(canary);

    await markConflictFailed(
      reference,
      new Error(`Upload authentication failed: ${canary}`)
    );

    const record = JSON.parse(
      await fs.promises.readFile(session.record.reportFile, 'utf8')
    );
    expect(record.result.error).toBe(
      'Upload authentication failed: [REDACTED]'
    );
    expect(JSON.stringify(record)).not.toContain(canary);
    scope.dispose();
  });

  test('corrupt legacy reports remain protected and surface migration failure until repaired', async () => {
    const workspace = path.join(testRoot, randomUUID());
    const stateRoot = path.join(workspace, '.kent-tmp', 'sftp-conflicts');
    const id = 'corrupt-legacy';
    const directory = path.join(stateRoot, id);
    const reportFile = path.join(directory, 'conflict.json');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(reportFile, '{not-json');
    const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');

    await initializeConflictBridge([workspace], '3.5.0-test', {
      globalStorageRoot,
      processIsAlive: () => false,
    });

    expect(fs.existsSync(stateRoot)).toBe(true);
    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('could not migrate legacy conflict state')
    );

    await fs.promises.writeFile(
      reportFile,
      JSON.stringify({
        version: 2,
        id,
        status: 'failed',
        detectedAt: '2026-09-23T10:00:00.000Z',
        updatedAt: '2026-09-23T10:00:00.000Z',
        sessionId: 'legacy-session',
        reportFile,
        remoteSnapshot: null,
      })
    );
    showErrorMessage.mockClear();
    await initializeConflictBridge([workspace], '3.5.0-test', {
      globalStorageRoot,
      processIsAlive: () => false,
    });

    expect(showErrorMessage).not.toHaveBeenCalled();
    expect(fs.existsSync(stateRoot)).toBe(false);
  });
});
