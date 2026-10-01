import { Uri } from 'vscode';
import * as path from 'path';
import app from '../../app';
import logger from '../../logger';
import { UResource, FileService, TransferTask } from '../../core';
import { validateConfig } from '../config';
import watcherService from '../fileWatcher';
import { redact } from '../../security/redaction';
import {
  CredentialMigrationCandidate,
  credentialEndpointId,
  migrateLegacyCredentials,
} from '../secrets';
import Trie from './trie';
import { localPathKey, registerLocalPathRoot } from '../../helper/localPaths';

const WIN_DRIVE_REGEX = /^([a-zA-Z]):/;
const isWindows = process.platform === 'win32';

const serviceManager = new Trie<FileService>(
  {},
  {
    delimiter: path.sep,
  }
);

function normalizePathForTrie(pathname) {
  return localPathKey(pathname);
}

const servicePathPolicies = new WeakMap<FileService, () => void>();

export function getBasePath(context: string, workspace: string) {
  let dirpath;
  if (context) {
    if (path.isAbsolute(context)) {
      dirpath = context;
      if (isWindows) {
        const contextBeginWithDrive = context.match(WIN_DRIVE_REGEX);
        // if a windows user omit drive, we complete it with a drive letter same with the workspace one
        if (!contextBeginWithDrive) {
          const workspaceDrive = workspace.match(WIN_DRIVE_REGEX);
          if (workspaceDrive) {
            const drive = workspaceDrive[1];
            dirpath = path.join(`${drive}:`, context);
          }
        }
      }
    } else {
      // Don't use path.resolve bacause it may change the root dir of workspace!
      // Example: On window path.resove('\\a\\b\\c') will result to '<drive>:\\a\\b\\c'
      // We know workspace must be a absolute path and context is a relative path to workspace,
      // so path.join will suit our requirements.
      dirpath = path.join(workspace, context);
    }
  } else {
    dirpath = workspace;
  }

  // Preserve the actual spelling for filesystem I/O; folding is for trie keys.
  const normalized = path.normalize(dirpath);
  return isWindows ? normalized.replace(/^([A-Z]):/, (_match, drive) => `${drive.toLowerCase()}:`) : normalized;
}

export function createFileService(config: any, workspace: string) {
  const releasePathPolicy = registerLocalPathRoot(workspace);
  if (config.defaultProfile) {
    app.state.profile = config.defaultProfile;
  }

  const normalizedBasePath = getBasePath(config.context, workspace);
  const releaseBasePathPolicy = registerLocalPathRoot(normalizedBasePath);
  const service = new FileService(normalizedBasePath, workspace, config);
  servicePathPolicies.set(service, () => { releaseBasePathPolicy(); releasePathPolicy(); });

  logger.info(`config at ${normalizedBasePath}`, redact(config));

  serviceManager.add(normalizePathForTrie(normalizedBasePath), service);
  service.name = config.name;
  service.setConfigValidator(validateConfig);
  service.setWatcherService(watcherService);
  service.afterTransfer((error, task) => {
    if (error) logger.error(error, `when ${task.transferType} ${task.localFsPath}`);
    else logger.info(`${task.isCancelled() ? 'cancel transfer' : task.transferType} ${task.localFsPath}`);
  });

  return service;
}

export function getFileService(uri: Uri): FileService {
  let fileService;
  if (UResource.isRemote(uri)) {
    const remoteRoot = app.remoteExplorer.findRoot(uri);
    if (remoteRoot) {
      fileService = remoteRoot.explorerContext.fileService;
    }
  } else {
    fileService = serviceManager.findPrefix(normalizePathForTrie(uri.fsPath));
  }

  return fileService;
}

export function disposeFileService(fileService: FileService) {
  serviceManager.remove(normalizePathForTrie(fileService.baseDir));
  fileService.dispose();
  servicePathPolicies.get(fileService)?.();
  servicePathPolicies.delete(fileService);
}

export function findAllFileService(predictor: (x: FileService) => boolean): FileService[] {
  if (serviceManager === undefined) {
    return [];
  }

  return getAllFileService().filter(predictor);
}

export function getAllFileService(): FileService[] {
  if (serviceManager === undefined) {
    return [];
  }

  return serviceManager.getAllValues();
}

export function getCredentialMigrationCandidates(): CredentialMigrationCandidate[] {
  const candidates = new Map<string, CredentialMigrationCandidate>();
  for (const service of getAllFileService()) {
    for (const candidate of service.getCredentialMigrationCandidates()) {
      candidates.set(
        `${credentialEndpointId(candidate.endpoint)}\u0000${candidate.legacyHost}`,
        candidate
      );
    }
  }
  return [...candidates.values()];
}

export async function migrateLoadedServiceCredentials(): Promise<void> {
  await migrateLegacyCredentials(getCredentialMigrationCandidates());
}

export function getRunningTransformTasks(): TransferTask[] {
  return getAllFileService().reduce<TransferTask[]>((acc, fileService) => {
    return acc.concat(fileService.getPendingTransferTasks());
  }, []);
}
