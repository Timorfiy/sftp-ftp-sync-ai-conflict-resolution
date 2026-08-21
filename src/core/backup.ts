import upath from './upath';
import * as path from 'path';
import { PassThrough, Readable } from 'stream';
import { FileSystem, FileType, FileEntry } from './fs';
import { BackupConfig } from './fileService';
import * as fileOperations from './fileBaseOperations';
import logger from '../logger';

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
): Promise<string | null> {
  if (!backupConfig.enabled || backupConfig.versions <= 0) {
    return null;
  }

  const backupLocation = storage ? 'local' : 'remote';
  logger.info(`creating backup for ${targetPath} on ${backupLocation}`);

  try {
    const stat = await targetFs.lstat(targetPath);
    if (stat.type !== FileType.File) {
      logger.info(`skipping backup for ${targetPath}: not a file`);
      return null;
    }
  } catch (error) {
    logger.info(`skipping backup for ${targetPath}: ${error.message}`);
    return null;
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
      return null;
    }
    await backupFs.ensureDir(backupDir);
    await backupFs.put(inputStream, backupPath);
    logger.info(`backup created: ${targetPath} -> ${backupPath}`);
  } catch (error) {
    logger.warn(`failed to create backup for ${targetPath}: ${error.message}`);
    return null;
  }

  try {
    await pruneBackups(targetPath, targetFs, backupConfig, remotePath, storage);
  } catch (error) {
    logger.warn(`failed to prune backups for ${targetPath}: ${error.message}`);
  }

  return backupPath;
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
