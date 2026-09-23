import { Readable } from 'stream';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { FileSystem, FileType } from './fs';
import { Task } from './scheduler';
import logger from '../logger';
import { BackupConfig } from './fileService';
import localFs from './localFs';
import { createBackup, BackupPriority, BackupStorage } from './backup';
import { isConflictStatePath } from '../fileHandlers/transfer/conflictStateIsolation';
import { BackupResult } from './backup';
import { withPathFailure } from '../errors/actionable';

let hasWarnedModifedTimePermission = false;

const REMOTE_DOWNLOAD_RETRY_LIMIT = 1;
const TRANSIENT_TRANSFER_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
]);

function isTransientTransferError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code || '')
      : '';
  if (TRANSIENT_TRANSFER_ERROR_CODES.has(code.toUpperCase())) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /(?:socket hang up|timed?\s*out|connection.+(?:closed|lost|reset)|server sent fin)/i.test(
    message
  );
}

export enum TransferDirection {
  LOCAL_TO_REMOTE = 'local ➞ remote',
  REMOTE_TO_LOCAL = 'remote ➞ local',
}

interface FileHandle {
  fsPath: string;
  fileSystem: FileSystem;
}

export interface TransferOption {
  atime: number;
  mtime: number;
  mode?: number;
  filePerm?: number;
  dirPerm?: number;
  fallbackMode?: number;
  perserveTargetMode: boolean;
  useTempFile?: boolean;
  openSsh?: boolean;
  backup?: BackupConfig;
  remotePath?: string;
  localBasePath?: string;
  backupPriority?: BackupPriority;
  onTransferSuccess?: () => Promise<void>;
  onTransferError?: (error: unknown) => Promise<void>;
}

export interface TransferWarning {
  failureId: 'backup.overwrite-failed';
  message: string;
}

export default class TransferTask implements Task {
  readonly fileType: FileType;
  private readonly _srcFsPath: string;
  private readonly _targetFsPath: string;
  private readonly _srcFs: FileSystem;
  private readonly _targetFs: FileSystem;
  private readonly _transferDirection: TransferDirection;
  private readonly _TransferOption: TransferOption;
  private _handle: Readable;
  private _cancelled: boolean;
  private readonly _warnings: TransferWarning[] = [];
  // private _fileStatus: FileStatus;

  constructor(
    src: FileHandle,
    target: FileHandle,
    option: {
      fileType: FileType;
      transferDirection: TransferDirection;
      transferOption: TransferOption;
    }
  ) {
    this._srcFsPath = src.fsPath;
    this._targetFsPath = target.fsPath;
    this._srcFs = src.fileSystem;
    this._targetFs = target.fileSystem;
    this._TransferOption = option.transferOption;
    this._transferDirection = option.transferDirection;
    this.fileType = option.fileType;
  }

  get localFsPath() {
    if (this._transferDirection === TransferDirection.REMOTE_TO_LOCAL) {
      return this._targetFsPath;
    } else {
      return this._srcFsPath;
    }
  }

  get srcFsPath() {
    return this._srcFsPath;
  }

  get targetFsPath() {
    return this._targetFsPath;
  }

  get transferType() {
    return this._transferDirection;
  }

  async run() {
    if (this._cancelled) {
      return;
    }
    if (isConflictStatePath(this.localFsPath)) {
      return;
    }
    try {
      const src = this._srcFsPath;
      const target = this._targetFsPath;
      const srcFs = this._srcFs;
      const targetFs = this._targetFs;
      switch (this.fileType) {
        case FileType.File:
          await this._transferFileWithRetry();
          break;
        case FileType.SymbolicLink: {
          const linkTarget = await this._source(() => srcFs.readlink(src));
          try {
            await this._target(() => targetFs.symlink(linkTarget, target));
          } catch (error) {
            const code =
              error && typeof error === 'object' && 'code' in error
                ? (error as { code?: unknown }).code
                : undefined;
            if (code !== 4 && code !== 'EEXIST') {
              throw error;
            }
          }
          break;
        }
        default:
          logger.warn(`Unsupported file type (type = ${this.fileType}). File ${src}`);
      }

      if (this._TransferOption.onTransferSuccess) {
        await this._TransferOption.onTransferSuccess();
      }
    } catch (error) {
      if (this._TransferOption.onTransferError) {
        await this._TransferOption.onTransferError(error);
      }
      throw error;
    }
  }

  cancel() {
    if (!this._cancelled) {
      this._cancelled = true;
    }
    if (this._handle) {
      FileSystem.abortReadableStream(this._handle);
    }
  }

  isCancelled(): boolean {
    return this._cancelled;
  }

  getWarnings(): readonly TransferWarning[] {
    return [...this._warnings];
  }

  private _sourcePathKind(): 'local' | 'remote' {
    return this._transferDirection === TransferDirection.LOCAL_TO_REMOTE
      ? 'local'
      : 'remote';
  }

  private _targetPathKind(): 'local' | 'remote' {
    return this._transferDirection === TransferDirection.LOCAL_TO_REMOTE
      ? 'remote'
      : 'local';
  }

  private _source<T>(operation: () => Promise<T>): Promise<T> {
    return withPathFailure(this._sourcePathKind(), operation);
  }

  private _target<T>(operation: () => Promise<T>): Promise<T> {
    return withPathFailure(this._targetPathKind(), operation);
  }

  private _recordBackupResult(result: BackupResult): void {
    if (result.status !== 'failed') {
      return;
    }
    this._warnings.push({
      failureId: 'backup.overwrite-failed',
      message:
        `Backup failed before overwriting ${this._targetFsPath}. ` +
        'The upload continued; the previous remote text content may not be recoverable.',
    });
  }

  private async _transferFileWithRetry() {
    let retryCount = 0;

    while (true) {
      try {
        await this._transferFile();
        return;
      } catch (error) {
        const canRetry =
          this._transferDirection === TransferDirection.REMOTE_TO_LOCAL &&
          !this._cancelled &&
          retryCount < REMOTE_DOWNLOAD_RETRY_LIMIT &&
          isTransientTransferError(error) &&
          // Real remote filesystems need the handler-level retry to clear the
          // cached client and reconnect. Replaying immediately on the same
          // broken control connection can hang (FTP) or fail deterministically
          // (SFTP). The local/mocked source path keeps the narrow stream retry.
          typeof (this._srcFs as FileSystem & { getClient?: unknown }).getClient !== 'function';
        if (!canRetry) {
          throw error;
        }

        retryCount += 1;
        logger.warn(
          `Retrying remote download after a transient connection error (${retryCount}/${REMOTE_DOWNLOAD_RETRY_LIMIT}): ${this._srcFsPath}`
        );
      }
    }
  }

  private async _transferFile() {
    const src = this._srcFsPath;
    const target = this._targetFsPath;
    const srcFs = this._srcFs;
    const targetFs = this._targetFs;
    const {
      perserveTargetMode,
      useTempFile,
      openSsh,
      fallbackMode,
      atime,
      mtime,
      filePerm
    } = this._TransferOption;
    // Create a backup of the existing remote file before overwriting it.
    if (
      this._transferDirection === TransferDirection.LOCAL_TO_REMOTE &&
      this.fileType === FileType.File &&
      this._TransferOption.backup &&
      this._TransferOption.backup.enabled &&
      this._TransferOption.backup.versions > 0 &&
      this._TransferOption.remotePath
    ) {
      let storage: BackupStorage | undefined;
      if (
        this._TransferOption.backup.location === 'local' &&
        this._TransferOption.localBasePath
      ) {
        storage = {
          fs: localFs,
          root: path.join(this._TransferOption.localBasePath, this._TransferOption.backup.folder),
          pathResolver: path,
        };
      }
      const backupResult = await createBackup(
        target,
        targetFs,
        this._TransferOption.backup,
        this._TransferOption.remotePath,
        storage,
        { priority: this._TransferOption.backupPriority }
      );
      this._recordBackupResult(backupResult);
    }

    // Set the mode if it's specified in the config, otherwise get mode from server.
    let mode = filePerm ? parseInt(String(filePerm), 8) : this._TransferOption.mode;
    let targetFd; // Existing destination handle used only to preserve mode.
    let uploadFd; // Staging file or destination file when no staging is used.
    let uploadFdClosed = false;
    let committed = false;
    const stageDownload =
      this._transferDirection === TransferDirection.REMOTE_TO_LOCAL;
    const useStagingFile = !!useTempFile || stageDownload;
    const uploadTarget = stageDownload
      ? `${target}.sftp-sync-${randomUUID()}.tmp`
      : target + (useTempFile ? '.new' : '');

    const closeUploadFd = async () => {
      if (uploadFd !== undefined && !uploadFdClosed) {
        uploadFdClosed = true;
        const remoteClient = (targetFs as FileSystem & {
          getClient?: () => { isClosed?: () => boolean };
        }).getClient?.();
        if (remoteClient?.isClosed?.()) {
          return;
        }
        await this._target(() => targetFs.close(uploadFd));
      }
    };

    try {
      // Use mode first. Then check perserveTargetMode and fall back to
      // fallbackMode if the existing target mode cannot be read.
      if (mode === undefined && perserveTargetMode) {
        if (useStagingFile) {
          [targetFd, uploadFd] = await Promise.all([
            this._target(() => targetFs.open(target, 'r')).catch(() => null),
            this._target(() => targetFs.open(uploadTarget, 'w')),
          ]);
        } else {
          targetFd = uploadFd = await this._target(() =>
            targetFs.open(uploadTarget, 'w')
          );
        }

        if (targetFd) {
          [this._handle, mode] = await Promise.all([
            this._source(() => srcFs.get(src)),
            this._target(() => targetFs.fstat(targetFd))
              .then(stat => stat.mode)
              .catch(() => fallbackMode),
          ]);
        } else {
          this._handle = await this._source(() => srcFs.get(src));
          mode = fallbackMode;
        }
      } else {
        [this._handle, uploadFd] = await Promise.all([
          this._source(() => srcFs.get(src)),
          this._target(() => targetFs.open(uploadTarget, 'w')),
        ]);
      }

      if (targetFd !== undefined && targetFd !== uploadFd) {
        await this._target(() => targetFs.close(targetFd));
        targetFd = undefined;
      }

      if (useTempFile) {
        logger.info("uploading temp file: " + uploadTarget);
      }
      await this._target(() =>
        targetFs.put(this._handle, uploadTarget, {
          mode,
          fd: uploadFd,
          autoClose: false,
        })
      );
      if (atime && mtime) {
        try {
          await this._target(() =>
            targetFs.futimes(
              uploadFd,
              Math.floor(atime / 1000),
              Math.floor(mtime / 1000)
            )
          );
        } catch (error) {
          if (!hasWarnedModifedTimePermission) {
            hasWarnedModifedTimePermission = true;
            logger.warn(
              `Can't set modified time to the file because ${error.message}`
            );
          }
        }
      }

      if (useStagingFile) {
        await closeUploadFd();
      }

      if (stageDownload) {
        await this._target(() => targetFs.renameAtomic(uploadTarget, target));
        committed = true;
      } else if (useTempFile) {
        logger.info("moving from: " + target + ".new" + " to: " + target);
        if(openSsh) {
          await this._target(() => targetFs.renameAtomic(uploadTarget, target));
        } else {
          try {
            await this._target(() => targetFs.unlink(target));
          } catch(error) {
            // Just ignore
          }
          await this._target(() => targetFs.rename(uploadTarget, target));
        }
        committed = true;
      }

    } finally {
      if (targetFd !== undefined && targetFd !== uploadFd) {
        await targetFs.close(targetFd).catch(() => {});
      }
      await closeUploadFd().catch(() => {});
      if (stageDownload && !committed) {
        await targetFs.unlink(uploadTarget).catch(() => {});
      }
    }
  }
}
