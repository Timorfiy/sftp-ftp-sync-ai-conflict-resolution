jest.mock('vscode', () => ({
  Uri: {
    file: jest.fn(fsPath => ({ fsPath })),
  },
  window: {
    showWarningMessage: jest.fn(),
  },
}));

jest.mock('../../diff', () => ({
  diff: jest.fn(),
}));

jest.mock('../../../logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import * as vscode from 'vscode';
import { FileType } from '../../../core/fs/fileSystem';
import { TransferDirection } from '../../../core/transferTask';
import {
  createConflictLifecycle,
  detectUploadConflict,
  sameMetadata,
} from '../conflictCheck';
import {
  getRemoteBaseline,
  initRemoteBaselineStore,
  recordRemoteBaseline,
} from '../remoteBaseline';

describe('upload conflict metadata comparison', () => {
  const local = {
    mtime: Date.parse('2026-08-21T10:00:00.500Z'),
    size: 100,
  };
  const remote = {
    mtime: Date.parse('2026-08-21T09:00:00.000Z'),
    size: 90,
  };

  test('compares mtime at FTP second precision together with byte size', () => {
    expect(
      sameMetadata(
        { mtime: Date.parse('2026-08-21T09:00:00.900Z'), size: 90 },
        remote
      )
    ).toBe(true);
    expect(sameMetadata({ ...remote, size: 91 }, remote)).toBe(false);
    expect(sameMetadata({ ...remote, mtime: remote.mtime + 1000 }, remote)).toBe(false);
  });

  test('allows upload when current remote metadata still matches the baseline', () => {
    const baseline = {
      ...remote,
      savedAt: Date.now(),
    };

    expect(detectUploadConflict(local, remote, baseline)).toBeUndefined();
  });

  test('detects remote changes by timestamp even when size is unchanged', () => {
    const baseline = {
      ...remote,
      savedAt: Date.now(),
    };

    expect(
      detectUploadConflict(local, { ...remote, mtime: remote.mtime + 1000 }, baseline)
    ).toBe('remote-changed');
  });

  test('detects remote changes by size even when timestamp is unchanged', () => {
    const baseline = {
      ...remote,
      savedAt: Date.now(),
    };

    expect(detectUploadConflict(local, { ...remote, size: remote.size + 1 }, baseline)).toBe(
      'remote-changed'
    );
  });

  test('requires confirmation for an existing different file without a baseline', () => {
    expect(detectUploadConflict(local, remote)).toBe('baseline-missing');
  });

  test('requires confirmation when the server cannot provide an exact timestamp', () => {
    expect(detectUploadConflict(local, { mtime: 0, size: remote.size })).toBe(
      'timestamp-unavailable'
    );
  });
});

describe('remote baseline workspace storage', () => {
  test('records and retrieves metadata scoped to the connection and remote path', async () => {
    let state = {};
    const workspaceState = {
      get: jest.fn((_key, fallback) => state || fallback),
      update: jest.fn(async (_key, value) => {
        state = value;
      }),
    };
    initRemoteBaselineStore(workspaceState as any);

    const config = {
      protocol: 'ftp',
      username: 'user',
      host: 'example.test',
      port: 21,
    } as any;
    const metadata = {
      mtime: Date.parse('2026-08-21T09:00:00.000Z'),
      size: 52153,
    };

    await recordRemoteBaseline(config, '/assets/css/modals.css', metadata);

    expect(await getRemoteBaseline(config, '/assets/css/modals.css')).toMatchObject(metadata);
    expect(await getRemoteBaseline(config, '/assets/css/buttons.css')).toBeUndefined();
  });
});

describe('confirmed conflict overwrite priority', () => {
  test('marks an overwrite after a changed remote baseline as conflict-priority', async () => {
    let state = {};
    const workspaceState = {
      get: jest.fn((_key, fallback) => state || fallback),
      update: jest.fn(async (_key, value) => {
        state = value;
      }),
    };
    initRemoteBaselineStore(workspaceState as any);

    const config = {
      conflictCheck: true,
      protocol: 'ftp',
      username: 'user',
      host: 'example.test',
      port: 21,
    } as any;
    const remotePath = '/assets/css/modals.css';
    const baseline = {
      mtime: Date.parse('2026-08-21T09:00:00.000Z'),
      size: 90,
    };
    await recordRemoteBaseline(config, remotePath, baseline);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Overwrite');

    const lifecycle = createConflictLifecycle({ config } as any);
    const transferContext: any = {
      srcFsPath: 'C:\\workspace\\modals.css',
      targetFsPath: remotePath,
      srcFs: {} as any,
      targetFs: {
        lstat: jest.fn(async () => ({
          type: FileType.File,
          mode: 0o644,
          size: 90,
          mtime: baseline.mtime + 1000,
          atime: baseline.mtime + 1000,
        })),
      } as any,
      fileType: FileType.File,
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      sourceMtime: baseline.mtime + 2000,
      sourceSize: 100,
    };

    await lifecycle.beforeFileTransfer!(transferContext);

    expect(transferContext.conflictOverwrite).toBe(true);
  });
});
