import * as path from 'path';
import { legacyConflictRoot } from './conflictStateStore';

let globalStateRoot: string | undefined;
let workspaceRoots: string[] = [];

function normalize(candidate: string): string {
  let normalized = path.resolve(candidate);
  if (process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(normalized)) {
    normalized = normalized.replace(/\//g, '\\').toLocaleLowerCase('en-US');
  }
  return normalized;
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function configureConflictStateIsolation(
  stateRoot: string,
  workspaces: readonly string[]
): void {
  globalStateRoot = path.resolve(stateRoot);
  workspaceRoots = workspaces.map(workspace => path.resolve(workspace));
}

export function clearConflictStateIsolation(): void {
  globalStateRoot = undefined;
  workspaceRoots = [];
}

export function isConflictStatePath(candidate: string): boolean {
  if (!candidate) {
    return false;
  }
  if (globalStateRoot && isSameOrDescendant(candidate, globalStateRoot)) {
    return true;
  }
  return workspaceRoots.some(workspace =>
    isSameOrDescendant(candidate, legacyConflictRoot(workspace))
  );
}

export function isConflictStatePathOrAncestor(candidate: string): boolean {
  if (isConflictStatePath(candidate)) {
    return true;
  }
  if (globalStateRoot && isSameOrDescendant(globalStateRoot, candidate)) {
    return true;
  }
  return workspaceRoots.some(workspace =>
    isSameOrDescendant(legacyConflictRoot(workspace), candidate)
  );
}

export function conflictStateIgnore(candidate: string): boolean {
  return isConflictStatePath(candidate);
}
