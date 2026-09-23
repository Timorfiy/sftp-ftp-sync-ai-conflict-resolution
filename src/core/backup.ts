import upath from './upath';
import * as path from 'path';
import { PassThrough, Readable } from 'stream';
import { FileSystem, FileType, FileEntry } from './fs';
import { BackupConfig } from './fileService';
import * as fileOperations from './fileBaseOperations';
import logger from '../logger';
import { redactedErrorMessage } from '../security/redaction';
import { TypedFailure } from '../errors/actionable';

export interface BackupPathInfo {
  originalPath: string;
  timestamp: Date;
  priority: BackupPriority;
}

export type BackupPriority = 'normal' | 'conflict';

export interface CreateBackupOptions {
  priority?: BackupPriority;
}

export interface BackupStorage {
  fs: FileSystem;
  root: string;
  pathResolver: typeof path | typeof upath;
}

export type BackupSkipReason =
  | 'disabled'
  | 'target-missing'
  | 'not-a-file'
  | 'binary-or-unsupported';

export type BackupResult =
  | { status: 'created'; path: string; warnings: readonly string[] }
  | { status: 'skipped'; reason: BackupSkipReason }
  | { status: 'failed'; reason: string };

export class DeleteBackupPreflightError extends TypedFailure {
  readonly created: number;
  readonly total: number;

  constructor(created: number, total: number, cause?: unknown) {
    super(
      'backup.delete-preflight-failed',
      `Delete backup preflight created ${created} of ${total} copies; nothing deleted.`,
      {
        backupProgress: {
          created,
          total,
          nothingDeleted: true,
        },
      },
      cause
    );
    this.name = 'DeleteBackupPreflightError';
    this.created = created;
    this.total = total;
  }
}

type BackupFileKind = 'text' | 'binary' | 'unknown';

const TEXT_EXTENSIONS = new Set([
  '.php', '.php3', '.php4', '.php5', '.phtml', '.inc', '.module', '.theme', '.install',
  '.css', '.scss', '.sass', '.less', '.styl', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.json', '.json5', '.jsonc', '.html', '.htm', '.xhtml', '.xml', '.xsl', '.xslt', '.svg',
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.config', '.properties', '.env', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
  '.cmd', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.twig', '.tpl', '.mustache', '.hbs',
  '.ejs', '.njk', '.liquid', '.log', '.map', '.lock', '.manifest', '.webmanifest', '.po', '.pot',
  '.pem', '.crt', '.key', '.cer', '.http', '.rest', '.gradle', '.groovy', '.java', '.kt', '.kts',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.py', '.rb', '.pl', '.lua', '.r',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.ico', '.avif', '.heic',
  '.heif', '.psd', '.ai', '.raw', '.svgz', '.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm',
  '.wmv', '.flv', '.mpeg', '.mpg', '.3gp', '.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac',
  '.flac', '.opus', '.wma', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.zip', '.rar',
  '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.zst', '.cab', '.exe', '.dll', '.so', '.dylib',
  '.bin', '.dat', '.db', '.sqlite', '.sqlite3', '.class', '.jar', '.war', '.wasm', '.pyc', '.doc',
  '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.swf', '.mo',
]);

const TEXT_FILENAMES = new Set([
  '.editorconfig', '.gitattributes', '.gitignore', '.htaccess', '.npmrc', '.nvmrc', '.prettierrc',
  '.stylelintrc', 'dockerfile', 'makefile', 'procfile', 'license', 'readme', 'changelog',
]);

const SAMPLE_SIZE = 8192;
const RECENT_BACKUPS_TO_KEEP = 50;
const CONFLICT_BACKUPS_TO_KEEP = 5;

export function getBackupFolder(
  root: string,
  backupFolder: string,
  pathResolver: typeof path | typeof upath = upath
): string {
  return pathResolver.join(root, backupFolder);
}

export function getBackupDirForTarget(
  targetPath: string,
  backupFolder: string,
  remotePath: string,
  storageRoot?: string,
  pathResolver: typeof path | typeof upath = upath
): string {
  const backupRoot = storageRoot ?? getBackupFolder(remotePath, backupFolder, pathResolver);
  const relativeDir = upath.dirname(upath.relative(remotePath, targetPath));
  if (relativeDir === '.' || relativeDir === '/') {
    return backupRoot;
  }
  // Preserve remote directory layout, but use the backup filesystem's separators.
  const normalizedRelativeDir =
    pathResolver === upath ? relativeDir : pathResolver.normalize(relativeDir);
  return pathResolver.join(backupRoot, normalizedRelativeDir);
}

export function getBackupPath(
  targetPath: string,
  backupFolder: string,
  remotePath: string,
  timestamp: Date = new Date(),
  storageRoot?: string,
  pathResolver: typeof path | typeof upath = upath,
  priority: BackupPriority = 'normal'
): string {
  const backupDir = getBackupDirForTarget(targetPath, backupFolder, remotePath, storageRoot, pathResolver);
  const filename = upath.basename(targetPath);
  const timestampStr = formatTimestamp(timestamp);
  const prioritySuffix = priority === 'conflict' ? '.conflict' : '';
  return pathResolver.join(backupDir, `${filename}.${timestampStr}${prioritySuffix}.bak`);
}

export function parseBackupPath(
  backupPath: string,
  backupFolder: string,
  remotePath: string,
  storageRoot?: string,
  pathResolver: typeof path | typeof upath = upath
): BackupPathInfo | null {
  const backupRoot = storageRoot ?? getBackupFolder(remotePath, backupFolder, pathResolver);

  const normalizedBackupPath = pathResolver.normalize(backupPath);
  const normalizedBackupRoot = pathResolver.normalize(backupRoot);
  if (!normalizedBackupPath.startsWith(normalizedBackupRoot)) {
    return null;
  }

  const relativeBackupPath = pathResolver.relative(normalizedBackupRoot, normalizedBackupPath);
  const basename = pathResolver.basename(relativeBackupPath);
  const dir = pathResolver.dirname(relativeBackupPath);

  const match = basename.match(/^(.+)\.(\d{14,17})(\.conflict)?\.bak$/);
  if (!match) {
    return null;
  }

  const originalFilename = match[1];
  const parsedTimestamp = parseTimestamp(match[2]);
  if (!parsedTimestamp) {
    return null;
  }

  let originalRelativeDir = dir;
  if (originalRelativeDir === '.') {
    originalRelativeDir = '';
  }

  // Remote original paths are always posix; local separators need translation.
  const originalRelativeDirPosix =
    pathResolver === upath ? originalRelativeDir : originalRelativeDir.replace(/\\/g, '/');

  const originalPath = originalRelativeDirPosix
    ? upath.join(remotePath, originalRelativeDirPosix, originalFilename)
    : upath.join(remotePath, originalFilename);

  return {
    originalPath,
    timestamp: parsedTimestamp,
    priority: match[3] ? 'conflict' : 'normal',
  };
}

export function classifyBackupPath(targetPath: string): BackupFileKind {
  const basename = upath.basename(targetPath).toLowerCase();
  if (TEXT_FILENAMES.has(basename) || basename === '.env' || basename.startsWith('.env.')) {
    return 'text';
  }

  const extension = upath.extname(basename);
  if (TEXT_EXTENSIONS.has(extension)) {
    return 'text';
  }
  if (BINARY_EXTENSIONS.has(extension)) {
    return 'binary';
  }
  return 'unknown';
}

export function isBinaryContentSample(sample: Buffer): boolean {
  if (sample.length === 0) {
    return false;
  }

  // UTF BOMs identify text even though UTF-16 contains zero bytes.
  if (
    (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) ||
    (sample[0] === 0xff && sample[1] === 0xfe) ||
    (sample[0] === 0xfe && sample[1] === 0xff)
  ) {
    return false;
  }

  let suspiciousBytes = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
    const isAllowedWhitespace = byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if ((byte < 32 && !isAllowedWhitespace) || byte === 127) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / sample.length > 0.1;
}

interface SampledStream {
  source: Readable;
  captured: Buffer[];
  sample: Buffer;
  ended: boolean;
}

async function sampleStream(source: Readable): Promise<SampledStream> {
  return new Promise((resolve, reject) => {
    const captured: Buffer[] = [];
    let capturedLength = 0;

    const cleanup = () => {
      source.removeListener('data', onData);
      source.removeListener('end', onEnd);
      source.removeListener('error', onError);
    };
    const finish = (ended: boolean) => {
      cleanup();
      const allCaptured = Buffer.concat(captured);
      resolve({
        source,
        captured,
        sample: allCaptured.subarray(0, SAMPLE_SIZE),
        ended,
      });
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      captured.push(buffer);
      capturedLength += buffer.length;
      if (capturedLength >= SAMPLE_SIZE) {
        source.pause();
        finish(false);
      }
    };
    const onEnd = () => finish(true);
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    source.on('data', onData);
    source.once('end', onEnd);
    source.once('error', onError);
  });
}

function replaySampledStream(sampled: SampledStream): Readable {
  const replay = new PassThrough();
  sampled.captured.forEach(chunk => replay.write(chunk));
  if (sampled.ended) {
    replay.end();
  } else {
    sampled.source.once('error', error => replay.destroy(error));
    sampled.source.pipe(replay);
  }
  return replay;
}

async function discardSampledStream(sampled: SampledStream): Promise<void> {
  if (sampled.ended) {
    return;
  }
  await new Promise<void>(resolve => {
    sampled.source.once('end', resolve);
    sampled.source.once('error', resolve);
    sampled.source.resume();
  });
}

async function getBackupInput(targetPath: string, targetFs: FileSystem): Promise<Readable | null> {
  const kind = classifyBackupPath(targetPath);
  if (kind === 'binary') {
    logger.info(`backup skipped (binary): ${targetPath}`);
    return null;
  }

  const source = await targetFs.get(targetPath);
  if (kind === 'text') {
    return source;
  }

  const sampled = await sampleStream(source);
  if (isBinaryContentSample(sampled.sample)) {
    await discardSampledStream(sampled);
    logger.info(`backup skipped (binary): ${targetPath}`);
    return null;
  }
  return replaySampledStream(sampled);
}

export async function createBackup(
  targetPath: string,
  targetFs: FileSystem,
  backupConfig: BackupConfig,
  remotePath: string,
  storage?: BackupStorage,
  options: CreateBackupOptions = {}
): Promise<BackupResult> {
  if (!backupConfig.enabled || backupConfig.versions <= 0) {
    return { status: 'skipped', reason: 'disabled' };
  }

  const backupLocation = storage ? 'local' : 'remote';
  logger.info(`creating backup for ${targetPath} on ${backupLocation}`);

  try {
    const stat = await targetFs.lstat(targetPath);
    if (stat.type !== FileType.File) {
      logger.info(`skipping backup for ${targetPath}: not a file`);
      return { status: 'skipped', reason: 'not-a-file' };
    }
  } catch (error) {
    logger.info(`skipping backup for ${targetPath}: ${error.message}`);
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
    if (code.toUpperCase() === 'ENOENT' || /not found|no such file/i.test(String(error))) {
      return { status: 'skipped', reason: 'target-missing' };
    }
    return { status: 'failed', reason: redactedErrorMessage(error) };
  }

  const pathResolver = storage?.pathResolver ?? upath;
  const backupFs = storage?.fs ?? targetFs;
  const backupRoot = storage?.root ?? getBackupFolder(remotePath, backupConfig.folder, pathResolver);
  const priority = options.priority ?? 'normal';

  let timestamp = new Date();
  let backupPath = getBackupPath(
    targetPath,
    backupConfig.folder,
    remotePath,
    timestamp,
    backupRoot,
    pathResolver,
    priority
  );
  const backupDir = pathResolver.dirname(backupPath);

  while (await fileExists(backupFs, backupPath)) {
    timestamp = new Date(timestamp.getTime() + 1);
    backupPath = getBackupPath(
      targetPath,
      backupConfig.folder,
      remotePath,
      timestamp,
      backupRoot,
      pathResolver,
      priority
    );
  }

  logger.info(`backup target path: ${backupPath}`);

  try {
    const inputStream = await getBackupInput(targetPath, targetFs);
    if (!inputStream) {
      return { status: 'skipped', reason: 'binary-or-unsupported' };
    }
    await backupFs.ensureDir(backupDir);
    await backupFs.put(inputStream, backupPath);
    logger.info(`backup created: ${targetPath} -> ${backupPath}`);
  } catch (error) {
    logger.warn(`failed to create backup for ${targetPath}: ${error.message}`);
    return { status: 'failed', reason: redactedErrorMessage(error) };
  }

  const warnings: string[] = [];
  try {
    await pruneBackups(targetPath, targetFs, backupConfig, remotePath, storage);
  } catch (error) {
    logger.warn(`failed to prune backups for ${targetPath}: ${error.message}`);
    warnings.push(redactedErrorMessage(error));
  }

  return { status: 'created', path: backupPath, warnings };
}

/**
 * Back up everything that a delete is about to destroy.
 *
 * Unlike the overwrite backup this refuses to fail quietly: a delete is
 * irreversible, so if a copy can't be made the caller must not proceed. Any
 * failure throws.
 *
 * Returns the number of files backed up.
 */
export async function backupBeforeDelete(
  targetPath: string,
  targetFs: FileSystem,
  backupConfig: BackupConfig,
  remotePath: string,
  storage?: BackupStorage
): Promise<number> {
  if (!backupConfig.enabled || !backupConfig.onDelete || backupConfig.versions <= 0) {
    return 0;
  }

  const stat = await targetFs.lstat(targetPath);

  let files: string[];
  if (stat.type === FileType.Directory) {
    // Backups kept on the server live under remotePath, so a delete high enough
    // up the tree would otherwise try to back up the backups.
    const excludeRoot = storage
      ? null
      : getBackupFolder(remotePath, backupConfig.folder, upath);

    files = [];
    await collectFilesToBackup(targetFs, targetPath, excludeRoot, files);
  } else if (stat.type === FileType.File) {
    files = [targetPath];
  } else {
    // A symlink's content isn't meaningfully restorable as a symlink, and
    // reading it would copy whatever it points at.
    logger.info(`skipping delete backup for ${targetPath}: not a regular file`);
    return 0;
  }

  if (files.length === 0) {
    return 0;
  }

  logger.info(`backing up ${files.length} file(s) before deleting ${targetPath}`);

  let backedUp = 0;
  for (const file of files) {
    const result = await createBackup(file, targetFs, backupConfig, remotePath, storage);
    if (result.status !== 'created') {
      throw new DeleteBackupPreflightError(backedUp, files.length, result);
    }
    backedUp += 1;
  }

  return backedUp;
}

async function collectFilesToBackup(
  fs: FileSystem,
  dir: string,
  excludeRoot: string | null,
  acc: string[]
): Promise<void> {
  if (excludeRoot && isPathEqualOrInside(dir, excludeRoot)) {
    return;
  }

  const entries = await fs.list(dir);
  for (const entry of entries) {
    if (entry.type === FileType.Directory) {
      await collectFilesToBackup(fs, entry.fspath, excludeRoot, acc);
    } else if (entry.type === FileType.File) {
      if (excludeRoot && isPathEqualOrInside(entry.fspath, excludeRoot)) {
        continue;
      }
      acc.push(entry.fspath);
    }
  }
}

function isPathEqualOrInside(candidate: string, root: string): boolean {
  const normalizedCandidate = upath.normalize(candidate.replace(/\\/g, '/'));
  const normalizedRoot = upath.normalize(root.replace(/\\/g, '/'));
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

export async function pruneBackups(
  targetPath: string,
  targetFs: FileSystem,
  backupConfig: BackupConfig,
  remotePath: string,
  storage?: BackupStorage
): Promise<void> {
  if (!backupConfig.enabled || backupConfig.versions <= 0) {
    logger.info(`prune skipped for ${targetPath}: enabled=${backupConfig.enabled}, versions=${backupConfig.versions}`);
    return;
  }

  const pathResolver = storage?.pathResolver ?? upath;
  const backupFs = storage?.fs ?? targetFs;
  const backupRoot = storage?.root ?? getBackupFolder(remotePath, backupConfig.folder, pathResolver);

  const backupDir = getBackupDirForTarget(targetPath, backupConfig.folder, remotePath, backupRoot, pathResolver);
  logger.info(`pruning backups for ${targetPath} in ${backupDir} (keep ${backupConfig.versions})`);

  let entries: FileEntry[];
  try {
    entries = await backupFs.list(backupDir);
    logger.info(`found ${entries.length} entries in backup dir`);
  } catch (error) {
    logger.warn(`failed to list backup dir ${backupDir}: ${error.message}`);
    return;
  }

  const backups = entries
    .filter(entry => entry.type === FileType.File)
    .map(entry => {
      const parsed = parseBackupPath(
        entry.fspath,
        backupConfig.folder,
        remotePath,
        backupRoot,
        pathResolver
      );
      return {
        entry,
        timestamp: parsed?.timestamp ?? null,
        priority: parsed?.priority ?? 'normal',
        originalPath: parsed?.originalPath,
      };
    })
    .filter(
      (item): item is typeof item & { timestamp: Date; originalPath: string } =>
        item.timestamp !== null && item.originalPath === targetPath
    )
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  logger.info(`matched ${backups.length} backups for ${targetPath}`);

  const limit = Math.max(0, Math.floor(backupConfig.versions));
  const keep = selectBackupsToKeep(backups, limit);
  const toDelete = backups.filter(item => !keep.has(item.entry.fspath));
  logger.info(`will delete ${toDelete.length} old backups`);

  for (const item of toDelete) {
    try {
      await fileOperations.removeFile(item.entry.fspath, backupFs, undefined);
      logger.info(`pruned old backup: ${item.entry.fspath}`);
    } catch (error) {
      logger.warn(`failed to prune backup ${item.entry.fspath}: ${error.message}`);
    }
  }
}

interface BackupCandidate {
  entry: FileEntry;
  timestamp: Date;
  priority: BackupPriority;
}

function selectEvenly<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) {
    return [];
  }
  if (count >= items.length) {
    return items.slice();
  }
  if (count === 1) {
    return [items[Math.floor((items.length - 1) / 2)]];
  }

  const selected: T[] = [];
  const used = new Set<number>();
  for (let index = 0; index < count; index++) {
    const itemIndex = Math.round((index * (items.length - 1)) / (count - 1));
    if (!used.has(itemIndex)) {
      used.add(itemIndex);
      selected.push(items[itemIndex]);
    }
  }
  return selected;
}

function selectBackupsToKeep(backups: BackupCandidate[], limit: number): Set<string> {
  const keep = new Set<string>();
  if (limit <= 0 || backups.length === 0) {
    return keep;
  }

  const add = (candidate: BackupCandidate) => {
    if (keep.size < limit) {
      keep.add(candidate.entry.fspath);
    }
  };

  // Historical anchor.
  add(backups[0]);

  // Preserve the newest versions first. Iterating newest-to-oldest also makes
  // small user-defined limits keep the most useful recent snapshots.
  const recentStart = Math.max(0, backups.length - RECENT_BACKUPS_TO_KEEP);
  for (let index = backups.length - 1; index >= recentStart; index--) {
    add(backups[index]);
  }

  // Keep up to five newest confirmed conflict-overwrite backups, including
  // older ones that are outside the recent window.
  backups
    .filter(candidate => candidate.priority === 'conflict')
    .slice(-CONFLICT_BACKUPS_TO_KEEP)
    .reverse()
    .forEach(add);

  const remainingSlots = limit - keep.size;
  if (remainingSlots > 0) {
    const middleCandidates = backups.filter(candidate => !keep.has(candidate.entry.fspath));
    selectEvenly(middleCandidates, remainingSlots).forEach(add);
  }

  return keep;
}

async function fileExists(fs: FileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

function formatTimestamp(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const padMs = (n: number) => n.toString().padStart(3, '0');
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    padMs(date.getUTCMilliseconds())
  );
}

function parseTimestamp(str: string): Date | null {
  if (!/^\d{14,17}$/.test(str)) {
    return null;
  }
  const year = parseInt(str.slice(0, 4), 10);
  const month = parseInt(str.slice(4, 6), 10) - 1;
  const day = parseInt(str.slice(6, 8), 10);
  const hour = parseInt(str.slice(8, 10), 10);
  const minute = parseInt(str.slice(10, 12), 10);
  const second = parseInt(str.slice(12, 14), 10);
  const ms = str.length === 17 ? parseInt(str.slice(14, 17), 10) : 0;
  const date = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== ms
  ) {
    return null;
  }
  return date;
}
