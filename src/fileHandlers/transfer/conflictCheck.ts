import { randomUUID } from 'crypto';
import { FileType } from '../../core/fs/fileSystem';
import type { FileStats } from '../../core/fs/fileSystem';
import { TransferDirection } from '../../core/transferTask';
import logger from '../../logger';
import type { FileHandlerContext } from '../createFileHandler';
import type {
  FileTransferContext,
  TransferLifecycleOption,
} from './transfer';
import {
  acceptBatchOverwrite,
  captureConflict,
  markConflictFailed,
  markConflictUploaded,
  markConflictUploading,
  waitForConflictDecision,
} from './conflictBridge';
import type { UploadConflictReason } from './conflictBridge';
import {
  getRemoteBaseline,
  recordRemoteBaseline,
  RemoteBaseline,
} from './remoteBaseline';

export type { UploadConflictReason } from './conflictBridge';

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

export function createConflictLifecycle(
  handlerContext: FileHandlerContext
): TransferLifecycleOption {
  if (!handlerContext.config.conflictCheck) {
    return {};
  }

  let overwriteAll = false;
  const batchId = randomUUID();

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

      const session = await captureConflict(
        handlerContext.fileService.workspace,
        batchId,
        context,
        reason,
        remote,
        baseline
      );

      if (overwriteAll) {
        const accepted = await acceptBatchOverwrite(session, context);
        if (!accepted) {
          overwriteAll = false;
        } else {
          context.conflictOverwrite = reason === 'remote-changed';
          context.kentConflictReport = await markConflictUploading(session);
          return;
        }
      }

      const decision = await waitForConflictDecision(session, context);
      if (decision === 'cancel') {
        logger.info(`Upload blocked by conflict check: ${context.targetFsPath}`);
        throw new UploadConflictAbortError();
      }
      if (decision === 'overwrite_all') {
        overwriteAll = true;
      }

      context.conflictOverwrite = reason === 'remote-changed';
      context.kentConflictReport = await markConflictUploading(session);
    },

    async afterFileTransfer(context) {
      if (context.fileType !== FileType.File) {
        return;
      }

      if (context.kentConflictReport) {
        await markConflictUploaded(context.kentConflictReport);
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

    async afterFileTransferError(context, error) {
      if (context.kentConflictReport) {
        await markConflictFailed(context.kentConflictReport, error);
      }
    },
  };
}
