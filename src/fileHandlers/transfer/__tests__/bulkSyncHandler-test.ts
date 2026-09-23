const showWarningMessage = jest.fn();
const refreshRemoteExplorer = jest.fn();
const runHook = jest.fn(async (..._args: any[]) => undefined);
const sync = jest.fn(async () => undefined);
const remoteBackupsRefresh = jest.fn();
const createConflictLifecycle = jest.fn(() => ({}));
const createTransferRetryOptions = jest.fn(() => ({}));
const startSpinner = jest.fn();
const stopSpinner = jest.fn();
const reportError = jest.fn(async () => undefined);

class MockUri {}

jest.mock('vscode', () => ({
  Uri: MockUri,
  window: { showWarningMessage },
}));
jest.mock('../../../app', () => ({
  __esModule: true,
  default: {
    sftpBarItem: { startSpinner, stopSpinner },
  },
}));
jest.mock('../../../modules/serviceManager', () => ({
  getFileService: jest.fn(),
}));
jest.mock('../../shared', () => ({ refreshRemoteExplorer }));
jest.mock('../../../modules/hooks', () => ({ runHook }));
jest.mock('../../../modules/remoteBackups', () => ({
  remoteBackupsProvider: { refresh: remoteBackupsRefresh },
}));
jest.mock('../../../helper', () => ({
  withRetry: jest.fn(async action => action()),
  reportError,
}));
jest.mock('../transfer', () => ({
  sync,
  transfer: jest.fn(),
  TransferDirection: {
    LOCAL_TO_REMOTE: 0,
    REMOTE_TO_LOCAL: 1,
  },
}));
jest.mock('../conflictCheck', () => ({
  createConflictLifecycle,
  UploadConflictAbortError: class UploadConflictAbortError extends Error {},
}));
jest.mock('../retryOptions', () => ({ createTransferRetryOptions }));
jest.mock('../../../logger', () => ({
  __esModule: true,
  default: { trace: jest.fn(), warn: jest.fn() },
}));

import { sync2Local, sync2Remote } from '../index';

function createContext({
  deleteDestination = false,
  conflictCheck = false,
  backupEnabled = false,
} = {}) {
  const scheduler = {
    add: jest.fn(),
    run: jest.fn(async (): Promise<any> => ({
      operationId: 'bulk-handler-test',
      completed: 0,
      failed: 0,
      cancelled: 0,
      notStarted: 0,
      warnings: 0,
      items: [],
      isPartial: false,
    })),
  };
  const fileService = {
    baseDir: 'C:\\workspace',
    workspace: 'C:\\workspace',
    getLocalFileSystem: jest.fn(() => ({ side: 'local' })),
    getRemoteFileSystem: jest.fn(async () => ({ side: 'remote' })),
    createTransferScheduler: jest.fn(() => scheduler),
  };
  return {
    context: {
      connectionLabel: 'Profile "production"',
      target: {
        localFsPath: 'C:\\workspace\\site',
        remoteFsPath: '/var/www/site',
      },
      fileService,
      config: {
        protocol: 'sftp',
        host: 'example.invalid',
        remotePath: '/var/www/site',
        concurrency: 1,
        conflictCheck,
        useTempFile: false,
        openSsh: false,
        hooks: { preSync: 'pre', postSync: 'post' },
        syncOption: {
          delete: deleteDestination,
          skipCreate: false,
          ignoreExisting: false,
          update: false,
        },
        backup: {
          enabled: backupEnabled,
          folder: '.sftp-backups',
          versions: backupEnabled ? 100 : 0,
          onDelete: false,
        },
      },
    } as any,
    fileService,
    scheduler,
  };
}

describe('bulk sync handler authorization boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function expectNoSideEffects(state: ReturnType<typeof createContext>) {
    expect(runHook).not.toHaveBeenCalled();
    expect(state.fileService.getLocalFileSystem).not.toHaveBeenCalled();
    expect(state.fileService.getRemoteFileSystem).not.toHaveBeenCalled();
    expect(state.fileService.createTransferScheduler).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
    expect(remoteBackupsRefresh).not.toHaveBeenCalled();
    expect(refreshRemoteExplorer).not.toHaveBeenCalled();
    expect(startSpinner).not.toHaveBeenCalled();
    expect(stopSpinner).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  }

  test.each([undefined, 'Cancel'])(
    'Local → Remote cancellation response %p stops before every side effect',
    async response => {
      const state = createContext();
      showWarningMessage.mockResolvedValueOnce(response);

      await sync2Remote(state.context);

      expect(showWarningMessage).toHaveBeenCalledWith(
        'Confirm Local → Remote (upload) sync',
        {
          modal: true,
          detail: expect.stringContaining('Local path: C:\\workspace\\site'),
        },
        'Sync Local → Remote'
      );
      expect(showWarningMessage.mock.calls[0][1].detail).toContain(
        'Remote path: /var/www/site'
      );
      expect(showWarningMessage.mock.calls[0][1].detail).toContain(
        'Connection/profile: Profile "production"'
      );
      expectNoSideEffects(state);
    }
  );

  test('confirmed Local → Remote executes the existing sync flow exactly once', async () => {
    const state = createContext();
    showWarningMessage.mockResolvedValueOnce('Sync Local → Remote');

    await sync2Remote(state.context);

    expect(runHook.mock.calls.map(call => call[0])).toEqual(['preSync', 'postSync']);
    expect(state.fileService.getRemoteFileSystem).toHaveBeenCalledTimes(1);
    expect(state.fileService.createTransferScheduler).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(createConflictLifecycle).toHaveBeenCalledTimes(1);
    expect(state.scheduler.run).toHaveBeenCalledTimes(1);
    expect(remoteBackupsRefresh).toHaveBeenCalledTimes(1);
    expect(refreshRemoteExplorer).toHaveBeenCalledTimes(1);
    expect(startSpinner).toHaveBeenCalledTimes(1);
    expect(stopSpinner).toHaveBeenCalledTimes(1);
  });

  test('confirmed Local → Remote preserves warning-only success and reports recovery risk', async () => {
    const state = createContext({ backupEnabled: true });
    showWarningMessage.mockResolvedValueOnce('Sync Local → Remote');
    state.scheduler.run.mockResolvedValueOnce({
      operationId: 'bulk-warning',
      completed: 1,
      failed: 0,
      cancelled: 0,
      notStarted: 0,
      warnings: 1,
      items: [
        {
          id: 'bulk-warning:1',
          localPath: 'C:\\workspace\\site\\index.html',
          sourcePath: 'C:\\workspace\\site\\index.html',
          targetPath: '/var/www/site/index.html',
          status: 'completed',
          attempts: 1,
          warnings: ['Previous remote text may not be recoverable.'],
        },
      ],
      isPartial: true,
    });

    await expect(sync2Remote(state.context)).resolves.toBeUndefined();

    expect(runHook.mock.calls.map(call => call[0])).toEqual(['preSync', 'postSync']);
    expect(remoteBackupsRefresh).toHaveBeenCalledTimes(1);
    expect(refreshRemoteExplorer).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        failureId: 'backup.overwrite-failed',
        context: expect.objectContaining({
          partialResult: expect.objectContaining({
            operationId: 'bulk-warning',
            completed: 1,
            warnings: 1,
          }),
        }),
      }),
      expect.objectContaining({
        operation: 'sync local to remote',
        protocol: 'sftp',
        retrySafety: 'unsafe',
      })
    );
    expect(startSpinner).toHaveBeenCalledTimes(1);
    expect(stopSpinner).toHaveBeenCalledTimes(1);
  });

  test('confirmed Local → Remote preserves a partial result failure and stops success-only work', async () => {
    const state = createContext();
    const partialFailure = Object.assign(
      new Error('Transfer operation finished with partial results.'),
      {
        failureId: 'operation.partial',
        context: {
          partialResult: {
            operationId: 'bulk-partial',
            completed: 1,
            failed: 1,
            cancelled: 0,
            notStarted: 0,
            warnings: 0,
            items: [],
            isPartial: true,
          },
        },
      }
    );
    showWarningMessage.mockResolvedValueOnce('Sync Local → Remote');
    state.scheduler.run.mockRejectedValueOnce(partialFailure);

    await expect(sync2Remote(state.context)).rejects.toBe(partialFailure);

    expect(runHook.mock.calls.map(call => call[0])).toEqual(['preSync']);
    expect(remoteBackupsRefresh).not.toHaveBeenCalled();
    expect(refreshRemoteExplorer).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(startSpinner).toHaveBeenCalledTimes(1);
    expect(stopSpinner).toHaveBeenCalledTimes(1);
  });

  test('delete-enabled Local → Remote names remote deletion', async () => {
    const state = createContext({ deleteDestination: true });
    showWarningMessage.mockResolvedValueOnce(undefined);

    await sync2Remote(state.context);

    expect(showWarningMessage.mock.calls[0][1].detail).toContain(
      'Remote files and folders absent locally will be deleted remotely.'
    );
    expectNoSideEffects(state);
  });

  test('conflictCheck plus Local → Remote delete stays blocked before confirmation or mutation', async () => {
    const state = createContext({
      deleteDestination: true,
      conflictCheck: true,
    });

    await sync2Remote(state.context);

    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(showWarningMessage).toHaveBeenCalledWith(
      'SFTP/FTP Sync + AI Conflict Resolution blocked Sync Local → Remote.',
      expect.objectContaining({ modal: true })
    );
    expectNoSideEffects(state);
  });

  test('Both Directions requires confirmation and does not claim configured delete behavior', async () => {
    const state = createContext({
      deleteDestination: true,
      conflictCheck: true,
    });
    showWarningMessage.mockResolvedValueOnce('Sync Both Directions');

    await sync2Remote(state.context, { bothDiretions: true });

    expect(showWarningMessage).toHaveBeenCalledWith(
      'Confirm Both Directions sync',
      expect.objectContaining({ modal: true }),
      'Sync Both Directions'
    );
    expect(showWarningMessage.mock.calls[0][1].detail).not.toMatch(/will be deleted/i);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  test('Remote → Local without delete remains an unconfirmed primary flow', async () => {
    const state = createContext();

    await sync2Local(state.context);

    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  test('delete-enabled Remote → Local cancellation names local deletion and changes nothing', async () => {
    const state = createContext({ deleteDestination: true });
    showWarningMessage.mockResolvedValueOnce(undefined);

    await sync2Local(state.context);

    expect(showWarningMessage).toHaveBeenCalledWith(
      'Confirm Remote → Local sync',
      expect.objectContaining({ modal: true }),
      'Sync Remote → Local'
    );
    expect(showWarningMessage.mock.calls[0][1].detail).toContain(
      'Local files and folders absent remotely will be deleted locally.'
    );
    expectNoSideEffects(state);
  });
});
