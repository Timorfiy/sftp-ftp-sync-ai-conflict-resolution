import * as path from 'path';
import { legacyConflictRoot } from './conflictStateStore';
import { localPathContains, registerLocalPathRoot } from '../../helper/localPaths';

let globalStateRoot: string | undefined;
let workspaceRoots: string[] = [];
let releasePathRoots: (() => void)[] = [];

function isSameOrDescendant(candidate: string, root: string): boolean {
  return localPathContains(root, candidate);
}

export function configureConflictStateIsolation(
  stateRoot: string,
  workspaces: readonly string[]
): void {
  clearConflictStateIsolation();
  globalStateRoot = path.resolve(stateRoot);
  workspaceRoots = workspaces.map(workspace => path.resolve(workspace));
  releasePathRoots = [globalStateRoot, ...workspaceRoots].map(registerLocalPathRoot);
}

export function clearConflictStateIsolation(): void {
  releasePathRoots.forEach(release => release());
  releasePathRoots = [];
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
