import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  ConflictStateStoreOptions,
  ConflictStateStatus,
  ConflictStateStore,
  legacyConflictRoot,
  StoredConflictRecord,
  workspaceBucketId,
} from '../conflictStateStore';

const testRoot = path.join(process.cwd(), '.jest-conflict-data');

function makeStore(
  globalStorageRoot: string,
  workspace: string,
  overrides: Partial<ConflictStateStoreOptions> = {}
) {
  return new ConflictStateStore({
    globalStorageRoot,
    workspaces: [workspace],
    extensionVersion: 'test',
    ...overrides,
  });
}

async function writeRecord(
  store: ConflictStateStore,
  workspace: string,
  id: string,
  status: ConflictStateStatus,
  updatedAt: string,
  sessionId = store.sessionId
) {
  const root = await store.prepareConflict(workspace, id);
  const record: StoredConflictRecord = {
    version: 2,
    id,
    status,
    detectedAt: updatedAt,
    updatedAt,
    sessionId,
    reportFile: path.join(root, id, 'conflict.json'),
    remoteSnapshot: null,
  };
  await store.writeRecord(root, record);
  return { root, record, directory: path.join(root, id) };
}

describe('ConflictStateStore', () => {
  test('configuration is lazy and workspace buckets do not expose project paths', async () => {
    const workspace = path.join(testRoot, randomUUID(), 'Secret Project');
    const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
    const store = makeStore(globalStorageRoot, workspace);

    expect(fs.existsSync(workspace)).toBe(false);
    expect(fs.existsSync(globalStorageRoot)).toBe(false);
    expect(path.basename(store.workspaceRoot(workspace))).toMatch(/^[a-f0-9]{64}$/);
    expect(store.workspaceRoot(workspace)).not.toContain('Secret Project');

    await store.dispose();
    expect(fs.existsSync(globalStorageRoot)).toBe(false);
  });

  test('Windows workspace identity folds drive-letter case and separators', () => {
    expect(workspaceBucketId('C:\\Users\\Owner\\Project')).toBe(
      workspaceBucketId('c:/users/owner/project')
    );
  });

  test('retention removes expired and oldest inactive records but preserves active state', async () => {
    const workspace = path.join(testRoot, randomUUID(), 'workspace');
    const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
    const store = makeStore(globalStorageRoot, workspace, {
      globalStorageRoot,
      workspaces: [workspace],
      extensionVersion: 'test',
      now: () => new Date('2026-09-23T12:00:00.000Z'),
      policy: {
        maxAgeMs: 60_000,
        maxInactivePerWorkspace: 2,
        maxTotalBytes: 1024 * 1024,
      },
    });

    const expired = await writeRecord(
      store,
      workspace,
      'expired',
      'uploaded',
      '2026-09-23T11:00:00.000Z'
    );
    const oldest = await writeRecord(
      store,
      workspace,
      'oldest',
      'failed',
      '2026-09-23T11:59:30.000Z'
    );
    const middle = await writeRecord(
      store,
      workspace,
      'middle',
      'cancelled',
      '2026-09-23T11:59:40.000Z'
    );
    const newest = await writeRecord(
      store,
      workspace,
      'newest',
      'orphaned',
      '2026-09-23T11:59:50.000Z'
    );
    const active = await writeRecord(
      store,
      workspace,
      'active',
      'pending',
      '2026-09-23T10:00:00.000Z'
    );

    await store.enforceRetention();

    expect(fs.existsSync(expired.directory)).toBe(false);
    expect(fs.existsSync(oldest.directory)).toBe(false);
    expect(fs.existsSync(middle.directory)).toBe(true);
    expect(fs.existsSync(newest.directory)).toBe(true);
    expect(fs.existsSync(active.directory)).toBe(true);
    await store.dispose();
  });

  test('global byte pressure deletes only inactive records and reports exhausted snapshot budget', async () => {
    const workspace = path.join(testRoot, randomUUID(), 'workspace');
    const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
    const store = makeStore(globalStorageRoot, workspace, {
      globalStorageRoot,
      workspaces: [workspace],
      extensionVersion: 'test',
      policy: {
        maxTotalBytes: 1024,
        maxSnapshotBytes: 128,
        maxInactivePerWorkspace: 10,
      },
    });
    const inactive = await writeRecord(
      store,
      workspace,
      'inactive',
      'uploaded',
      new Date().toISOString()
    );
    await fs.promises.writeFile(path.join(inactive.directory, 'payload.bin'), Buffer.alloc(2048));
    const active = await writeRecord(
      store,
      workspace,
      'active',
      'pending',
      new Date().toISOString()
    );
    await fs.promises.writeFile(path.join(active.directory, 'payload.bin'), Buffer.alloc(2048));

    await store.enforceRetention();

    expect(fs.existsSync(inactive.directory)).toBe(false);
    expect(fs.existsSync(active.directory)).toBe(true);
    await expect(store.reserveSnapshot(129)).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('per snapshot'),
    });
    await expect(store.reserveSnapshot(1)).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('storage is full'),
    });
    await store.dispose();
  });

  test('restart reconciliation protects live leases and orphans dead sessions', async () => {
    const workspace = path.join(testRoot, randomUUID(), 'workspace');
    const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
    let currentTime = new Date('2026-09-23T12:00:00.000Z');
    let oldProcessAlive = true;
    const oldStore = makeStore(globalStorageRoot, workspace, {
      globalStorageRoot,
      workspaces: [workspace],
      extensionVersion: 'test',
      sessionId: 'old-session',
      processId: 101,
      now: () => currentTime,
      processIsAlive: pid => pid === 101 && oldProcessAlive,
      policy: { leaseStaleMs: 1000 },
    });
    const active = await writeRecord(
      oldStore,
      workspace,
      'live-decision',
      'uploading',
      currentTime.toISOString()
    );
    const inProgressSnapshot = path.join(active.directory, 'remote-check-in-progress.txt');
    await fs.promises.writeFile(inProgressSnapshot, 'partial');

    const secondStore = makeStore(globalStorageRoot, workspace, {
      globalStorageRoot,
      workspaces: [workspace],
      extensionVersion: 'test',
      sessionId: 'second-session',
      processId: 202,
      now: () => currentTime,
      processIsAlive: pid => pid === 101 && oldProcessAlive,
      policy: { leaseStaleMs: 1000 },
    });
    await secondStore.reconcileLegacyIfPresent();
    expect(
      JSON.parse(await fs.promises.readFile(active.record.reportFile, 'utf8')).status
    ).toBe('uploading');
    expect(fs.existsSync(inProgressSnapshot)).toBe(true);
    await secondStore.dispose();

    oldProcessAlive = false;
    currentTime = new Date('2026-09-23T12:00:02.000Z');
    const restartedStore = makeStore(globalStorageRoot, workspace, {
      globalStorageRoot,
      workspaces: [workspace],
      extensionVersion: 'test',
      sessionId: 'restarted-session',
      processId: 303,
      now: () => currentTime,
      processIsAlive: () => false,
      policy: { leaseStaleMs: 1000 },
    });
    await restartedStore.reconcileLegacyIfPresent();
    const orphaned = JSON.parse(
      await fs.promises.readFile(active.record.reportFile, 'utf8')
    );
    expect(orphaned.status).toBe('orphaned');
    expect(orphaned.result.orphanedAt).toBe(currentTime.toISOString());
    expect(fs.existsSync(inProgressSnapshot)).toBe(false);

    await restartedStore.dispose();
    await oldStore.dispose();
  });

  test('clear removes inactive records and bytes while retaining active decisions', async () => {
    const workspace = path.join(testRoot, randomUUID(), 'workspace');
    const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
    const store = makeStore(globalStorageRoot, workspace);
    const terminal = await writeRecord(
      store,
      workspace,
      'terminal',
      'failed',
      new Date().toISOString()
    );
    await fs.promises.writeFile(path.join(terminal.directory, 'payload.bin'), Buffer.alloc(256));
    const active = await writeRecord(
      store,
      workspace,
      'active',
      'reviewing',
      new Date().toISOString()
    );

    const result = await store.clear([workspace]);

    expect(result.clearedRecords).toBe(1);
    expect(result.clearedBytes).toBeGreaterThanOrEqual(256);
    expect(result.retainedActiveRecords).toBe(1);
    expect(fs.existsSync(terminal.directory)).toBe(false);
    expect(fs.existsSync(active.directory)).toBe(true);
    await store.dispose();
  });

  test('clear imports and removes inactive legacy records safely', async () => {
    const workspace = path.join(testRoot, randomUUID(), 'workspace');
    const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
    const legacyRoot = legacyConflictRoot(workspace);
    const id = 'legacy-terminal';
    const legacyDirectory = path.join(legacyRoot, id);
    await fs.promises.mkdir(legacyDirectory, { recursive: true });
    await fs.promises.writeFile(
      path.join(legacyDirectory, 'conflict.json'),
      JSON.stringify({
        version: 2,
        id,
        status: 'failed',
        detectedAt: '2026-09-23T10:00:00.000Z',
        updatedAt: '2026-09-23T10:00:00.000Z',
        sessionId: 'legacy-session',
        reportFile: path.join(legacyDirectory, 'conflict.json'),
        remoteSnapshot: null,
      })
    );
    const store = makeStore(globalStorageRoot, workspace, {
      globalStorageRoot,
      workspaces: [workspace],
      extensionVersion: 'test',
      processIsAlive: () => false,
    });

    const result = await store.clear([workspace]);

    expect(result.clearedRecords).toBe(1);
    expect(result.legacyRootsCleared).toBe(1);
    expect(fs.existsSync(legacyRoot)).toBe(false);
    await store.dispose();
  });

  test.each(['previous', 'tmp'])(
    'legacy migration recovers a valid interrupted %s report',
    async artifact => {
      const workspace = path.join(testRoot, randomUUID(), 'workspace');
      const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
      const legacyRoot = legacyConflictRoot(workspace);
      const id = `legacy-${artifact}`;
      const directory = path.join(legacyRoot, id);
      const reportFile = path.join(directory, 'conflict.json');
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.writeFile(reportFile, '{interrupted');
      const recoveryFile =
        artifact === 'previous'
          ? `${reportFile}.previous`
          : `${reportFile}.123.tmp`;
      await fs.promises.writeFile(
        recoveryFile,
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
      const store = makeStore(globalStorageRoot, workspace, {
        globalStorageRoot,
        workspaces: [workspace],
        extensionVersion: 'test',
        processIsAlive: () => false,
      });

      await store.reconcileLegacyIfPresent();

      const imported = await store.list([workspace]);
      expect(imported).toEqual([expect.objectContaining({ id, status: 'failed' })]);
      expect(fs.existsSync(legacyRoot)).toBe(false);
      await store.dispose();
    }
  );

  test('legacy migration preserves the record and rejects an oversized snapshot', async () => {
    const workspace = path.join(testRoot, randomUUID(), 'workspace');
    const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
    const legacyRoot = legacyConflictRoot(workspace);
    const id = 'legacy-oversized';
    const directory = path.join(legacyRoot, id);
    const reportFile = path.join(directory, 'conflict.json');
    const snapshot = path.join(directory, 'remote.txt');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(snapshot, Buffer.alloc(64));
    await fs.promises.writeFile(
      reportFile,
      JSON.stringify({
        version: 2,
        id,
        status: 'pending',
        detectedAt: '2026-09-23T10:00:00.000Z',
        updatedAt: '2026-09-23T10:00:00.000Z',
        sessionId: 'legacy-session',
        reportFile,
        remoteSnapshot: snapshot,
      })
    );
    const store = makeStore(globalStorageRoot, workspace, {
      globalStorageRoot,
      workspaces: [workspace],
      extensionVersion: 'test',
      processIsAlive: () => false,
      policy: { maxSnapshotBytes: 16, leaseStaleMs: 1 },
      now: () => new Date('2026-09-23T12:00:00.000Z'),
    });

    await store.reconcileLegacyIfPresent();

    const [record] = await store.list([workspace]);
    expect(record.id).toBe(id);
    expect(record.remoteSnapshot).toBeNull();
    expect(record.snapshotError).toBe(
      'Remote snapshot is 64 bytes; the conflict-state limit is 16 bytes per snapshot.'
    );
    const importedDirectory = path.dirname(record.reportFile);
    expect(fs.existsSync(path.join(importedDirectory, 'remote.txt'))).toBe(false);
    expect(fs.existsSync(legacyRoot)).toBe(false);
    await store.dispose();
  });

  test('reconciles a valid interrupted JSON replacement without an index', async () => {
    const workspace = path.join(testRoot, randomUUID(), 'workspace');
    const globalStorageRoot = path.join(testRoot, randomUUID(), 'global');
    const root = path.join(
      globalStorageRoot,
      'conflict-state-v2',
      'workspaces',
      workspaceBucketId(workspace)
    );
    const id = 'interrupted';
    const directory = path.join(root, id);
    const reportFile = path.join(directory, 'conflict.json');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(
      `${reportFile}.123.tmp`,
      JSON.stringify({
        version: 2,
        id,
        status: 'pending',
        detectedAt: '2026-09-23T10:00:00.000Z',
        updatedAt: '2026-09-23T10:00:00.000Z',
        sessionId: 'dead-session',
        reportFile,
        remoteSnapshot: null,
      })
    );
    const store = makeStore(globalStorageRoot, workspace, {
      globalStorageRoot,
      workspaces: [workspace],
      extensionVersion: 'test',
      now: () => new Date('2026-09-23T12:00:00.000Z'),
      processIsAlive: () => false,
      policy: { leaseStaleMs: 1 },
    });

    await store.reconcileLegacyIfPresent();

    expect(fs.existsSync(reportFile)).toBe(true);
    expect(JSON.parse(await fs.promises.readFile(reportFile, 'utf8')).status).toBe(
      'orphaned'
    );
    expect(fs.existsSync(`${reportFile}.123.tmp`)).toBe(false);
    await expect(store.list([workspace])).resolves.toEqual([
      expect.objectContaining({ id, status: 'orphaned' }),
    ]);
    await store.dispose();
  });
});
