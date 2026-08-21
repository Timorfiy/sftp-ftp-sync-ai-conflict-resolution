import * as path from 'path';
import * as vscode from 'vscode';
import { FileType } from '../../core/fs/fileSystem';
import type { FileStats } from '../../core/fs/fileSystem';
import { TransferDirection } from '../../core/transferTask';
import logger from '../../logger';
import { diff } from '../diff';
import type { FileHandlerContext } from '../createFileHandler';
import type {
  FileTransferContext,
  TransferLifecycleOption,
} from './transfer';
import {
  getRemoteBaseline,
  recordRemoteBaseline,
  RemoteBaseline,
} from './remoteBaseline';

const OVERWRITE = 'Overwrite';
const OVERWRITE_ALL = 'Overwrite All';
const OPEN_DIFF = 'Open Diff';

export type UploadConflictReason =
  | 'remote-changed'
  | 'baseline-missing'
  | 'timestamp-unavailable';

export class UploadConflictAbortError extends Error {
  constructor() {
    super('Upload cancelled because the remote file may have changed.');
    this.name = 'UploadConflictAbortError';
  }
}

export function sameMetadata(
  a: Pick<FileStats, 'mtime' | 'size'>,
  b: Pick<FileStats, 'mtime' | 'size'>
): boolean {
  return Math.floor(a.mtime / 1000) === Math.floor(b.mtime / 1000) && a.size === b.size;
}

export function detectUploadConflict(
  local: Pick<FileStats, 'mtime' | 'size'>,
  remote: Pick<FileStats, 'mtime' | 'size'>,
  baseline?: RemoteBaseline
): UploadConflictReason | undefined {
  if (remote.mtime <= 0) {
    return 'timestamp-unavailable';
  }
  if (sameMetadata(local, remote)) {
    return undefined;
  }
  if (!baseline) {
    return 'baseline-missing';
  }
  return sameMetadata(remote, baseline) ? undefined : 'remote-changed';
}

function isNotFoundError(error: any): boolean {
  return error?.code === 'ENOENT' || error?.code === 2 || error?.message === 'file not exist';
}

async function remoteStatOrUndefined(
  context: FileTransferContext
): Promise<FileStats | undefined> {
  try {
    return await context.targetFs.lstat(context.targetFsPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
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

export function createConflictLifecycle(
  handlerContext: FileHandlerContext
): TransferLifecycleOption {
  if (!handlerContext.config.conflictCheck) {
    return {};
  }

  let overwriteAll = false;

  return {
    async beforeFileTransfer(context) {
      if (
        context.fileType !== FileType.File ||
        context.transferDirection !== TransferDirection.LOCAL_TO_REMOTE
      ) {
        return;
      }

      const remote = await remoteStatOrUndefined(context);
      if (!remote) {
        return;
      }

      const local = {
        mtime: context.sourceMtime,
        size: context.sourceSize,
      };
      const baseline = await getRemoteBaseline(handlerContext.config, context.targetFsPath);
      const reason = detectUploadConflict(local, remote, baseline);
      if (!reason) {
        return;
      }
      if (overwriteAll) {
        context.conflictOverwrite = reason === 'remote-changed';
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        `SFTP Neo blocked upload of ${path.basename(context.srcFsPath)}.`,
        {
          modal: true,
          detail: `${conflictDetail(reason)}\n\nRemote: ${context.targetFsPath}`,
        },
        OVERWRITE,
        OVERWRITE_ALL,
        OPEN_DIFF
      );

      if (choice === OVERWRITE) {
        context.conflictOverwrite = reason === 'remote-changed';
        return;
      }
      if (choice === OVERWRITE_ALL) {
        overwriteAll = true;
        context.conflictOverwrite = reason === 'remote-changed';
        return;
      }
      if (choice === OPEN_DIFF) {
        await diff(vscode.Uri.file(context.srcFsPath));
      }

      logger.info(`Upload blocked by conflict check: ${context.targetFsPath}`);
      throw new UploadConflictAbortError();
    },

    async afterFileTransfer(context) {
      if (context.fileType !== FileType.File) {
        return;
      }

      try {
        if (context.transferDirection === TransferDirection.LOCAL_TO_REMOTE) {
          const remote = await context.targetFs.lstat(context.targetFsPath);
          await recordRemoteBaseline(handlerContext.config, context.targetFsPath, remote);
        } else {
          await recordRemoteBaseline(handlerContext.config, context.srcFsPath, {
            mtime: context.sourceMtime,
            size: context.sourceSize,
          });
        }
      } catch (error) {
        logger.warn(`Could not record remote baseline for ${context.targetFsPath}: ${error.message}`);
      }
    },
  };
}
