import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { isLocalPathAtOrUnder } from '../helper/paths';

/**
 * Paths the file watcher should ignore because something else is handling them.
 *
 * An edit made inside VS Code reaches us twice: once through the event we act
 * on, and once through the FileSystemWatcher noticing the same write. Two
 * cases need that second signal dropped.
 *
 * - **Rename.** The watcher sees a rename as delete-then-create. Left alone it
 *   would undo or duplicate the server-side rename — at best re-uploading
 *   everything we just moved for free, at worst recursively deleting the remote
 *   folder before the rename runs, taking any remote-only files with it.
 * - **Save.** With `uploadOnSave` and `watcher.autoUpload` both on, a Ctrl+S
 *   uploads once from the save handler and again from the watcher.
 *
 * Both register their suppression on the corresponding `onWill…` event, i.e.
 * before the change reaches disk, so it is always in place before the watcher
 * can observe anything.
 *
 * Suppression is purely time-based rather than consumed by the first matching
 * event: a single write can produce more than one watcher event depending on
 * platform, and a consume-on-first-use marker would let the second through.
 */

// Generous next to the watcher's 550ms debounce: a large folder rename can
// trickle filesystem events out over several seconds.
const SUPPRESSION_TTL = 10 * 1000;

/**
 * A save writes one file, so its events arrive promptly. Kept short to narrow
 * the window in which a genuine external change to the same file is ignored.
 */
export const SAVE_SUPPRESSION_TTL = 2 * 1000;

// fsPath -> expiry timestamp. Entries are roots: everything below them is
// suppressed too, which is what makes folder renames work.
const suppressed = new Map<string, number>();

function sweep(now: number) {
  for (const [fsPath, expiresAt] of Array.from(suppressed.entries())) {
    if (expiresAt <= now) {
      suppressed.delete(fsPath);
    }
  }
}

/**
 * Ignore watcher events for `fsPath` and its descendants for a short while.
 * Calling it again for the same path extends the window.
 */
export function suppressWatcherFor(fsPath: string, ttl: number = SUPPRESSION_TTL) {
  const now = Date.now();
  sweep(now);
  suppressed.set(fsPath, now + ttl);
}

export function isWatcherSuppressed(fsPath: string): boolean {
  const now = Date.now();
  sweep(now);

  for (const root of suppressed.keys()) {
    if (isLocalPathAtOrUnder(root, fsPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Release a suppression early, so the watcher takes over again. Used when a
 * remote rename fails and the normal upload path has to pick up the slack.
 */
export function releaseWatcherSuppression(fsPath: string) {
  suppressed.delete(fsPath);
}

// Testing seam.
export function _reset() {
  suppressed.clear();
  downloadWatchers.clear();
  downloaded.clear();
  clearInterval(downloadSweep);
  sweepIterator = downloaded.keys();
}

// A download claim describes bytes, not a time window or a running task. Keep
// one version per existing downloaded path in an active watcher. Repeated
// downloads replace it; edits, deletion and watcher disposal release it. Do
// not expire/evict unchanged versions: late OS events have no upper time bound.
const downloadWatchers = new Set<string>();
const downloaded = new Map<string, Promise<string | undefined>>();
let downloadSweep: ReturnType<typeof setInterval>;
let sweepIterator = downloaded.keys();
let sweeping = false;

function downloadKey(fsPath: string) {
  const normalized = path.resolve(fsPath);
  return process.platform === 'linux' ? normalized : normalized.toLowerCase();
}

function isDownloadWatched(fsPath: string) {
  return [...downloadWatchers].some(root => isLocalPathAtOrUnder(root, fsPath));
}

export function registerDownloadWatcher(root: string) {
  downloadWatchers.add(downloadKey(root));
  if (downloadWatchers.size === 1) {
    // One bounded sweep for all watchers, including deletes excluded by globs.
    downloadSweep = setInterval(() => void sweepDownloadedPaths(), 1000);
    downloadSweep.unref();
  }
}

export function releaseDownloadWatcher(root: string) {
  downloadWatchers.delete(downloadKey(root));
  for (const key of downloaded.keys()) {
    if (!isDownloadWatched(key)) {
      downloaded.delete(key);
    }
  }
  if (!downloadWatchers.size) {
    clearInterval(downloadSweep);
  }
}

async function sweepDownloadedPaths() {
  if (sweeping) {
    return;
  }
  sweeping = true;
  try {
    // Fixed work per tick; no full-map scan per file/event and no per-file timer.
    for (let count = 0; count < 128; count++) {
      const next = sweepIterator.next();
      if (next.done) {
        sweepIterator = downloaded.keys();
        break;
      }
      const claim = downloaded.get(next.value);
      await claim;
      try {
        await fs.promises.lstat(next.value);
      } catch (error) {
        if (error.code === 'ENOENT' && downloaded.get(next.value) === claim) {
          downloaded.delete(next.value);
        }
      }
    }
  } finally {
    sweeping = false;
  }
}

async function fingerprint(fsPath: string): Promise<string> {
  const stat = await fs.promises.lstat(fsPath);
  if (stat.isDirectory()) {
    // Child writes change directory timestamps, but do not make this a new dir.
    return `dir:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  }
  if (stat.isSymbolicLink()) {
    return `link:${await fs.promises.readlink(fsPath)}`;
  }
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(fsPath)) {
    hash.update(chunk);
  }
  const after = await fs.promises.lstat(fsPath);
  if (stat.ino !== after.ino || stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
    return 'changed-during-read';
  }
  return `file:${hash.digest('hex')}`;
}

/** Publish the staged version before rename can produce any watcher event. */
export async function commitDownload(
  target: string,
  staged: string,
  commit: () => Promise<void>
) {
  return commitDownloadVersion(target, () => fingerprint(staged), commit);
}

export async function createDownloadSymlink(
  target: string,
  link: string,
  create: () => Promise<void>
) {
  return commitDownloadVersion(target, async () => `link:${link}`, create);
}

async function commitDownloadVersion(
  target: string,
  expected: () => Promise<string>,
  commit: () => Promise<void>
) {
  if (!isDownloadWatched(target)) {
    return commit();
  }
  const key = downloadKey(target);
  const previous = downloaded.get(key);
  // Serialize only commits to the same path, including overlapping profiles.
  let finish: (version: string | undefined) => void;
  const claim = new Promise<string | undefined>(resolve => { finish = resolve; });
  downloaded.set(key, claim);
  let version = await previous;
  try {
    const stagedVersion = await expected();
    await commit();
    version = stagedVersion;
  } finally {
    finish!(version);
    if (!version && downloaded.get(key) === claim) {
      downloaded.delete(key);
    }
  }
}

/** Claim only directories actually missing, never their descendants. */
export async function createDownloadDirectory(dir: string, create: () => Promise<void>) {
  const missing: string[] = [];
  for (let current = dir; isDownloadWatched(current); current = path.dirname(current)) {
    try {
      await fs.promises.lstat(current);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      missing.push(current);
    }
  }
  const createNext = async (index: number): Promise<void> => {
    if (index === missing.length) {
      return create();
    }
    const key = downloadKey(missing[index]);
    let finish: (version: string | undefined) => void;
    const claim = new Promise<string | undefined>(resolve => { finish = resolve; });
    downloaded.set(key, claim);
    try {
      await createNext(index + 1);
    } finally {
      const version = await fingerprint(missing[index]).catch(() => undefined);
      finish!(version);
      if (!version && downloaded.get(key) === claim) {
        downloaded.delete(key);
      }
    }
  };
  await createNext(0);
}

export function isDownloadTemporaryPath(fsPath: string) {
  return /\.sftp-sync-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(fsPath);
}

export async function isDownloadWatcherSuppressed(fsPath: string): Promise<boolean> {
  if (isDownloadTemporaryPath(fsPath)) {
    return true;
  }
  const key = downloadKey(fsPath);
  let claim = downloaded.get(key);
  while (claim) {
    const expected = await claim;
    const actual = await fingerprint(fsPath).catch(error => {
      if (error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (downloaded.get(key) !== claim) {
      claim = downloaded.get(key);
      continue;
    }
    if (expected && expected === actual && actual !== 'changed-during-read') {
      return true;
    }
    downloaded.delete(key);
    return false;
  }
  return false;
}

export const _downloadSuppressionState = () => ({
  paths: downloaded.size,
  watchers: downloadWatchers.size,
});
