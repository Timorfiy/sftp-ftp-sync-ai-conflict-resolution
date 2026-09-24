import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import debounce from 'lodash.debounce';
import logger from '../logger';
import { isValidFile, fileDepth } from '../helper';
import { upload, removeRemote } from '../fileHandlers';
import { WatcherService } from '../core';
import app from '../app';
import StatusBarItem from '../ui/statusBarItem';
import {
  isWatcherSuppressed,
  isDownloadTemporaryPath,
  isDownloadWatcherSuppressed,
  registerDownloadWatcher,
  releaseDownloadWatcher,
} from './watcherSuppression';
import { isLocalPathAtOrUnder } from '../helper/paths';
import { isConflictPathActive } from '../fileHandlers/transfer/conflictBridge';

const watchers: {
  [x: string]: vscode.FileSystemWatcher;
} = {};

// Keyed by fsPath, not by Uri: every watcher event carries a fresh Uri object,
// so a Set would compare by reference and queue the same file more than once.
const uploadQueue = new Map<string, { uri: vscode.Uri; ignore?: (fsPath: string) => boolean }>();
const deleteQueue = new Map<string, vscode.Uri>();

// less than 550 will not work
const ACTION_INTEVAL = 550;

function isWatched(fsPath: string) {
  return Object.keys(watchers).some(root => isLocalPathAtOrUnder(root, fsPath));
}

let uploadDrain: Promise<void> | undefined;
let deleteDrain: Promise<void> | undefined;

function doUpload() {
  if (!uploadDrain) {
    uploadDrain = drainUploads().finally(() => {
      uploadDrain = undefined;
      if (uploadQueue.size) {
        debouncedUpload();
      }
    });
  }
  return uploadDrain;
}

function reportWatcherError(error: Error, action: string, fsPath: string) {
  logger.error(error, `${action} ${fsPath}`);
  app.sftpBarItem.updateStatus(StatusBarItem.Status.error);
}

async function drainUploads() {
  const files = Array.from(uploadQueue.values()).sort(
    (a, b) => fileDepth(b.uri.fsPath) - fileDepth(a.uri.fsPath)
  );
  uploadQueue.clear();

  for (const { uri, ignore } of files) {
    const fspath = uri.fsPath;
    try {
      if (!isWatched(fspath) || isWatcherSuppressed(fspath) || isConflictPathActive(fspath)) {
        continue;
      }
      const stat = await fs.promises.lstat(fspath);
      if (stat.isDirectory()) {
        // OS watchers may report only the parent, or report both parent and
        // children. Never recursively upload a directory without checking each
        // descendant: that bypasses all per-file download/conflict claims.
        const children = await fs.promises.readdir(fspath);
        if (children.length) {
          for (const name of children) {
            uploadHandler(vscode.Uri.file(path.join(fspath, name)), ignore);
          }
          continue;
        }
      }
      // Recheck at dispatch: a queued event may outlive its transfer, or an
      // editor save/conflict claim may have appeared during the debounce.
      if (await isDownloadWatcherSuppressed(fspath) ||
          !isWatched(fspath) || isWatcherSuppressed(fspath) || isConflictPathActive(fspath)) {
        continue;
      }
      logger.info(`[watcher/updated] ${fspath}`);
      // Transfers have their own scheduler. A conflict waiting for a user in
      // one project must not stop watcher dispatch in every other project.
      void upload(uri).catch(error => reportWatcherError(error, 'upload', fspath));
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      reportWatcherError(error, 'upload', fspath);
    }
  }
}

function doDelete() {
  if (!deleteDrain) {
    deleteDrain = drainDeletes().finally(() => {
      deleteDrain = undefined;
      if (deleteQueue.size) {
        debouncedDelete();
      }
    });
  }
  return deleteDrain;
}

async function drainDeletes() {
  const files = Array.from(deleteQueue.values()).sort(
    (a, b) => fileDepth(b.fsPath) - fileDepth(a.fsPath)
  );
  deleteQueue.clear();
  for (const uri of files) {
    const fspath = uri.fsPath;
    try {
      if (await isDownloadWatcherSuppressed(fspath) ||
          !isWatched(fspath) || isWatcherSuppressed(fspath)) {
        continue;
      }
      logger.info(`[watcher/removed] ${fspath}`);
      void removeRemote(uri).catch(error => reportWatcherError(error, 'remove', fspath));
    } catch (error) {
      reportWatcherError(error, 'remove', fspath);
    }
  }
}

const debouncedUpload = debounce(doUpload, ACTION_INTEVAL, { leading: true, trailing: true });
const debouncedDelete = debounce(doDelete, ACTION_INTEVAL, { leading: true, trailing: true });

function uploadHandler(uri: vscode.Uri, ignore?: (fsPath: string) => boolean) {
  if (!isValidFile(uri)) {
    return;
  }
  if (isDownloadTemporaryPath(uri.fsPath)) {
    return;
  }

  if (ignore && ignore(uri.fsPath)) {
    return;
  }
  if (isConflictPathActive(uri.fsPath)) {
    logger.trace(`[watcher/updated] skipped (active conflict) ${uri.fsPath}`);
    return;
  }

  // Either a rename is already moving this path on the server, or uploadOnSave
  // is about to upload it. Both would turn into a redundant second upload.
  if (isWatcherSuppressed(uri.fsPath)) {
    logger.trace(`[watcher/updated] skipped (handled elsewhere) ${uri.fsPath}`);
    return;
  }

  uploadQueue.set(uri.fsPath, { uri, ignore });
  debouncedUpload();
}

function addWatcher(id, watcher) {
  watchers[id] = watcher;
}

function getWatcher(id) {
  return watchers[id];
}

function createWatcher(
  watcherBase: string,
  watcherConfig: { files: false | string; autoUpload: boolean; autoDelete: boolean },
  ignore?: (fsPath: string) => boolean
) {
  // Clear any old watcher. Drop it from the table too: switching to a profile
  // that disables watching returns early below, and a disposed watcher left
  // behind would be handed out again on the next lookup.
  removeWatcher(watcherBase);

  if (!watcherConfig) {
    return;
  }

  const shouldAddListenser = watcherConfig.autoUpload || watcherConfig.autoDelete;
  // tslint:disable-next-line triple-equals
  if (watcherConfig.files == false || !shouldAddListenser) {
    return;
  }

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(watcherBase, watcherConfig.files),
    false,
    false,
    false
  );
  addWatcher(watcherBase, watcher);
  registerDownloadWatcher(watcherBase);

  if (watcherConfig.autoUpload) {
    watcher.onDidCreate(uri => uploadHandler(uri, ignore));
    watcher.onDidChange(uri => uploadHandler(uri, ignore));
  }

  if (watcherConfig.autoDelete) {
    watcher.onDidDelete(uri => {
      if (!isValidFile(uri)) {
        return;
      }
      if (isDownloadTemporaryPath(uri.fsPath)) {
        return;
      }

      if (ignore && ignore(uri.fsPath)) {
        return;
      }

      // The old path of a rename shows up here as a plain delete. Acting on it
      // would recursively remove the remote folder the rename is about to move
      // (or has already moved), destroying any remote-only files inside it.
      if (isWatcherSuppressed(uri.fsPath)) {
        logger.trace(`[watcher/removed] skipped (handled elsewhere) ${uri.fsPath}`);
        return;
      }

      deleteQueue.set(uri.fsPath, uri);
      debouncedDelete();
    });
  }
}

function removeWatcher(watcherBase: string) {
  const watcher = getWatcher(watcherBase);
  if (watcher) {
    watcher.dispose();
    delete watchers[watcherBase];
    releaseDownloadWatcher(watcherBase);
    for (const queue of [uploadQueue, deleteQueue]) {
      for (const fsPath of queue.keys()) {
        if (isLocalPathAtOrUnder(watcherBase, fsPath)) {
          queue.delete(fsPath);
        }
      }
    }
  }
}

const watcherService: WatcherService = {
  create: createWatcher,
  dispose: removeWatcher,
};

export default watcherService;

// Testing seam: drain the real debounce queues without sleeping per file.
export async function _flushWatcherQueues() {
  do {
    debouncedUpload.cancel();
    debouncedDelete.cancel();
    await Promise.all([doUpload(), doDelete()]);
  } while (uploadQueue.size || deleteQueue.size || uploadDrain || deleteDrain);
}
