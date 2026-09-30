import * as fs from 'fs';
import * as path from 'path';

interface PathProbe {
  stat(file: string): Pick<fs.Stats, 'dev' | 'ino'>;
  names(directory: string): string[];
}

const nativeProbe: PathProbe = {
  stat: file => fs.statSync(file),
  names: directory => fs.readdirSync(directory),
};

/** Read-only detection; never infer the mounted volume's policy from /Volumes. */
export function detectCaseSensitivity(
  root: string,
  platform: string = process.platform,
  paths: typeof path = path,
  probe: PathProbe = nativeProbe
): boolean {
  if (platform === 'win32') return false;
  if (platform !== 'darwin') return true;
  try {
    const resolved = paths.resolve(root);
    const rootStat = probe.stat(resolved);
    const check = (directory: string, names: string[]): boolean | undefined => {
      for (const name of names.slice(0, 64)) {
        const alternate = name.replace(/[a-zA-Z]/, letter =>
          letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase());
        if (alternate === name) continue;
        try {
          const original = probe.stat(paths.join(directory, name));
          if (original.dev !== rootStat.dev || !original.ino) continue;
          // Distinct directory entries can even be hard links to the same inode.
          if (names.includes(alternate)) return true;
          const other = probe.stat(paths.join(directory, alternate));
          return original.dev !== other.dev || original.ino !== other.ino;
        } catch (error: any) {
          if (error?.code === 'ENOENT') return true;
        }
      }
      return undefined;
    };
    const childResult = check(resolved, probe.names(resolved));
    if (childResult !== undefined) return childResult;
    const parent = paths.dirname(resolved);
    if (parent !== resolved && probe.stat(parent).dev === rootStat.dev) {
      const parentResult = check(parent, probe.names(parent).filter(name =>
        name === paths.basename(resolved) || name.toLowerCase() === paths.basename(resolved).toLowerCase()));
      if (parentResult !== undefined) return parentResult;
    }
  } catch (_error) {
    // Unreadable/empty mount roots remain strict; guessing can merge real files.
  }
  return true;
}

/** Runtime keys only. Persistent workspace/credential identities stay unchanged. */
export class LocalPathPolicies {
  private roots = new Map<string, { root: string; sensitive: boolean; references: number }>();

  constructor(
    private platform: string = process.platform,
    private paths: typeof path = path,
    private probe: PathProbe = nativeProbe
  ) {}

  private normalize(file: string, sensitive: boolean): string {
    const resolved = this.paths.resolve(file);
    return sensitive ? resolved : resolved.toLocaleLowerCase('en-US');
  }

  private containsWithPolicy(root: string, candidate: string, sensitive: boolean): boolean {
    const relative = this.paths.relative(this.normalize(root, sensitive), this.normalize(candidate, sensitive));
    return relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${this.paths.sep}`) && !this.paths.isAbsolute(relative));
  }

  register(root: string): () => void {
    const resolved = this.paths.resolve(root);
    const registrationKey = this.normalize(resolved, this.platform !== 'win32');
    let entry = this.roots.get(registrationKey);
    if (!entry) {
      entry = { root: resolved, sensitive: detectCaseSensitivity(resolved, this.platform, this.paths, this.probe), references: 0 };
      this.roots.set(registrationKey, entry);
    }
    entry.references++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry!.references === 0) this.roots.delete(registrationKey);
    };
  }

  private sensitivity(file: string): boolean {
    let match: { root: string; sensitive: boolean } | undefined;
    for (const entry of this.roots.values()) {
      if ((!match || entry.root.length > match.root.length) && this.containsWithPolicy(entry.root, file, entry.sensitive)) {
        match = entry;
      }
    }
    return match ? match.sensitive : detectCaseSensitivity(file, this.platform, this.paths, this.probe);
  }

  key(file: string): string {
    return this.normalize(file, this.sensitivity(file));
  }

  contains(root: string, candidate: string): boolean {
    return this.containsWithPolicy(root, candidate, this.sensitivity(root));
  }
}

const policies = new LocalPathPolicies();
export const localPathKey = (file: string): string => policies.key(file);
export const registerLocalPathRoot = (root: string): (() => void) => policies.register(root);
export const localPathContains = (root: string, candidate: string): boolean => policies.contains(root, candidate);
