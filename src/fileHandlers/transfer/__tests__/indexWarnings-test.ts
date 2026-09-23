const reportError = jest.fn(async () => undefined);
const runHook = jest.fn(async () => undefined);
const refreshBackups = jest.fn();
const refreshExplorer = jest.fn();
const transfer = jest.fn();

jest.mock('vscode', () => ({
  EventEmitter: class EventEmitter {
    event = jest.fn();
    fire = jest.fn();
  },
  StatusBarAlignment: { Left: 1 },
  ThemeIcon: class ThemeIcon {
    constructor(readonly id: string) {}
  },
  TreeItemCollapsibleState: { None: 0 },
  Uri: class Uri {},
  window: {
    showWarningMessage: jest.fn(async () => undefined),
    showErrorMessage: jest.fn(async () => undefined),
    createOutputChannel: jest.fn(() => ({
      appendLine: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
    })),
    createStatusBarItem: jest.fn(() => ({
      show: jest.fn(),
      hide: jest.fn(),
    })),
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    })),
  },
  commands: {
    executeCommand: jest.fn(async () => undefined),
  },
}));

jest.mock('../../../helper', () => ({
  reportError,
  withRetry: async operation => operation(),
}));

jest.mock('../../../modules/hooks', () => ({
  runHook,
}));

jest.mock('../../../modules/remoteBackups', () => ({
  remoteBackupsProvider: {
    refresh: refreshBackups,
  },
}));

jest.mock('../../shared', () => ({
  refreshRemoteExplorer: refreshExplorer,
}));

jest.mock('../transfer', () => {
  return {
    transfer,
    sync: jest.fn(),
    TransferDirection: {
      LOCAL_TO_REMOTE: 'local-to-remote',
      REMOTE_TO_LOCAL: 'remote-to-local',
    },
  };
});

jest.mock('../../../app', () => ({
  __esModule: true,
  default: {
    sftpBarItem: {
      startSpinner: jest.fn(),
      stopSpinner: jest.fn(),
    },
  },
}));

import { uploadFile } from '../index';

describe('upload warning-only completion', () => {
  beforeEach(() => {
    reportError.mockClear();
    runHook.mockClear();
    refreshBackups.mockClear();
    refreshExplorer.mockClear();
    transfer.mockReset();
  });

  test('commits upload, reports backup warning, and keeps success hooks and refreshes', async () => {
    let remoteContent = 'old remote content';
    const task = {
      run: jest.fn(async () => {
        remoteContent = 'new local content';
      }),
    };
    transfer.mockImplementation(async (_config, collect) => {
      collect(task);
    });
    const scheduler = {
      add: jest.fn(),
      run: jest.fn(async () => {
        await task.run();
        return {
          operationId: 'warning-upload',
          completed: 1,
          failed: 0,
          cancelled: 0,
          notStarted: 0,
          warnings: 1,
          isPartial: true,
          items: [
            {
              id: 'warning-upload:1',
              localPath: 'C:\\workspace\\index.php',
              sourcePath: 'C:\\workspace\\index.php',
              targetPath: '/var/www/index.php',
              status: 'completed',
              attempts: 1,
              warnings: ['Previous remote text may not be recoverable.'],
            },
          ],
        };
      }),
    };
    const fileService = {
      baseDir: 'C:\\workspace',
      workspace: 'C:\\workspace',
      getLocalFileSystem: jest.fn(() => ({})),
      getRemoteFileSystem: jest.fn(async () => ({})),
      createTransferScheduler: jest.fn(() => scheduler),
    };
    const context = {
      fileService,
      config: {
        host: 'example.com',
        port: 22,
        protocol: 'sftp',
        remotePath: '/var/www',
        concurrency: 1,
        hooks: {
          postUpload: 'post-upload-fixture',
        },
        backup: {
          enabled: true,
          folder: '.vscode/sftp-backup',
          versions: 5,
        },
        ignore: null,
      },
      target: {
        localFsPath: 'C:\\workspace\\index.php',
        remoteFsPath: '/var/www/index.php',
      },
    };

    await expect(uploadFile(context as any)).resolves.toBeUndefined();

    expect(remoteContent).toBe('new local content');
    expect(scheduler.add).toHaveBeenCalledWith(task);
    expect(runHook).toHaveBeenNthCalledWith(
      1,
      'preUpload',
      context.config.hooks,
      expect.any(Object),
      'C:\\workspace'
    );
    expect(runHook).toHaveBeenNthCalledWith(
      2,
      'postUpload',
      context.config.hooks,
      expect.any(Object),
      'C:\\workspace'
    );
    expect(refreshBackups).toHaveBeenCalledTimes(1);
    expect(refreshExplorer).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        failureId: 'backup.overwrite-failed',
        context: expect.objectContaining({
          partialResult: expect.objectContaining({
            completed: 1,
            warnings: 1,
          }),
        }),
      }),
      expect.objectContaining({
        operation: 'upload',
        protocol: 'sftp',
        retrySafety: 'unsafe',
      })
    );
  });
});
