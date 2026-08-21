import {
  FileSystem,
  FileEntry,
  FileType,
  TransferTask,
  TransferOption as TransferTaskTransferOption,
  TransferDirection,
  fileOperations,
} from '../../core';
import { FileHandleOption } from '../option';
import { flatten } from '../../utils';
import logger from '../../logger';
import { getOpenTextDocuments } from '../../host';

export interface FileTransferContext {
  srcFsPath: string;
  targetFsPath: string;
  srcFs: FileSystem;
  targetFs: FileSystem;
  fileType: FileType;
  transferDirection: TransferDirection;
  sourceMtime: number;
  sourceSize: number;
  conflictOverwrite?: boolean;
}

export interface TransferLifecycleOption {
  beforeFileTransfer?: (context: FileTransferContext) => Promise<void>;
  afterFileTransfer?: (context: FileTransferContext) => Promise<void>;
}

interface InternalTransferOption
  extends FileHandleOption,
    TransferTaskTransferOption,
    TransferLifecycleOption {
  sourceSize?: number;
}

type ExternalTransferOption<T extends InternalTransferOption> = Pick<
  T,
  Exclude<
    keyof T,
    | 'mtime'
    | 'atime'
    | 'mode'
    | 'fallbackMode'
    | 'sourceSize'
    | 'backupPriority'
    | 'onTransferSuccess'
  >
>;

type TransferOption = ExternalTransferOption<InternalTransferOption>;
interface SyncOption extends TransferOption {
  // delete extraneous files from dest dirs
  delete?: boolean;

  // skip creating new files on dest
  skipCreate?: boolean;

  // skip updating files that exist on dest
  ignoreExisting?: boolean;

  // update the dest only if a newer version is on the src filesystem
  update?: boolean;

  // make newest file to be present in both locations.
  bothDiretions?: boolean;
}

let hasWarnedUnknownMtimeDuringSync = false;

interface BaseTransferHandleConfig {
  srcFsPath: string;
  targetFsPath: string;
  dirPerm?: number,
  filePerm?: number,
  srcFs: FileSystem;
  targetFs: FileSystem;
  transferDirection: TransferDirection;
}

interface TransferHandleConfig<T> extends BaseTransferHandleConfig {
  transferOption: T;
}

function getAltDirection(direction: TransferDirection) {
  return direction === TransferDirection.LOCAL_TO_REMOTE
    ? TransferDirection.REMOTE_TO_LOCAL
    : TransferDirection.LOCAL_TO_REMOTE;
}

function isFileModified(a: FileEntry, b: FileEntry): boolean {
  // compare time at seconds
  return Math.floor(a.mtime / 1000) !== Math.floor(b.mtime / 1000) || a.size !== b.size;
}

async function ensureAccurateFileEntry<T extends FileEntry>(entry: T, fs: FileSystem): Promise<T> {
  if (entry.type !== FileType.File) {
    return entry;
  }
  const accurateEntry = await fs.ensureAccurateMtime(entry);
  return {
    ...entry,
    ...accurateEntry,
  };
}

function toHash<T, R = T>(items: T[], key: string, transform?: (a: T) => R): { [key: string]: R } {
  return items.reduce((hash, item) => {
    const transformedItem = transform ? transform(item) : item;
    hash[transformedItem[key]] = transformedItem;
    return hash;
  }, {});
}

async function transferFolder(
  config: TransferHandleConfig<TransferOption>,
  collect: (t: TransferTask) => void
) {
  const { srcFsPath, targetFsPath, srcFs, targetFs, transferOption } = config;

  if (transferOption.ignore && transferOption.ignore(srcFsPath)) {
    return;
  }

  // Need this to make sure file can correct transfer
  await targetFs.ensureDir(targetFsPath);

  // If dirPerm is configured, we chmod the remote directory after creation.
  if(config.transferOption.dirPerm) {
    logger.info("chmod remote directory as configured by dirPerm, dirPerm is: ", config.transferOption.dirPerm)
    await targetFs.chmod(targetFsPath, parseInt(String(config.transferOption.dirPerm), 8))
  }

  const fileEntries = await srcFs.list(srcFsPath);
  await Promise.all(
    fileEntries.map(async file => {
      const accurateFile = await ensureAccurateFileEntry(file, srcFs);
      return transferWithType(
        {
          ...config,
          transferOption: {
            ...config.transferOption,
            mtime: accurateFile.mtime,
            atime: accurateFile.atime,
            sourceSize: accurateFile.size,
          },
          srcFsPath: accurateFile.fspath,
          targetFsPath: targetFs.pathResolver.join(targetFsPath, accurateFile.name),
          ensureDirExist: false,
        },
        accurateFile.type,
        collect
      );
    })
  );

  logger.info('folder transfered.');
}

async function transferFile(
  config: TransferHandleConfig<InternalTransferOption>,
  fileType: FileType,
  collect: (t: TransferTask) => void
) {
  if (config.transferOption.ignore && config.transferOption.ignore(config.srcFsPath)) {
    return;
  }

  const lifecycleContext: FileTransferContext = {
    srcFsPath: config.srcFsPath,
    targetFsPath: config.targetFsPath,
    srcFs: config.srcFs,
    targetFs: config.targetFs,
    fileType,
    transferDirection: config.transferDirection,
    sourceMtime: config.transferOption.mtime || 0,
    sourceSize: config.transferOption.sourceSize || 0,
  };

  if (config.transferOption.beforeFileTransfer) {
    await config.transferOption.beforeFileTransfer(lifecycleContext);
  }

  const transferOption = {
    ...config.transferOption,
    backupPriority: lifecycleContext.conflictOverwrite ? 'conflict' as const : 'normal' as const,
    onTransferSuccess: config.transferOption.afterFileTransfer
      ? () => config.transferOption.afterFileTransfer!(lifecycleContext)
      : undefined,
  };

  collect(
    new TransferTask(
      {
        fsPath: config.srcFsPath,
        fileSystem: config.srcFs,
      },
      {
        fsPath: config.targetFsPath,
        fileSystem: config.targetFs,
      },
      {
        fileType,
        transferDirection: config.transferDirection,
        transferOption,
      }
    )
  );
}

async function transferWithType(
  config: TransferHandleConfig<InternalTransferOption> & {
    ensureDirExist: boolean;
  },
  fileType: FileType,
  collect: (t: TransferTask) => void
) {
  switch (fileType) {
    case FileType.Directory:
      await transferFolder(config, collect);
      break;
    case FileType.File:
    case FileType.SymbolicLink:
      if (config.ensureDirExist) {
        const { targetFs, targetFsPath } = config;
        await targetFs.ensureDir(targetFs.pathResolver.dirname(targetFsPath));
        // If dirPerm is configured, we chmod the remote directory after creation.
        if(config.transferOption.dirPerm) {
          logger.info("Running chmod on remote directory with perm: ", config.transferOption.dirPerm)
          await targetFs.chmod(targetFs.pathResolver.dirname(targetFsPath), parseInt(String(config.transferOption.dirPerm), 8));
        }
      }
      // <<< save before upload: start
      if (config.transferDirection === TransferDirection.LOCAL_TO_REMOTE) {
        const textDocuments = getOpenTextDocuments();
        const document = textDocuments.find(doc => doc.fileName === config.srcFsPath);
        if (document && !document.isClosed && document.isDirty) {
          await document.save();
          // Update mtime after file was saved
          const stat = await config.srcFs.lstat(config.srcFsPath);
          config.transferOption.mtime = stat.mtime;
          config.transferOption.sourceSize = stat.size;
          logger.info('save before upload.');
        }
      }
      // save before upload: end >>>
      await transferFile(config, fileType, collect);
      break;
    default:
      logger.warn(`Unsupported file type (type = ${fileType}). File ${config.srcFsPath}`);
  }
}

async function removeFile(
  file: string,
  fs: FileSystem,
  fileType: FileType,
  option,
  direction: TransferDirection
) {
  if (option.ignore && option.ignore(file)) {
    return;
  }

  // Deletions target the receiving side, which is local when syncing
  // remote ➞ local. Label it so the log is not misleading.
  const side =
    direction === TransferDirection.LOCAL_TO_REMOTE ? 'remote' : 'local';

  switch (fileType) {
    case FileType.Directory:
      await fileOperations.removeDir(file, fs, option);
      logger.info(`${side} folder removed: ${file}`);
      break;
    case FileType.File:
    case FileType.SymbolicLink:
      await fileOperations.removeFile(file, fs, option);
      logger.info(`${side} file removed: ${file}`);
      break;
    default:
      break;
  }
}

async function _sync(
  config: TransferHandleConfig<SyncOption>,
  collect: (t: TransferTask) => void,
  deleted: FileEntry[]
) {

  const { srcFsPath, targetFsPath, srcFs, targetFs, transferOption, transferDirection } = config;
  if (transferOption.ignore && transferOption.ignore(srcFsPath)) {
    return;
  }

  const altDirection = getAltDirection(transferDirection);
  const syncFiles = async (srcFileEntries: FileEntry[], desFileEntries: FileEntry[]) => {
    const srcFileTable = toHash(srcFileEntries, 'id', fileEntry => ({
      ...fileEntry,
      id: fileEntry.name,
    }));

    const desFileTable = toHash(desFileEntries, 'id', fileEntry => ({
      ...fileEntry,
      id: fileEntry.name,
    }));

    const file2trans: [string, string, TransferDirection, InternalTransferOption][] = [];
    const dir2trans: [string, string, TransferDirection][] = [];
    const dir2sync: [string, string][] = [];

    const fileMissed: string[] = [];
    const dirMissed: string[] = [];

    for (const id of Object.keys(srcFileTable)) {
      let srcFile = srcFileTable[id];
      let desFile = desFileTable[id];
      delete desFileTable[id];

      // files exist on both side
      if (desFile) {
        if (transferOption.ignoreExisting) {
          continue;
        }

        [srcFile, desFile] = await Promise.all([
          ensureAccurateFileEntry(srcFile, srcFs),
          ensureAccurateFileEntry(desFile, targetFs),
        ]);

        let from: FileEntry = srcFile;
        let to: FileEntry = desFile;
        let direction: TransferDirection = transferDirection;
        switch (from.type) {
          case FileType.Directory:
            dir2sync.push([from.fspath, to.fspath]);
            break;
          case FileType.File:
          case FileType.SymbolicLink:
            if (transferOption.bothDiretions) {
              // from new to old
              if (desFile.mtime > srcFile.mtime) {
                from = desFile;
                to = srcFile;
                direction = altDirection;
              }
            }

            if (transferOption.update) {
              const hasAccurateTimes = from.mtime > 0 && to.mtime > 0;
              if (hasAccurateTimes && from.mtime <= to.mtime) {
                continue;
              }
              if (!hasAccurateTimes) {
                if (!hasWarnedUnknownMtimeDuringSync) {
                  hasWarnedUnknownMtimeDuringSync = true;
                  logger.warn(
                    'Exact modification time is unavailable during sync; update comparison falls back to file size.'
                  );
                }
                if (from.size === to.size) {
                  continue;
                }
              }
            }

            // only transfer changed files
            if (isFileModified(from, to)) {
              file2trans.push([
                from.fspath,
                to.fspath,
                direction,
                {
                  ...transferOption,
                  mode: to.mode, // prefer target mode
                  mtime: from.mtime,
                  atime: from.atime,
                  sourceSize: from.size,
                },
              ]);
            }
            break;
          default:
          // do not process
        }
        continue;
      }

      // files exist only on src
      if (transferOption.skipCreate) {
        continue;
      }

      srcFile = await ensureAccurateFileEntry(srcFile, srcFs);

      const fspath = targetFs.pathResolver.join(targetFsPath, srcFile.name);
      switch (srcFile.type) {
        case FileType.Directory:
          dir2trans.push([srcFile.fspath, fspath, transferDirection]);
          break;
        case FileType.File:
        case FileType.SymbolicLink:
          file2trans.push([
            srcFile.fspath,
            fspath,
            transferDirection,
            {
              ...transferOption,
              fallbackMode: srcFile.mode,
              mtime: srcFile.mtime,
              atime: srcFile.atime,
              sourceSize: srcFile.size,
            },
          ]);
          break;
        default:
        // do not process
      }
    }

    // files exist only on target
    if (transferOption.bothDiretions) {
      if (transferOption.skipCreate !== true) {
        Object.keys(desFileTable).forEach(id => {
          const file = desFileTable[id];
          const fspath = srcFs.pathResolver.join(srcFsPath, file.name);
          switch (file.type) {
            case FileType.Directory:
              dir2trans.push([file.fspath, fspath, altDirection]);
              break;
            case FileType.File:
            case FileType.SymbolicLink:
              file2trans.push([
                file.fspath,
                fspath,
                altDirection,
                {
                  ...transferOption,
                  fallbackMode: file.mode,
                  mtime: file.mtime,
                  atime: file.atime,
                  sourceSize: file.size,
                },
              ]);
              break;
            default:
            // do not process
          }
        });
      }
    } else if (transferOption.delete) {
      Object.keys(desFileTable).forEach(id => {
        const file = desFileTable[id];
        deleted.push(file);
        switch (file.type) {
          case FileType.Directory:
            dirMissed.push(file.fspath);
            break;
          case FileType.File:
          case FileType.SymbolicLink:
            fileMissed.push(file.fspath);
            break;
          default:
          // do not process
        }
      });
    }

    // side-effect
    await Promise.all(
      fileMissed.map(file =>
        removeFile(file, targetFs, FileType.File, transferOption, transferDirection)
      )
    );
    await Promise.all(
      dirMissed.map(file =>
        removeFile(file, targetFs, FileType.Directory, transferOption, transferDirection)
      )
    );

    const transFilePromise = file2trans.map(([src, target, direction, option]) => {
      const isReversed = direction === altDirection;
      return transferFile(
        {
          ...config,
          srcFs: isReversed ? config.targetFs : config.srcFs,
          targetFs: isReversed ? config.srcFs : config.targetFs,
          transferDirection: direction,
          transferOption: option,
          srcFsPath: src,
          targetFsPath: target,
        },
        FileType.File,
        collect
      );
    });

    const transDirPromise = dir2trans.map(([src, target, direction]) => {
      const isReversed = direction === altDirection;
      return transferFolder(
        {
          ...config,
          srcFs: isReversed ? config.targetFs : config.srcFs,
          targetFs: isReversed ? config.srcFs : config.targetFs,
          transferDirection: direction,
          srcFsPath: src,
          targetFsPath: target,
        },
        collect
      );
    });

    const syncPromise = dir2sync.map(([src, target]) =>
      _sync(
        {
          ...config,
          srcFsPath: src,
          targetFsPath: target,
        },
        collect,
        deleted
      )
    );

    return Promise.all([...transFilePromise, ...transDirPromise, ...syncPromise]).then(flatten);
  };

  // create dir here so we don't have to ensure it for children files.
  await targetFs.ensureDir(targetFsPath);

  const files = await Promise.all([
    srcFs.list(srcFsPath).catch(() => []),
    targetFs.list(targetFsPath).catch(() => []),
  ]);
  await syncFiles(...files);
}

export { TransferOption, SyncOption, TransferDirection };

export async function transfer(
  config: TransferHandleConfig<TransferOption>,
  collect: (t: TransferTask) => void
) {
  const stat = await config.srcFs.lstat(config.srcFsPath);
  const transferOption = {
    ...config.transferOption,
    fallbackMode: stat.mode,
    mtime: stat.mtime,
    atime: stat.atime,
    sourceSize: stat.size,
    filePerm: config?.filePerm,
    dirPerm: config?.dirPerm
  };
  await transferWithType({ ...config, transferOption, ensureDirExist: true }, stat.type, collect);
}

export async function sync(
  config: TransferHandleConfig<SyncOption>,
  collect: (t: TransferTask) => void
): Promise<FileEntry[]> {
  const deleted: FileEntry[] = [];
  await _sync(config, collect, deleted);
  return deleted;
}
