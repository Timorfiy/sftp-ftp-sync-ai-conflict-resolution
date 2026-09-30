import * as os from 'os';
import * as path from 'path';
import { pathRelativeToWorkspace, getWorkspaceFolders } from '../host';
import { localPathContains } from './localPaths';

export function simplifyPath(absolutePath: string) {
  return pathRelativeToWorkspace(absolutePath);
}

export function toRemotePath(localPath: string, localContext: string, remoteContext: string) {
  return path.posix.join(remoteContext, path.relative(localContext, localPath).split(path.sep).join(path.posix.sep));
}

export function toLocalPath(remotePath: string, remoteContext: string, localContext: string) {
  return path.join(localContext, path.posix.relative(remoteContext, remotePath).split(path.posix.sep).join(path.sep));
}

/**
 * Whether a remote (posix) path is `base` itself or sits below it.
 *
 * Unlike `isSubpathOf` this compares on path boundaries, so `/var/www` does not
 * match `/var/wwwroot`, and it never applies local platform separators to a
 * path that lives on the remote.
 */
export function isRemotePathAtOrUnder(base: string, candidate: string) {
  const normalizedBase = path.posix.normalize(base).replace(/\/+$/, '') || '/';
  const normalizedCandidate = path.posix.normalize(candidate).replace(/\/+$/, '') || '/';

  if (normalizedBase === normalizedCandidate) {
    return true;
  }

  const prefix = normalizedBase === '/' ? '/' : `${normalizedBase}/`;
  return normalizedCandidate.startsWith(prefix);
}

/**
 * Whether a local path is `base` itself or sits below it.
 *
 * Compares on path boundaries so `/src/app` does not match `/src/app-legacy`,
 * and folds case on the platforms whose filesystems are case-insensitive by
 * default.
 */
export function isLocalPathAtOrUnder(base: string, candidate: string) {
  return localPathContains(base, candidate);
}

export function isSubpathOf(possiableParentPath: string, pathname: string) {
  return localPathContains(possiableParentPath, pathname);
}

export function replaceHomePath(pathname: string) {
  return pathname.substr(0, 2) === '~/' ? path.join(os.homedir(), pathname.slice(2)) : pathname;
}

export function resolvePath(from: string, to: string) {
  return path.resolve(from, replaceHomePath(to));
}

export function isInWorkspace(filepath: string) {
  const workspaceFolders = getWorkspaceFolders();
  return (
    workspaceFolders &&
    workspaceFolders.some(
      folder => localPathContains(folder.uri.fsPath, filepath)
    )
  );
}
