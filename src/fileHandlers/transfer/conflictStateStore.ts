import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type ConflictStateStatus =
  | 'capturing'
  | 'pending'
  | 'reviewing'
  | 'resolving'
  | 'uploading'
  | 'uploaded'
  | 'cancelled'
  | 'failed'
  | 'orphaned';

export interface StoredConflictRecord {
  version: 2;
  id: string;
  status: ConflictStateStatus;
  detectedAt: string;
  updatedAt: string;
  sessionId: string;
  reportFile: string;
  remoteSnapshot: string | null;
  localSnapshot?: string | null;
  snapshotError?: string;
  localSnapshotError?: string;
  result?: {
    uploadedAt?: string;
    cancelledAt?: string;
    failedAt?: string;
    orphanedAt?: string;
    error?: string;
  };
}

export interface ConflictRetentionPolicy {
  maxAgeMs: number;
  maxInactivePerWorkspace: number;
  maxTotalBytes: number;
  maxSnapshotBytes: number;
  leaseStaleMs: number;
  staleArtifactAgeMs: number;
}

export const DEFAULT_CONFLICT_RETENTION_POLICY: Readonly<ConflictRetentionPolicy> = {
  maxAgeMs: 90 * 24 * 60 * 60 * 1000,
  maxInactivePerWorkspace: 250,
  maxTotalBytes: 500 * 1024 * 1024,
  maxSnapshotBytes: 100 * 1024 * 1024,
  leaseStaleMs: 90 * 1000,
  staleArtifactAgeMs: 24 * 60 * 60 * 1000,
};

export interface ConflictStateStoreOptions {
  globalStorageRoot: string;
  workspaces: readonly string[];
  extensionVersion: string;
  sessionId?: string;
  processId?: number;
  now?: () => Date;
  policy?: Partial<ConflictRetentionPolicy>;
  processIsAlive?: (pid: number) => boolean;
}

export interface ClearConflictStateResult {
  clearedRecords: number;
  retainedActiveRecords: number;
  clearedBytes: number;
  legacyRootsCleared: number;
}

interface Lease {
  version: 1;
  sessionId: string;
  processId: number;
  workspaceBucket: string;
  updatedAt: string;
}

interface RecordEntry<T extends StoredConflictRecord = StoredConflictRecord> {
  root: string;
  directory: string;
  record: T;
  bytes: number;
}

interface SnapshotReservation {
  expectedBytes: number;
  released: boolean;
}

const ACTIVE_STATUSES = new Set<ConflictStateStatus>([
  'capturing',
  'pending',
  'reviewing',
  'resolving',
  'uploading',
]);

function isNotFound(error: any): boolean {
  return error?.code === 'ENOENT';
}

function defaultProcessIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function normalizeForIdentity(workspace: string): string {
  let canonical = path.resolve(workspace).replace(/[\\/]+$/, '');
  if (process.platform === 'win32' || /^[a-zA-Z]:[\\/]/.test(canonical)) {
    canonical = canonical.replace(/\//g, '\\').toLocaleLowerCase('en-US');
  }
  return canonical;
}

export function workspaceBucketId(workspace: string): string {
  return createHash('sha256').update(normalizeForIdentity(workspace)).digest('hex');
}

export function legacyConflictRoot(workspace: string): string {
  return path.join(path.resolve(workspace), '.kent-tmp', 'sftp-conflicts');
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T;
  } catch (_error) {
    return undefined;
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const previous = `${file}.previous`;
  await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  try {
    await fs.promises.rename(temporary, file);
  } catch (error) {
    try {
      await fs.promises.rm(previous, { force: true });
      await fs.promises.rename(file, previous);
      await fs.promises.rename(temporary, file);
      await fs.promises.rm(previous, { force: true });
    } catch (_replacementError) {
      if (!(await pathExists(file)) && (await pathExists(previous))) {
        await fs.promises.rename(previous, file);
      }
      throw error;
    }
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.promises.lstat(file);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

async function directorySize(root: string): Promise<number> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(root);
  } catch (error) {
    if (isNotFound(error)) {
      return 0;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return 0;
  }
  if (!stat.isDirectory()) {
    return stat.size;
  }
  let total = stat.size;
  for (const entry of await fs.promises.readdir(root)) {
    total += await directorySize(path.join(root, entry));
  }
  return total;
}

async function copyDirectoryWithoutLinks(source: string, destination: string): Promise<void> {
  await fs.promises.mkdir(destination, { recursive: true });
  for (const name of await fs.promises.readdir(source)) {
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    const stat = await fs.promises.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      await copyDirectoryWithoutLinks(sourcePath, destinationPath);
    } else if (stat.isFile()) {
      await fs.promises.copyFile(sourcePath, destinationPath);
    }
  }
}

function recordTimestamp(record: StoredConflictRecord): number {
  const parsed = Date.parse(record.updatedAt || record.detectedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function snapshotSizeLimitReason(actualBytes: number, maxBytes: number): string {
  return `Remote snapshot is ${actualBytes} bytes; the conflict-state limit is ${maxBytes} bytes per snapshot.`;
}

export function isActiveConflictStatus(status: ConflictStateStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export class ConflictStateStore {
  readonly stateRoot: string;
  readonly sessionId: string;
  readonly processId: number;
  readonly policy: Readonly<ConflictRetentionPolicy>;

  private readonly clock: () => Date;
  private readonly processIsAlive: (pid: number) => boolean;
  private readonly workspaceByBucket = new Map<string, string>();
  private readonly activeBuckets = new Set<string>();
  private operationQueue: Promise<unknown> = Promise.resolve();
  private heartbeat: NodeJS.Timeout | undefined;
  private reservedSnapshotBytes = 0;

  constructor(options: ConflictStateStoreOptions) {
    this.stateRoot = path.join(path.resolve(options.globalStorageRoot), 'conflict-state-v2');
    this.sessionId =
      options.sessionId || `${Date.now()}-${process.pid}-${randomUUID()}`;
    this.processId = options.processId ?? process.pid;
    this.clock = options.now || (() => new Date());
    this.processIsAlive = options.processIsAlive || defaultProcessIsAlive;
    this.policy = {
      ...DEFAULT_CONFLICT_RETENTION_POLICY,
      ...(options.policy || {}),
    };
    for (const workspace of options.workspaces) {
      this.workspaceByBucket.set(workspaceBucketId(workspace), path.resolve(workspace));
    }
  }

  workspaceRoot(workspace: string): string {
    const bucket = workspaceBucketId(workspace);
    if (!this.workspaceByBucket.has(bucket)) {
      this.workspaceByBucket.set(bucket, path.resolve(workspace));
    }
    return path.join(this.stateRoot, 'workspaces', bucket);
  }

  isManagedRoot(candidate: string): boolean {
    return this.isSameOrDescendant(candidate, this.stateRoot);
  }

  async reconcileLegacyIfPresent(): Promise<void> {
    await this.serial(async () => {
      for (const [bucket, workspace] of this.workspaceByBucket) {
        const legacyRoot = legacyConflictRoot(workspace);
        if (!(await pathExists(legacyRoot))) {
          continue;
        }
        const bridge = await readJson<{ pid?: number }>(
          path.join(legacyRoot, 'bridge.json')
        );
        if (bridge?.pid && this.processIsAlive(bridge.pid)) {
          continue;
        }
        const destinationRoot = path.join(this.stateRoot, 'workspaces', bucket);
        await this.importLegacyRoot(legacyRoot, destinationRoot);
        await this.reconcileWorkspaceRoot(destinationRoot);
        await fs.promises.rm(legacyRoot, { recursive: true, force: true });
        await this.removeEmptyLegacyParents(workspace);
      }
      await this.enforceRetentionInternal();
    });
  }

  async prepareConflict(workspace: string, id: string): Promise<string> {
    return this.serial(async () => {
      const root = this.workspaceRoot(workspace);
      await this.reconcileWorkspaceRoot(root);
      const directory = path.join(root, id);
      await fs.promises.mkdir(path.join(directory, 'requests'), { recursive: true });
      await fs.promises.mkdir(path.join(directory, 'responses'), { recursive: true });
      await this.touchLease(root);
      return root;
    });
  }

  async writeRecord<T extends StoredConflictRecord>(root: string, record: T): Promise<void> {
    await this.serial(async () => {
      await atomicWriteJson(record.reportFile, record);
      if (isActiveConflictStatus(record.status)) {
        await this.touchLease(root);
      } else {
        await this.refreshLeaseForRoot(root);
        await this.enforceRetentionInternal();
      }
    });
  }

  async readRecord<T extends StoredConflictRecord>(
    root: string,
    id: string
  ): Promise<T | undefined> {
    return readJson<T>(path.join(root, id, 'conflict.json'));
  }

  async reserveSnapshot(
    expectedBytes: number
  ): Promise<{ allowed: true; reservation: SnapshotReservation } | { allowed: false; reason: string }> {
    return this.serial(async () => {
      if (expectedBytes > this.policy.maxSnapshotBytes) {
        return {
          allowed: false as const,
          reason: snapshotSizeLimitReason(expectedBytes, this.policy.maxSnapshotBytes),
        };
      }
      await this.enforceRetentionInternal();
      const used = await directorySize(this.stateRoot);
      if (used + this.reservedSnapshotBytes + expectedBytes > this.policy.maxTotalBytes) {
        return {
          allowed: false as const,
          reason: `Conflict-state storage is full (${this.policy.maxTotalBytes} byte limit). Active decisions were preserved.`,
        };
      }
      this.reservedSnapshotBytes += expectedBytes;
      return {
        allowed: true as const,
        reservation: { expectedBytes, released: false },
      };
    });
  }

  async finalizeSnapshot(
    reservation: SnapshotReservation,
    temporaryFile: string
  ): Promise<{ allowed: true; size: number } | { allowed: false; reason: string }> {
    return this.serial(async () => {
      const stat = await fs.promises.lstat(temporaryFile);
      const actualBytes = stat.isFile() ? stat.size : this.policy.maxSnapshotBytes + 1;
      const otherReservations =
        this.reservedSnapshotBytes - (reservation.released ? 0 : reservation.expectedBytes);
      const usedIncludingTemporary = await directorySize(this.stateRoot);
      this.releaseReservationInternal(reservation);
      if (actualBytes > this.policy.maxSnapshotBytes) {
        return {
          allowed: false as const,
          reason: snapshotSizeLimitReason(actualBytes, this.policy.maxSnapshotBytes),
        };
      }
      if (usedIncludingTemporary + otherReservations > this.policy.maxTotalBytes) {
        return {
          allowed: false as const,
          reason: `Conflict-state storage is full (${this.policy.maxTotalBytes} byte limit). Active decisions were preserved.`,
        };
      }
      return { allowed: true as const, size: actualBytes };
    });
  }

  releaseSnapshot(reservation: SnapshotReservation): void {
    this.releaseReservationInternal(reservation);
  }

  async enforceRetention(): Promise<void> {
    await this.serial(() => this.enforceRetentionInternal());
  }

  async list(workspaces: readonly string[]): Promise<StoredConflictRecord[]> {
    return this.serial(async () => {
      const records: StoredConflictRecord[] = [];
      for (const workspace of workspaces) {
        const root = this.workspaceRoot(workspace);
        await this.reconcileWorkspaceRoot(root);
        records.push(...(await this.readEntries(root)).map(entry => entry.record));
      }
      return records.sort((a, b) => recordTimestamp(b) - recordTimestamp(a));
    });
  }

  async clear(workspaces: readonly string[]): Promise<ClearConflictStateResult> {
    return this.serial(async () => {
      const result: ClearConflictStateResult = {
        clearedRecords: 0,
        retainedActiveRecords: 0,
        clearedBytes: 0,
        legacyRootsCleared: 0,
      };
      for (const workspace of workspaces) {
        const root = this.workspaceRoot(workspace);
        const legacyRoot = legacyConflictRoot(workspace);
        if (await pathExists(legacyRoot)) {
          const bridge = await readJson<{ pid?: number }>(
            path.join(legacyRoot, 'bridge.json')
          );
          if (bridge?.pid && this.processIsAlive(bridge.pid)) {
            result.retainedActiveRecords += (
              await this.readLegacyRecords(legacyRoot)
            ).filter(record => isActiveConflictStatus(record.status)).length;
            continue;
          }
          await this.importLegacyRoot(legacyRoot, root);
          await fs.promises.rm(legacyRoot, { recursive: true, force: true });
          await this.removeEmptyLegacyParents(workspace);
          result.legacyRootsCleared += 1;
        }
        await this.reconcileWorkspaceRoot(root);
        for (const entry of await this.readEntries(root)) {
          if (isActiveConflictStatus(entry.record.status)) {
            result.retainedActiveRecords += 1;
            continue;
          }
          await fs.promises.rm(entry.directory, { recursive: true, force: true });
          result.clearedRecords += 1;
          result.clearedBytes += entry.bytes;
        }
        await this.refreshLeaseForRoot(root);
      }
      return result;
    });
  }

  async dispose(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    await this.serial(async () => {
      for (const bucket of this.activeBuckets) {
        await fs.promises.rm(this.leaseFile(bucket), { force: true });
      }
      this.activeBuckets.clear();
      await this.removeEmptyDirectory(path.join(this.stateRoot, 'sessions', this.sessionId));
      await this.removeEmptyDirectory(path.join(this.stateRoot, 'sessions'));
    });
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation);
    this.operationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private now(): Date {
    return this.clock();
  }

  private leaseFile(bucket: string): string {
    return path.join(this.stateRoot, 'sessions', this.sessionId, `${bucket}.json`);
  }

  private bucketFromRoot(root: string): string {
    return path.basename(root);
  }

  private async touchLease(root: string): Promise<void> {
    const bucket = this.bucketFromRoot(root);
    this.activeBuckets.add(bucket);
    const lease: Lease = {
      version: 1,
      sessionId: this.sessionId,
      processId: this.processId,
      workspaceBucket: bucket,
      updatedAt: this.now().toISOString(),
    };
    await atomicWriteJson(this.leaseFile(bucket), lease);
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        void this.serial(async () => {
          for (const activeBucket of this.activeBuckets) {
            const activeRoot = path.join(this.stateRoot, 'workspaces', activeBucket);
            await this.touchLease(activeRoot);
          }
        });
      }, Math.max(1000, Math.floor(this.policy.leaseStaleMs / 3)));
      this.heartbeat.unref?.();
    }
  }

  private async refreshLeaseForRoot(root: string): Promise<void> {
    const bucket = this.bucketFromRoot(root);
    const hasOwnedActive = (await this.readEntries(root)).some(
      entry =>
        entry.record.sessionId === this.sessionId &&
        isActiveConflictStatus(entry.record.status)
    );
    if (hasOwnedActive) {
      await this.touchLease(root);
      return;
    }
    this.activeBuckets.delete(bucket);
    await fs.promises.rm(this.leaseFile(bucket), { force: true });
  }

  private async leaseIsLive(sessionId: string, bucket: string): Promise<boolean> {
    const lease = await readJson<Lease>(
      path.join(this.stateRoot, 'sessions', sessionId, `${bucket}.json`)
    );
    if (!lease || lease.sessionId !== sessionId || lease.workspaceBucket !== bucket) {
      return false;
    }
    if (this.processIsAlive(lease.processId)) {
      return true;
    }
    const updated = Date.parse(lease.updatedAt);
    return Number.isFinite(updated) && this.now().getTime() - updated <= this.policy.leaseStaleMs;
  }

  private async reconcileWorkspaceRoot(root: string): Promise<void> {
    if (!(await pathExists(root))) {
      return;
    }
    const bucket = this.bucketFromRoot(root);
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      if (!entry.isDirectory()) {
        if (entry.name.endsWith('.tmp')) {
          await this.reconcileTemporaryJson(fullPath);
        }
        continue;
      }
      const reportFile = path.join(fullPath, 'conflict.json');
      let record = await readJson<StoredConflictRecord>(reportFile);
      if (record && (await this.activeRecordIsLive(record, bucket))) {
        continue;
      }
      await this.reconcileReportTemporaries(fullPath, reportFile, bucket);
      record = await readJson<StoredConflictRecord>(reportFile);
      if (!record || record.version !== 2 || record.id !== entry.name) {
        const stat = await fs.promises.lstat(fullPath);
        if (this.now().getTime() - stat.mtimeMs > this.policy.staleArtifactAgeMs) {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
        }
        continue;
      }
      record.reportFile = reportFile;
      if (record.remoteSnapshot && !(await pathExists(record.remoteSnapshot))) {
        record.remoteSnapshot = null;
        record.snapshotError = 'Remote snapshot was interrupted or is no longer available.';
        await atomicWriteJson(reportFile, record);
      }
      if (record.localSnapshot && !(await pathExists(record.localSnapshot))) {
        record.localSnapshot = null;
        record.localSnapshotError =
          'Local recovery snapshot was interrupted or is no longer available.';
        await atomicWriteJson(reportFile, record);
      }
      await this.removeUnreferencedSnapshots(fullPath, record);
      if (
        isActiveConflictStatus(record.status) &&
        record.sessionId !== this.sessionId &&
        !(await this.leaseIsLive(record.sessionId, bucket))
      ) {
        const orphanedAt = this.now().toISOString();
        record.status = 'orphaned';
        record.updatedAt = orphanedAt;
        record.result = { ...(record.result || {}), orphanedAt };
        await atomicWriteJson(reportFile, record);
      }
    }
  }

  private async reconcileReportTemporaries(
    directory: string,
    reportFile: string,
    bucket: string
  ): Promise<void> {
    const candidates = (await fs.promises.readdir(directory))
      .filter(name => name.startsWith('conflict.json.') && name.endsWith('.tmp'))
      .map(name => path.join(directory, name));
    for (const candidate of candidates) {
      const candidateRecord = await readJson<StoredConflictRecord>(candidate);
      if (candidateRecord && (await this.activeRecordIsLive(candidateRecord, bucket))) {
        return;
      }
    }
    const previous = `${reportFile}.previous`;
    if (!(await pathExists(reportFile)) && (await readJson(previous))) {
      await fs.promises.rename(previous, reportFile);
    } else {
      await fs.promises.rm(previous, { force: true });
    }
    if (candidates.length === 0) {
      return;
    }
    if (!(await pathExists(reportFile))) {
      const valid: Array<{ file: string; mtimeMs: number }> = [];
      for (const file of candidates) {
        if (await readJson(file)) {
          valid.push({ file, mtimeMs: (await fs.promises.lstat(file)).mtimeMs });
        }
      }
      valid.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (valid[0]) {
        await fs.promises.rename(valid[0].file, reportFile);
      }
    }
    for (const file of candidates) {
      await fs.promises.rm(file, { force: true });
    }
  }

  private async activeRecordIsLive(
    record: StoredConflictRecord,
    bucket: string
  ): Promise<boolean> {
    if (!isActiveConflictStatus(record.status)) {
      return false;
    }
    return (
      record.sessionId === this.sessionId ||
      (await this.leaseIsLive(record.sessionId, bucket))
    );
  }

  private async reconcileTemporaryJson(file: string): Promise<void> {
    const marker = file.indexOf('.json.');
    if (marker < 0) {
      await fs.promises.rm(file, { force: true });
      return;
    }
    const destination = file.slice(0, marker + '.json'.length);
    if (!(await pathExists(destination)) && (await readJson(file))) {
      await fs.promises.rename(file, destination);
    } else {
      await fs.promises.rm(file, { force: true });
    }
  }

  private async removeUnreferencedSnapshots(
    directory: string,
    record: StoredConflictRecord
  ): Promise<void> {
    for (const name of await fs.promises.readdir(directory)) {
      const isTemporary =
        name.startsWith('remote-check-') ||
        name.startsWith('local-recovery-') && name.endsWith('.tmp') ||
        name.endsWith('.snapshot.tmp');
      const isPermanent =
        /^remote(?:-[0-9a-f-]+)?\.[^\\/]+$/i.test(name) ||
        /^local-recovery-[0-9a-f-]+\.[^\\/]+$/i.test(name);
      if (!isTemporary && !isPermanent) {
        continue;
      }
      const candidate = path.join(directory, name);
      if (record.remoteSnapshot && path.resolve(candidate) === path.resolve(record.remoteSnapshot)) {
        continue;
      }
      if (record.localSnapshot && path.resolve(candidate) === path.resolve(record.localSnapshot)) {
        continue;
      }
      await fs.promises.rm(candidate, { force: true });
    }
  }

  private async readEntries<T extends StoredConflictRecord = StoredConflictRecord>(
    root: string
  ): Promise<Array<RecordEntry<T>>> {
    if (!(await pathExists(root))) {
      return [];
    }
    const entries: Array<RecordEntry<T>> = [];
    for (const item of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory()) {
        continue;
      }
      const directory = path.join(root, item.name);
      const record = await readJson<T>(path.join(directory, 'conflict.json'));
      if (!record || record.version !== 2 || record.id !== item.name) {
        continue;
      }
      entries.push({
        root,
        directory,
        record,
        bytes: await directorySize(directory),
      });
    }
    return entries;
  }

  private async allWorkspaceRoots(): Promise<string[]> {
    const workspacesRoot = path.join(this.stateRoot, 'workspaces');
    if (!(await pathExists(workspacesRoot))) {
      return [];
    }
    return (await fs.promises.readdir(workspacesRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(workspacesRoot, entry.name));
  }

  private async enforceRetentionInternal(): Promise<void> {
    const now = this.now().getTime();
    const roots = await this.allWorkspaceRoots();
    for (const root of roots) {
      await this.reconcileWorkspaceRoot(root);
      let inactive = (await this.readEntries(root))
        .filter(entry => !isActiveConflictStatus(entry.record.status))
        .sort((a, b) => recordTimestamp(a.record) - recordTimestamp(b.record));
      for (const entry of inactive.filter(
        candidate => now - recordTimestamp(candidate.record) > this.policy.maxAgeMs
      )) {
        await fs.promises.rm(entry.directory, { recursive: true, force: true });
      }
      inactive = (await this.readEntries(root))
        .filter(entry => !isActiveConflictStatus(entry.record.status))
        .sort((a, b) => recordTimestamp(a.record) - recordTimestamp(b.record));
      while (inactive.length > this.policy.maxInactivePerWorkspace) {
        const entry = inactive.shift()!;
        await fs.promises.rm(entry.directory, { recursive: true, force: true });
      }
    }

    let used = await directorySize(this.stateRoot);
    if (used <= this.policy.maxTotalBytes) {
      return;
    }
    const inactive = (
      await Promise.all((await this.allWorkspaceRoots()).map(root => this.readEntries(root)))
    )
      .flat()
      .filter(entry => !isActiveConflictStatus(entry.record.status))
      .sort((a, b) => recordTimestamp(a.record) - recordTimestamp(b.record));
    for (const entry of inactive) {
      if (used <= this.policy.maxTotalBytes) {
        break;
      }
      await fs.promises.rm(entry.directory, { recursive: true, force: true });
      used -= entry.bytes;
    }
  }

  private releaseReservationInternal(reservation: SnapshotReservation): void {
    if (reservation.released) {
      return;
    }
    reservation.released = true;
    this.reservedSnapshotBytes = Math.max(
      0,
      this.reservedSnapshotBytes - reservation.expectedBytes
    );
  }

  private async importLegacyRoot(legacyRoot: string, destinationRoot: string): Promise<void> {
    await fs.promises.mkdir(destinationRoot, { recursive: true });
    for (const item of await fs.promises.readdir(legacyRoot, { withFileTypes: true })) {
      if (!item.isDirectory()) {
        continue;
      }
      const legacyDirectory = path.join(legacyRoot, item.name);
      const legacyRecord = await this.readRecoverableLegacyRecord(
        legacyDirectory,
        item.name
      );
      const destinationDirectory = path.join(destinationRoot, item.name);
      await fs.promises.rm(destinationDirectory, { recursive: true, force: true });
      await copyDirectoryWithoutLinks(legacyDirectory, destinationDirectory);
      const reportFile = path.join(destinationDirectory, 'conflict.json');
      const imported: StoredConflictRecord = {
        ...legacyRecord,
        reportFile,
        remoteSnapshot:
          legacyRecord.remoteSnapshot &&
          this.isSameOrDescendant(legacyRecord.remoteSnapshot, legacyDirectory)
            ? path.join(
                destinationDirectory,
                path.relative(legacyDirectory, legacyRecord.remoteSnapshot)
              )
            : null,
      };
      let oversizedSnapshot: string | undefined;
      if (imported.remoteSnapshot) {
        let snapshotStat: fs.Stats | undefined;
        try {
          snapshotStat = await fs.promises.lstat(imported.remoteSnapshot);
        } catch (error) {
          if (!isNotFound(error)) {
            throw error;
          }
        }
        if (!snapshotStat?.isFile()) {
          imported.remoteSnapshot = null;
          imported.snapshotError = 'Legacy remote snapshot was missing during migration.';
        } else if (snapshotStat.size > this.policy.maxSnapshotBytes) {
          oversizedSnapshot = imported.remoteSnapshot;
          imported.remoteSnapshot = null;
          imported.snapshotError = snapshotSizeLimitReason(
            snapshotStat.size,
            this.policy.maxSnapshotBytes
          );
        }
      }
      await atomicWriteJson(reportFile, imported);
      const verified = await readJson<StoredConflictRecord>(reportFile);
      if (
        !verified ||
        verified.version !== 2 ||
        verified.id !== imported.id ||
        verified.remoteSnapshot !== imported.remoteSnapshot ||
        verified.snapshotError !== imported.snapshotError
      ) {
        throw new Error(`Could not verify imported conflict state ${imported.id}.`);
      }
      if (oversizedSnapshot) {
        await fs.promises.rm(oversizedSnapshot, { force: true });
      }
      await this.removeUnreferencedSnapshots(destinationDirectory, imported);
    }
  }

  private async readRecoverableLegacyRecord(
    directory: string,
    expectedId: string
  ): Promise<StoredConflictRecord> {
    const reportFile = path.join(directory, 'conflict.json');
    const candidates = [
      reportFile,
      `${reportFile}.previous`,
      ...(await fs.promises.readdir(directory))
        .filter(name => name.startsWith('conflict.json.') && name.endsWith('.tmp'))
        .map(name => path.join(directory, name)),
    ];
    const valid: Array<{ record: StoredConflictRecord; mtimeMs: number; priority: number }> = [];
    for (const candidate of candidates) {
      const record = await readJson<StoredConflictRecord>(candidate);
      if (record?.version !== 2 || record.id !== expectedId) {
        continue;
      }
      const stat = await fs.promises.lstat(candidate);
      valid.push({
        record,
        mtimeMs: stat.mtimeMs,
        priority: candidate === reportFile ? 1 : 0,
      });
    }
    valid.sort((a, b) => b.priority - a.priority || b.mtimeMs - a.mtimeMs);
    if (!valid[0]) {
      throw new Error(
        `Legacy conflict record ${expectedId} could not be verified; the protected source state was retained.`
      );
    }
    return valid[0].record;
  }

  private async readLegacyRecords(legacyRoot: string): Promise<StoredConflictRecord[]> {
    const records: StoredConflictRecord[] = [];
    for (const item of await fs.promises.readdir(legacyRoot, { withFileTypes: true })) {
      if (!item.isDirectory()) {
        continue;
      }
      const record = await readJson<StoredConflictRecord>(
        path.join(legacyRoot, item.name, 'conflict.json')
      );
      if (record?.version === 2) {
        records.push(record);
      }
    }
    return records;
  }

  private isSameOrDescendant(candidate: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private async removeEmptyLegacyParents(workspace: string): Promise<void> {
    await this.removeEmptyDirectory(path.join(path.resolve(workspace), '.kent-tmp'));
  }

  private async removeEmptyDirectory(directory: string): Promise<void> {
    try {
      if ((await fs.promises.readdir(directory)).length === 0) {
        await fs.promises.rmdir(directory);
      }
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
  }
}
