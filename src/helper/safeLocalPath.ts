import * as fs from 'fs';
import * as path from 'path';

export type SafeLocalPathFailure =
  | 'outside_root'
  | 'symbolic_component'
  | 'unavailable'
  | 'unsupported_type';

export class SafeLocalPathError extends Error {
  constructor(readonly reason: SafeLocalPathFailure) {
    super(reason);
  }
}

function pathKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function isSameOrDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(pathKey(root), pathKey(candidate));
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function lstat(file: string): Promise<fs.Stats> {
  try {
    return await fs.promises.lstat(file);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new SafeLocalPathError('unavailable');
    }
    throw error;
  }
}

export async function requireSafeLocalPath(
  root: string,
  candidate: string,
  options: {
    allowMissingLeaf?: boolean;
    type?: 'file' | 'directory';
  } = {}
): Promise<fs.Stats | undefined> {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (!isSameOrDescendant(resolvedCandidate, resolvedRoot)) {
    throw new SafeLocalPathError('outside_root');
  }

  const rootStat = await lstat(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new SafeLocalPathError(
      rootStat.isSymbolicLink() ? 'symbolic_component' : 'unsupported_type'
    );
  }
  const canonicalRoot = await fs.promises.realpath(resolvedRoot);
  let current = resolvedRoot;
  let candidateStat: fs.Stats | undefined = rootStat;
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  const components = relative === '' ? [] : relative.split(path.sep);

  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    try {
      candidateStat = await fs.promises.lstat(current);
    } catch (error: any) {
      if (error?.code === 'ENOENT' && options.allowMissingLeaf) {
        return undefined;
      }
      if (error?.code === 'ENOENT') {
        throw new SafeLocalPathError('unavailable');
      }
      throw error;
    }
    if (candidateStat.isSymbolicLink()) {
      throw new SafeLocalPathError('symbolic_component');
    }
  }

  const canonicalCandidate = await fs.promises.realpath(resolvedCandidate);
  if (!isSameOrDescendant(canonicalCandidate, canonicalRoot)) {
    throw new SafeLocalPathError('outside_root');
  }
  if (
    (options.type === 'file' && !candidateStat?.isFile()) ||
    (options.type === 'directory' && !candidateStat?.isDirectory())
  ) {
    throw new SafeLocalPathError('unsupported_type');
  }
  return candidateStat;
}
