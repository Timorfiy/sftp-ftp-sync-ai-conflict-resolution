import * as vscode from 'vscode';
import { refreshRemoteExplorer } from '../shared';
import createFileHandler, { FileHandlerContext } from '../createFileHandler';
import { transfer, sync, TransferOption, SyncOption, TransferDirection } from './transfer';
import { runHook } from '../../modules/hooks';
import { remoteBackupsProvider } from '../../modules/remoteBackups';
import { withRetry } from '../../helper';
import { createConflictLifecycle, UploadConflictAbortError } from './conflictCheck';
import { createTransferRetryOptions } from './retryOptions';
import { confirmBulkSync } from './bulkSyncConfirmation';
import {
  TransferOperation,
  TransferOperationResult,
} from '../../core/transferOperation';
import { reportError } from '../../helper';
import { TypedFailure } from '../../errors/actionable';

export { createTransferRetryOptions } from './retryOptions';

function reportTransferWarnings(
  result: TransferOperationResult,
  operation: string,
  protocol: string
): void {
  if (result.warnings <= 0) {
    return;
  }
  void reportError(
    new TypedFailure(
      'backup.overwrite-failed',
      'One or more configured overwrite backups failed.',
      { partialResult: result }
    ),
    {
      operation,
      protocol: protocol === 'ftp' ? 'ftp' : 'sftp',
      retrySafety: 'unsafe',
    }
  );
}

function createTransferHandle(direction: TransferDirection) {
  return async function handle(this: FileHandlerContext, option) {
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    const hooks = this.config.hooks;
    const hookCtx = {
      localPath: localFsPath,
      remotePath: remoteFsPath,
      host: this.config.host,
      protocol: this.config.protocol,
    };
    const workspacePath = this.fileService.workspace;

    const isUpload = direction === TransferDirection.LOCAL_TO_REMOTE;
    const preHook = isUpload ? 'preUpload' : 'preDownload';
    const postHook = isUpload ? 'postUpload' : 'postDownload';
    const lifecycle = createConflictLifecycle(this);
    const operation = new TransferOperation();

    await runHook(preHook, hooks, hookCtx, workspacePath);

    let result: TransferOperationResult;
    try {
      result = await withRetry(
        async () => {
          const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
          const scheduler = this.fileService.createTransferScheduler(
            this.config.concurrency,
            operation
          );
          let transferConfig;
          if (direction === TransferDirection.REMOTE_TO_LOCAL) {
            transferConfig = {
              srcFsPath: remoteFsPath,
              srcFs: remoteFs,
              targetFsPath: localFsPath,
              targetFs: localFs,
              transferOption: {
                ...option,
                ...lifecycle,
              },
              transferDirection: TransferDirection.REMOTE_TO_LOCAL,
            };
          } else {
            transferConfig = {
              srcFsPath: localFsPath,
              srcFs: localFs,
              targetFsPath: remoteFsPath,
              targetFs: remoteFs,
              transferOption: {
                ...option,
                ...lifecycle,
              },
              filePerm: this.config.filePerm,
              dirPerm: this.config.dirPerm,
              transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            };
          }
          await transfer(transferConfig, task => scheduler.add(task));
          const transferResult = await scheduler.run();

          if (isUpload) {
            remoteBackupsProvider.refresh();
          }
          return transferResult;
        },
        createTransferRetryOptions(this, direction)
      );
    } catch (error) {
      if (error instanceof UploadConflictAbortError) {
        return;
      }
      throw error;
    }

    await runHook(postHook, hooks, hookCtx, workspacePath);
    reportTransferWarnings(result, isUpload ? 'upload' : 'download', this.config.protocol);
  };
}

const uploadHandle = createTransferHandle(TransferDirection.LOCAL_TO_REMOTE);
const downloadHandle = createTransferHandle(TransferDirection.REMOTE_TO_LOCAL);

export const sync2Remote = createFileHandler<SyncOption>({
  name: 'sync Local → Remote',
  async beforeHandle(option) {
    if (this.config.conflictCheck && option.delete && !option.bothDiretions) {
      await vscode.window.showWarningMessage(
        'SFTP/FTP Sync + AI Conflict Resolution blocked Sync Local → Remote.',
        {
          modal: true,
          detail:
            'conflictCheck cannot safely be combined with syncOption.delete. Disable delete or use Upload File/Folder.',
        }
      );
      return false;
    }

    const direction = option.bothDiretions
      ? 'bothDirections'
      : 'localToRemote';
    return confirmBulkSync({
      direction,
      connectionLabel: this.connectionLabel,
      localPath: this.target.localFsPath,
      remotePath: this.target.remoteFsPath,
      deleteDestination: direction === 'localToRemote' && !!option.delete,
      backup: this.config.backup,
    });
  },
  async handle(option) {
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    const hooks = this.config.hooks;
    const hookCtx = {
      localPath: localFsPath,
      remotePath: remoteFsPath,
      host: this.config.host,
      protocol: this.config.protocol,
    };
    const workspacePath = this.fileService.workspace;

    await runHook('preSync', hooks, hookCtx, workspacePath);

    option.filePerm = this.config.filePerm;
    option.dirPerm = this.config.dirPerm;
    const lifecycle = createConflictLifecycle(this);
    const operation = new TransferOperation();

    let result: TransferOperationResult;
    try {
      result = await withRetry(
        async () => {
          const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
          const scheduler = this.fileService.createTransferScheduler(
            this.config.concurrency,
            operation
          );
          await sync(
            {
              srcFsPath: localFsPath,
              srcFs: localFs,
              targetFsPath: remoteFsPath,
              targetFs: remoteFs,
              transferOption: {
                ...option,
                ...lifecycle,
              },
              transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            },
            task => scheduler.add(task)
          );
          const transferResult = await scheduler.run();

          remoteBackupsProvider.refresh();
          return transferResult;
        },
        createTransferRetryOptions(this, TransferDirection.LOCAL_TO_REMOTE)
      );
    } catch (error) {
      if (error instanceof UploadConflictAbortError) {
        return;
      }
      throw error;
    }

    await runHook('postSync', hooks, hookCtx, workspacePath);
    reportTransferWarnings(result, 'sync local to remote', this.config.protocol);
  },
  transformOption() {
    const config = this.config;
    const syncOption = config.syncOption || {};
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      ignore: config.ignore,
      delete: syncOption.delete,
      skipCreate: syncOption.skipCreate,
      ignoreExisting: syncOption.ignoreExisting,
      update: syncOption.update,
      backup: config.backup,
      remotePath: config.remotePath,
      localBasePath: this.fileService.baseDir,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const sync2Local = createFileHandler<SyncOption>({
  name: 'sync Remote → Local',
  async beforeHandle(option) {
    if (!option.delete) {
      return true;
    }
    return confirmBulkSync({
      direction: 'remoteToLocal',
      connectionLabel: this.connectionLabel,
      localPath: this.target.localFsPath,
      remotePath: this.target.remoteFsPath,
      deleteDestination: true,
      backup: this.config.backup,
    });
  },
  async handle(option) {
    const localFs = this.fileService.getLocalFileSystem();
    const { localFsPath, remoteFsPath } = this.target;
    const hooks = this.config.hooks;
    const hookCtx = {
      localPath: localFsPath,
      remotePath: remoteFsPath,
      host: this.config.host,
      protocol: this.config.protocol,
    };
    const workspacePath = this.fileService.workspace;
    const lifecycle = createConflictLifecycle(this);
    const operation = new TransferOperation();

    await runHook('preSync', hooks, hookCtx, workspacePath);

    await withRetry(
      async () => {
        const remoteFs = await this.fileService.getRemoteFileSystem(this.config);
        const scheduler = this.fileService.createTransferScheduler(
          this.config.concurrency,
          operation
        );
        await sync(
          {
            srcFsPath: remoteFsPath,
            srcFs: remoteFs,
            targetFsPath: localFsPath,
            targetFs: localFs,
            transferOption: {
              ...option,
              ...lifecycle,
            },
            transferDirection: TransferDirection.REMOTE_TO_LOCAL,
          },
          task => scheduler.add(task)
        );
        await scheduler.run();
      },
      createTransferRetryOptions(this, TransferDirection.REMOTE_TO_LOCAL)
    );

    await runHook('postSync', hooks, hookCtx, workspacePath);
  },
  transformOption() {
    const config = this.config;
    const syncOption = config.syncOption || {};
    return {
      perserveTargetMode: false,
      ignore: config.ignore,
      delete: syncOption.delete,
      skipCreate: syncOption.skipCreate,
      ignoreExisting: syncOption.ignoreExisting,
      update: syncOption.update,
    };
  },
});

export const upload = createFileHandler<TransferOption>({
  name: 'upload',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      ignore: config.ignore,
      backup: config.backup,
      remotePath: config.remotePath,
      localBasePath: this.fileService.baseDir,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, this.fileService);
  },
});

export const uploadFile = createFileHandler<TransferOption>({
  name: 'upload file',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.filePerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      ignore: config.ignore,
      backup: config.backup,
      remotePath: config.remotePath,
      localBasePath: this.fileService.baseDir,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, false);
  },
});

export const uploadFolder = createFileHandler<TransferOption>({
  name: 'upload folder',
  handle: uploadHandle,
  transformOption() {
    const config = this.config;
    return {
      perserveTargetMode: config.protocol === 'sftp' && !config.dirPerm,
      useTempFile: config.useTempFile,
      openSsh: config.openSsh,
      ignore: config.ignore,
      backup: config.backup,
      remotePath: config.remotePath,
      localBasePath: this.fileService.baseDir,
    };
  },
  afterHandle() {
    refreshRemoteExplorer(this.target, true);
  },
});

export const download = createFileHandler<TransferOption>({
  name: 'download',
  handle: downloadHandle,
  transformOption() {
    return {
      perserveTargetMode: false,
      ignore: this.config.ignore,
    };
  },
});

export const downloadFile = createFileHandler<TransferOption>({
  name: 'download file',
  handle: downloadHandle,
  transformOption() {
    return {
      perserveTargetMode: false,
      ignore: this.config.ignore,
    };
  },
});

export const downloadFolder = createFileHandler<TransferOption>({
  name: 'download folder',
  handle: downloadHandle,
  transformOption() {
    return {
      perserveTargetMode: false,
      ignore: this.config.ignore,
    };
  },
});
