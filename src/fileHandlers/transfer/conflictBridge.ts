import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as fileOperations from '../../core/fileBaseOperations';
import type { FileStats } from '../../core/fs/fileSystem';
import localFs from '../../core/localFs';
import {
  requireSafeLocalPath,
  SafeLocalPathError,
} from '../../helper/safeLocalPath';
import { getOpenTextDocuments } from '../../host';
import logger from '../../logger';
import {
  ConflictBridgeRequest,
  conflictBridgeRequestSchema,
  CONFLICT_PROTOCOL_VERSION,
  MAX_CANDIDATE_BYTES,
  McpLaunchConfiguration,
} from '../../mcp/conflictContract';
import { suppressWatcherFor } from '../../modules/watcherSuppression';
import { diff } from '../diff';
import type { FileTransferContext } from './transfer';
import type { RemoteBaseline } from './remoteBaseline';
import {
  atomicWriteJson,
  ConflictRetentionPolicy,
  ConflictStateStatus,
  ConflictStateStore,
  readJson,
  StoredConflictRecord,
  workspaceBucketId,
} from './conflictStateStore';
import {
  clearConflictStateIsolation,
  configureConflictStateIsolation,
} from './conflictStateIsolation';

export { atomicWriteJson } from './conflictStateStore';

export type UploadConflictReason =
  | 'remote-changed'
  | 'baseline-missing'
  | 'timestamp-unavailable';

export type ConflictStatus = ConflictStateStatus;

export type ConflictDecisionAction = 'overwrite' | 'overwrite_all' | 'cancel';
export type ConflictDecisionSource = 'mcp' | 'cursor' | 'batch';

interface ConflictFileMetadata {
  mtime: number;
  size: number;
  sha256: string | null;
}

interface ConflictDecision {
  requestId?: string;
  action: ConflictDecisionAction;
  source: ConflictDecisionSource;
  requestedAt: string;
  acceptedAt: string;
}

interface ConflictCandidate {
  source: 'submitted' | 'acknowledged';
  sha256: string;
  preparedAt: string;
}

export interface ConflictRecord extends StoredConflictRecord {
  revision: number;
  reason: UploadConflictReason;
  workspaceRoot: string;
  batchId: string;
  localFile: string;
  remoteFile: string;
  local: ConflictFileMetadata;
  remote: ConflictFileMetadata;
  baseline: Pick<RemoteBaseline, 'mtime' | 'size'> | null;
  localSnapshot: string | null;
  localSnapshotError?: string;
  candidate?: ConflictCandidate;
  staleReason?: string;
  remoteMissingAt?: string;
  decision?: ConflictDecision;
}

export interface ConflictSession {
  root: string;
  record: ConflictRecord;
}

export interface ConflictReportRef {
  root: string;
  id: string;
}

interface RequestEnvelope {
  request: unknown;
  requestId: string;
  responseFile: string;
}

const REQUEST_POLL_MS = 200;
const resolvedSessions = new Set<string>();
const activeQuickPicks = new Map<string, vscode.QuickPick<vscode.QuickPickItem>>();
let manualUiQueue: Promise<void> = Promise.resolve();
let conflictSequence = 0;
let stateStore: ConflictStateStore | undefined;
let bridgeCapability = '';
let bridgeWorkspaces: readonly string[] = [];
let notificationsEnabled = true;
const activeConflictPaths = new Set<string>();

function now(): string {
  return new Date().toISOString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bridgeError(message: string, cause: unknown): Error {
  const error = new Error(message);
  Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function isNotFoundError(error: any): boolean {
  return error?.code === 'ENOENT' || error?.code === 2 || error?.message === 'file not exist';
}

function isTerminal(status: unknown): boolean {
  return (
    status === 'uploaded' ||
    status === 'cancelled' ||
    status === 'failed' ||
    status === 'orphaned'
  );
}

function pathKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

export function isConflictPathActive(file: string): boolean {
  return activeConflictPaths.has(pathKey(file));
}

function holdConflictPath(file: string): void {
  activeConflictPaths.add(pathKey(file));
}

function releaseConflictPath(file: string): void {
  activeConflictPaths.delete(pathKey(file));
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'file';
}

function requireStateStore(): ConflictStateStore {
  if (!stateStore) {
    throw new Error('Conflict state is not configured.');
  }
  return stateStore;
}

async function writeConflictRecord(root: string, record: ConflictRecord): Promise<void> {
  await requireStateStore().writeRecord(root, record);
}

async function updateSession(
  session: ConflictSession,
  status: ConflictStatus,
  changes: Partial<ConflictRecord> = {}
): Promise<void> {
  Object.assign(session.record, changes);
  session.record.status = status;
  session.record.updatedAt = now();
  await writeConflictRecord(session.root, session.record);
}

async function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject);
    input.on('data', chunk => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function hashFileOrNull(file: string): Promise<string | null> {
  try {
    return await hashFile(file);
  } catch (_error) {
    return null;
  }
}

async function captureLocalRecovery(
  session: ConflictSession,
  localFile: string
): Promise<void> {
  if (session.record.localSnapshot) {
    return;
  }
  const store = requireStateStore();
  let stat: fs.Stats;
  let directory: string;
  try {
    stat = (await requireSafeLocalPath(session.record.workspaceRoot, localFile, {
      type: 'file',
    }))!;
    directory = path.dirname(session.record.reportFile);
    await requireSafeLocalPath(session.root, directory, { type: 'directory' });
  } catch (error) {
    if (!(error instanceof SafeLocalPathError)) {
      throw error;
    }
    session.record.localSnapshotError =
      'A local recovery snapshot requires a regular file without symbolic links.';
    return;
  }
  const admission = await store.reserveSnapshot(stat.size);
  if (!admission.allowed) {
    session.record.localSnapshotError = admission.reason;
    return;
  }
  const extension = path.extname(localFile) || '.bin';
  const temporary = path.join(directory, `local-recovery-${randomUUID()}${extension}.tmp`);
  const permanent = temporary.slice(0, -4);
  try {
    await Promise.all([
      requireSafeLocalPath(directory, temporary, { allowMissingLeaf: true, type: 'file' }),
      requireSafeLocalPath(directory, permanent, { allowMissingLeaf: true, type: 'file' }),
    ]);
    await fs.promises.copyFile(localFile, temporary, fs.constants.COPYFILE_EXCL);
    const finalized = await store.finalizeSnapshot(admission.reservation, temporary);
    if (!finalized.allowed) {
      await fs.promises.rm(temporary, { force: true });
      session.record.localSnapshotError = finalized.reason;
      return;
    }
    await replaceSnapshot(temporary, permanent, directory);
    session.record.localSnapshot = permanent;
    session.record.localSnapshotError = undefined;
  } catch (error) {
    store.releaseSnapshot(admission.reservation);
    await fs.promises.rm(temporary, { force: true });
    session.record.localSnapshotError = cleanError(error);
  }
}

function metadataMatches(
  a: Pick<FileStats, 'mtime' | 'size'>,
  b: Pick<FileStats, 'mtime' | 'size'>
): boolean {
  return Math.floor(a.mtime / 1000) === Math.floor(b.mtime / 1000) && a.size === b.size;
}

function encodePowerShell(value: string): string {
  return Buffer.from(value, 'utf16le').toString('base64');
}

function notifyWindows(title: string, message: string): void {
  if (process.platform !== 'win32' || !notificationsEnabled) {
    return;
  }
  try {
    const script = `Add-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\n$kentTitle=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodePowerShell(title)}'))\n$kentText=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodePowerShell(message.slice(0, 220))}'))\n$kentNotify=New-Object System.Windows.Forms.NotifyIcon\n$kentNotify.Icon=[System.Drawing.SystemIcons]::Warning\n$kentNotify.BalloonTipIcon=[System.Windows.Forms.ToolTipIcon]::Warning\n$kentNotify.BalloonTipTitle=$kentTitle\n$kentNotify.BalloonTipText=$kentText\n$kentNotify.Visible=$true\n[System.Media.SystemSounds]::Exclamation.Play()\n$kentNotify.ShowBalloonTip(10000)\nStart-Sleep -Seconds 12\n$kentNotify.Dispose()`;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)],
      { detached: true, windowsHide: true, stdio: 'ignore' }
    );
    child.on('error', error => {
      logger.warn(`Could not show Windows conflict notification: ${cleanError(error)}`);
    });
    child.unref();
  } catch (error) {
    logger.warn(`Could not start Windows conflict notification: ${cleanError(error)}`);
  }
}

export interface ConflictBridgeInitializationOptions {
  globalStorageRoot: string;
  policy?: Partial<ConflictRetentionPolicy>;
  sessionId?: string;
  processId?: number;
  now?: () => Date;
  processIsAlive?: (pid: number) => boolean;
  notifications?: boolean;
}

export async function initializeConflictBridge(
  workspaces: readonly string[],
  version: string,
  options: ConflictBridgeInitializationOptions
): Promise<void> {
  await stateStore?.dispose();
  stateStore = new ConflictStateStore({
    globalStorageRoot: options.globalStorageRoot,
    workspaces,
    extensionVersion: version,
    policy: options.policy,
    sessionId: options.sessionId,
    processId: options.processId,
    now: options.now,
    processIsAlive: options.processIsAlive,
  });
  bridgeWorkspaces = workspaces.map(workspace => path.resolve(workspace));
  bridgeCapability = `${randomUUID()}${randomUUID()}`;
  notificationsEnabled = options.notifications !== false;
  activeConflictPaths.clear();
  configureConflictStateIsolation(stateStore.stateRoot, workspaces);
  try {
    await stateStore.reconcileLegacyIfPresent();
  } catch (error) {
    logger.error(error, 'migrate legacy conflict state');
    void vscode.window.showErrorMessage(
      'SFTP/FTP Sync + AI Conflict Resolution could not migrate legacy conflict state. ' +
        'The project copy remains protected from transfer; reload the editor or use Clear Conflict State after resolving filesystem access.'
    );
  }
}

export async function disposeConflictBridge(): Promise<void> {
  const store = stateStore;
  stateStore = undefined;
  bridgeWorkspaces = [];
  bridgeCapability = '';
  notificationsEnabled = true;
  activeConflictPaths.clear();
  clearConflictStateIsolation();
  await store?.dispose();
}

export function getConflictMcpConfiguration(
  extensionVersion: string,
  workspaceNames: ReadonlyMap<string, string>
): McpLaunchConfiguration {
  const store = requireStateStore();
  if (!bridgeCapability) {
    throw new Error('Conflict MCP capability is unavailable.');
  }
  return {
    version: 1,
    extensionVersion,
    stateRoot: store.stateRoot,
    capability: bridgeCapability,
    workspaces: bridgeWorkspaces.map(root => ({
      bucket: workspaceBucketId(root),
      root,
      name: workspaceNames.get(pathKey(root)) || path.basename(root),
    })),
  };
}

export async function clearConflictState(workspaces: readonly string[]) {
  return requireStateStore().clear(workspaces);
}

export async function listConflictState(
  workspaces: readonly string[]
): Promise<ConflictRecord[]> {
  return (await requireStateStore().list(workspaces)) as ConflictRecord[];
}

export async function captureConflict(
  workspaceRoot: string,
  batchId: string,
  context: FileTransferContext,
  reason: UploadConflictReason,
  remote: Pick<FileStats, 'mtime' | 'size'>,
  baseline?: RemoteBaseline
): Promise<ConflictSession> {
  try {
    await requireSafeLocalPath(workspaceRoot, context.srcFsPath, { type: 'file' });
  } catch (error) {
    if (error instanceof SafeLocalPathError) {
      throw bridgeError('unsupported_file', error);
    }
    throw error;
  }
  const store = requireStateStore();
  const detectedAt = now();
  const id = `${detectedAt.replace(/[:.]/g, '-')}-${process.pid}-${++conflictSequence}-${safeName(path.basename(context.srcFsPath))}`;
  const root = await store.prepareConflict(workspaceRoot, id);
  const directory = path.join(root, id);
  const extension = path.extname(context.srcFsPath) || '.bin';
  const remoteSnapshot = path.join(directory, `remote${extension}`);
  const reportFile = path.join(directory, 'conflict.json');
  const record: ConflictRecord = {
    version: 2,
    id,
    status: 'capturing',
    revision: 1,
    reason,
    detectedAt,
    updatedAt: detectedAt,
    workspaceRoot: path.resolve(workspaceRoot),
    sessionId: store.sessionId,
    batchId,
    localFile: context.srcFsPath,
    remoteFile: context.targetFsPath,
    remoteSnapshot,
    localSnapshot: null,
    reportFile,
    local: {
      mtime: context.sourceMtime,
      size: context.sourceSize,
      sha256: await hashFileOrNull(context.srcFsPath),
    },
    remote: {
      mtime: remote.mtime,
      size: remote.size,
      sha256: null,
    },
    baseline: baseline ? { mtime: baseline.mtime, size: baseline.size } : null,
  };
  const session = { root, record };
  holdConflictPath(context.srcFsPath);
  await writeConflictRecord(root, record);
  await captureLocalRecovery(session, context.srcFsPath);
  notifyWindows(
    'SFTP/FTP Sync + AI Conflict Resolution — конфликт',
    `Загрузка ${path.basename(context.srcFsPath)} остановлена: серверный файл изменён.`
  );

  const admission = await store.reserveSnapshot(remote.size);
  if (!admission.allowed) {
    await updateSession(session, 'pending', {
      remoteSnapshot: null,
      snapshotError: admission.reason,
    });
    return session;
  }
  const temporarySnapshot = `${remoteSnapshot}.snapshot.tmp`;
  try {
    await requireSafeLocalPath(root, directory, { type: 'directory' });
    await Promise.all([
      requireSafeLocalPath(directory, temporarySnapshot, {
        allowMissingLeaf: true,
        type: 'file',
      }),
      requireSafeLocalPath(directory, remoteSnapshot, {
        allowMissingLeaf: true,
        type: 'file',
      }),
    ]);
    await fileOperations.transferFile(
      context.targetFsPath,
      temporarySnapshot,
      context.targetFs,
      localFs
    );
    const finalized = await store.finalizeSnapshot(
      admission.reservation,
      temporarySnapshot
    );
    if (!finalized.allowed) {
      await fs.promises.rm(temporarySnapshot, { force: true });
      await updateSession(session, 'pending', {
        remoteSnapshot: null,
        snapshotError: finalized.reason,
      });
      return session;
    }
    await replaceSnapshot(temporarySnapshot, remoteSnapshot, directory);
    record.remote.sha256 = await hashFile(remoteSnapshot);
    await updateSession(session, 'pending', { snapshotError: undefined });
  } catch (error) {
    store.releaseSnapshot(admission.reservation);
    await fs.promises.rm(temporarySnapshot, { force: true });
    await updateSession(session, 'pending', {
      remoteSnapshot: null,
      snapshotError: cleanError(error),
    });
    logger.warn(
      `Could not capture remote conflict snapshot for ${context.targetFsPath}: ${cleanError(error)}`
    );
  }

  return session;
}

async function openNativeDiff(
  session: ConflictSession,
  context: FileTransferContext
): Promise<void> {
  if (!isTerminal(session.record.status)) {
    await updateSession(session, 'reviewing');
  }
  try {
    const snapshot = session.record.remoteSnapshot;
    if (snapshot && fs.existsSync(snapshot)) {
      try {
        await requireSafeLocalPath(
          path.dirname(session.record.reportFile),
          snapshot,
          { type: 'file' }
        );
      } catch (error) {
        if (error instanceof SafeLocalPathError) {
          throw bridgeError('unsupported_file', error);
        }
        throw error;
      }
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(snapshot),
        vscode.Uri.file(context.srcFsPath),
        `${path.basename(context.srcFsPath)} (remote ↔ local)`
      );
    } else {
      await diff(vscode.Uri.file(context.srcFsPath));
    }
  } catch (error) {
    logger.warn(`Could not open conflict diff for ${context.targetFsPath}: ${cleanError(error)}`);
    throw error;
  }
}

async function replaceSnapshot(
  source: string,
  destination: string,
  root: string
): Promise<void> {
  await Promise.all([
    requireSafeLocalPath(root, source, { type: 'file' }),
    requireSafeLocalPath(root, destination, { allowMissingLeaf: true, type: 'file' }),
  ]);
  await fs.promises.rename(source, destination);
}

async function refreshRemoteSnapshot(
  session: ConflictSession,
  context: FileTransferContext,
  remote: Pick<FileStats, 'mtime' | 'size'>
): Promise<{ changed: boolean; supersededSnapshot?: string }> {
  const store = requireStateStore();
  const directory = path.dirname(session.record.reportFile);
  const extension = path.extname(context.srcFsPath) || '.bin';
  const permanent = path.join(directory, `remote-${randomUUID()}${extension}`);
  const temporary = path.join(directory, `remote-check-${randomUUID()}${extension}`);
  await requireSafeLocalPath(session.root, directory, { type: 'directory' });
  await Promise.all([
    requireSafeLocalPath(directory, permanent, { allowMissingLeaf: true, type: 'file' }),
    requireSafeLocalPath(directory, temporary, { allowMissingLeaf: true, type: 'file' }),
  ]);
  const admission = await store.reserveSnapshot(remote.size);
  if (!admission.allowed) {
    const supersededSnapshot = session.record.remoteSnapshot || undefined;
    session.record.remoteSnapshot = null;
    session.record.snapshotError = admission.reason;
    return { changed: true, supersededSnapshot };
  }
  try {
    await fileOperations.transferFile(
      context.targetFsPath,
      temporary,
      context.targetFs,
      localFs
    );
    const finalized = await store.finalizeSnapshot(admission.reservation, temporary);
    if (!finalized.allowed) {
      await fs.promises.rm(temporary, { force: true });
      const supersededSnapshot = session.record.remoteSnapshot || undefined;
      session.record.remoteSnapshot = null;
      session.record.snapshotError = finalized.reason;
      return { changed: true, supersededSnapshot };
    }
    const remoteHash = await hashFile(temporary);
    const changed = remoteHash !== session.record.remote.sha256;
    let supersededSnapshot: string | undefined;
    if (changed || !session.record.remoteSnapshot) {
      supersededSnapshot = session.record.remoteSnapshot || undefined;
      await replaceSnapshot(temporary, permanent, directory);
      session.record.remoteSnapshot = permanent;
    } else {
      await fs.promises.unlink(temporary);
    }
    session.record.remote = {
      mtime: remote.mtime,
      size: remote.size,
      sha256: remoteHash,
    };
    session.record.snapshotError = undefined;
    return { changed, supersededSnapshot };
  } catch (error) {
    store.releaseSnapshot(admission.reservation);
    const supersededSnapshot = session.record.remoteSnapshot || undefined;
    session.record.remoteSnapshot = null;
    session.record.snapshotError = cleanError(error);
    try {
      await fs.promises.unlink(temporary);
    } catch (_cleanupError) {
      // Nothing else to clean up.
    }
    return { changed: true, supersededSnapshot };
  }
}

async function removeSupersededSnapshot(
  session: ConflictSession,
  supersededSnapshot?: string
): Promise<void> {
  if (
    !supersededSnapshot ||
    supersededSnapshot === session.record.remoteSnapshot ||
    path.dirname(supersededSnapshot) !== path.dirname(session.record.reportFile)
  ) {
    return;
  }
  try {
    await fs.promises.rm(supersededSnapshot, { force: true });
  } catch (error) {
    logger.warn(
      `Could not remove superseded conflict snapshot ${path.basename(supersededSnapshot)}: ${cleanError(error)}`
    );
  }
}

export async function revalidateConflict(
  session: ConflictSession,
  context: FileTransferContext,
  allowedLocalHash?: string
): Promise<{ valid: boolean; revision: number }> {
  let localStat: fs.Stats;
  try {
    localStat = (await requireSafeLocalPath(
      session.record.workspaceRoot,
      context.srcFsPath,
      { type: 'file' }
    ))!;
  } catch (error) {
    if (error instanceof SafeLocalPathError) {
      throw bridgeError('unsupported_file', error);
    }
    throw error;
  }
  const localHash = await hashFileOrNull(context.srcFsPath);
  const localChanged =
    localHash !== session.record.local.sha256 && localHash !== allowedLocalHash;
  let remoteChanged = false;
  let supersededSnapshot: string | undefined;
  let remoteMissing = false;
  let remote: FileStats | undefined;

  try {
    remote = await context.targetFs.lstat(context.targetFsPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      remoteMissing = true;
    } else {
      throw error;
    }
  }

  if (remoteMissing) {
    const stateChanged =
      !session.record.remoteMissingAt ||
      localChanged ||
      Boolean(session.record.candidate) ||
      Boolean(session.record.decision) ||
      Boolean(session.record.result) ||
      session.record.staleReason !==
        [localChanged ? 'local-changed' : '', 'remote-missing']
          .filter(Boolean)
          .join(',');
    if (stateChanged) {
      session.record.revision += 1;
    }
    session.record.remoteMissingAt ||= now();
    session.record.local = {
      mtime: localStat.mtimeMs,
      size: localStat.size,
      sha256: localHash,
    };
    session.record.decision = undefined;
    session.record.candidate = undefined;
    session.record.result = undefined;
    session.record.staleReason = [
      localChanged ? 'local-changed' : '',
      'remote-missing',
    ]
      .filter(Boolean)
      .join(',');
    await updateSession(session, 'pending');
    return { valid: false, revision: session.record.revision };
  }

  if (remote) {
    const metadataChanged = !metadataMatches(remote, session.record.remote);
    if (metadataChanged || remote.mtime <= 0) {
      const refreshed = await refreshRemoteSnapshot(session, context, remote);
      remoteChanged = refreshed.changed;
      supersededSnapshot = refreshed.supersededSnapshot;
    }
  }

  if (localChanged || remoteChanged) {
    session.record.revision += 1;
    session.record.local = {
      mtime: localStat.mtimeMs,
      size: localStat.size,
      sha256: localHash,
    };
    session.record.decision = undefined;
    session.record.candidate = undefined;
    session.record.result = undefined;
    session.record.staleReason = [
      localChanged ? 'local-changed' : '',
      remoteChanged ? 'remote-changed' : '',
    ]
      .filter(Boolean)
      .join(',');
    await updateSession(session, 'pending');
    await removeSupersededSnapshot(session, supersededSnapshot);
    return { valid: false, revision: session.record.revision };
  }

  if (remote) {
    session.record.remote.mtime = remote.mtime;
    session.record.remote.size = remote.size;
  }
  session.record.local = {
    mtime: localStat.mtimeMs,
    size: localStat.size,
    sha256: localHash,
  };
  context.sourceMtime = localStat.mtimeMs;
  context.sourceSize = localStat.size;
  session.record.staleReason = undefined;
  await writeConflictRecord(session.root, session.record);
  await removeSupersededSnapshot(session, supersededSnapshot);
  return { valid: true, revision: session.record.revision };
}

function conflictDetail(reason: UploadConflictReason): string {
  switch (reason) {
    case 'remote-changed':
      return 'The remote modification time or byte size no longer matches the last observed version.';
    case 'baseline-missing':
      return 'This existing remote file differs from local metadata, but no previous remote baseline is stored yet.';
    case 'timestamp-unavailable':
      return 'The FTP server did not provide an exact remote modification time, so a safe comparison is not possible.';
  }
}

function showQuickPickOnce(
  session: ConflictSession,
  context: FileTransferContext
): Promise<ConflictDecisionAction | 'open_diff' | undefined> {
  return new Promise(resolve => {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = `SFTP/FTP Sync + AI Conflict Resolution blocked upload of ${path.basename(context.srcFsPath)}`;
    quickPick.placeholder = conflictDetail(session.record.reason);
    quickPick.ignoreFocusOut = true;
    quickPick.items = [
      { label: 'Open Diff', description: 'Compare the captured remote file with local content' },
      { label: 'Overwrite', description: 'Upload this file' },
      { label: 'Overwrite All', description: 'Upload every remaining conflict in this batch' },
      { label: 'Cancel upload', description: 'Keep the remote file unchanged' },
    ];
    activeQuickPicks.set(session.record.id, quickPick);
    let finished = false;
    const finish = (value: ConflictDecisionAction | 'open_diff' | undefined) => {
      if (finished) {
        return;
      }
      finished = true;
      activeQuickPicks.delete(session.record.id);
      accepted.dispose();
      hidden.dispose();
      quickPick.dispose();
      resolve(value);
    };
    const accepted = quickPick.onDidAccept(() => {
      const label = quickPick.selectedItems[0]?.label;
      if (label === 'Open Diff') {
        finish('open_diff');
      } else if (label === 'Overwrite') {
        finish('overwrite');
      } else if (label === 'Overwrite All') {
        finish('overwrite_all');
      } else if (label === 'Cancel upload') {
        finish('cancel');
      }
    });
    const hidden = quickPick.onDidHide(() => {
      finish(resolvedSessions.has(session.record.id) ? undefined : 'cancel');
    });
    quickPick.show();
  });
}

async function showManualUi(
  session: ConflictSession,
  context: FileTransferContext
): Promise<ConflictDecisionAction | undefined> {
  while (!resolvedSessions.has(session.record.id)) {
    const choice = await showQuickPickOnce(session, context);
    if (!choice) {
      return undefined;
    }
    if (choice === 'open_diff') {
      await openNativeDiff(session, context).catch(() => undefined);
      continue;
    }
    return choice;
  }
  return undefined;
}

function enqueueManualUi(
  session: ConflictSession,
  context: FileTransferContext
): Promise<ConflictDecisionAction | undefined> {
  let result: ConflictDecisionAction | undefined;
  const operation = manualUiQueue.then(async () => {
    result = await showManualUi(session, context);
  });
  manualUiQueue = operation.then(() => undefined, () => undefined);
  return operation.then(() => result);
}

async function pendingRequests(session: ConflictSession): Promise<RequestEnvelope[]> {
  const requestsDirectory = path.join(path.dirname(session.record.reportFile), 'requests');
  const responsesDirectory = path.join(path.dirname(session.record.reportFile), 'responses');
  let entries: string[];
  try {
    entries = (await fs.promises.readdir(requestsDirectory))
      .filter(entry => entry.endsWith('.json'))
      .sort();
  } catch (_error) {
    return [];
  }

  const pending: RequestEnvelope[] = [];
  for (const entry of entries) {
    const requestFile = path.join(requestsDirectory, entry);
    const requestId = path.basename(entry, '.json');
    const responseFile = path.join(responsesDirectory, `${requestId}.json`);
    if (fs.existsSync(responseFile)) {
      continue;
    }
    const stat = await fs.promises.lstat(requestFile).catch(() => undefined);
    if (!stat?.isFile() || stat.size > MAX_CANDIDATE_BYTES * 2) {
      pending.push({ request: undefined, requestId, responseFile });
      continue;
    }
    const request = await readJson<unknown>(requestFile);
    pending.push({ request, requestId, responseFile });
  }
  return pending;
}

function isDirtyDocument(file: string): boolean {
  const target = pathKey(file);
  return getOpenTextDocuments().some(
    document =>
      !document.isClosed &&
      document.isDirty &&
      pathKey(document.uri.fsPath) === target
  );
}

async function requireMutableLocalFile(
  session: ConflictSession
): Promise<fs.Stats> {
  if (isTerminal(session.record.status) || session.record.status === 'resolving' || session.record.status === 'uploading') {
    throw new Error('terminal_or_resolving');
  }
  if (isDirtyDocument(session.record.localFile)) {
    throw new Error('dirty_buffer');
  }
  try {
    return (await requireSafeLocalPath(
      session.record.workspaceRoot,
      session.record.localFile,
      { type: 'file' }
    ))!;
  } catch (error) {
    if (!(error instanceof SafeLocalPathError)) {
      throw error;
    }
    throw bridgeError('unsupported_file', error);
  }
}

async function replaceLocalAtomically(
  file: string,
  content: string,
  mode: number,
  workspaceRoot: string
): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const rollback = path.join(directory, `.${path.basename(file)}.${randomUUID()}.rollback`);
  await Promise.all([
    requireSafeLocalPath(workspaceRoot, file, { type: 'file' }),
    requireSafeLocalPath(workspaceRoot, temporary, {
      allowMissingLeaf: true,
      type: 'file',
    }),
    requireSafeLocalPath(workspaceRoot, rollback, {
      allowMissingLeaf: true,
      type: 'file',
    }),
  ]);
  await fs.promises.writeFile(temporary, content, {
    encoding: 'utf8',
    flag: 'wx',
    mode: mode & 0o777,
  });
  await fs.promises.chmod(temporary, mode & 0o777);
  let originalMoved = false;
  try {
    await Promise.all([
      requireSafeLocalPath(workspaceRoot, file, { type: 'file' }),
      requireSafeLocalPath(workspaceRoot, temporary, { type: 'file' }),
      requireSafeLocalPath(workspaceRoot, rollback, {
        allowMissingLeaf: true,
        type: 'file',
      }),
    ]);
    await fs.promises.rename(file, rollback);
    originalMoved = true;
    await Promise.all([
      requireSafeLocalPath(workspaceRoot, rollback, { type: 'file' }),
      requireSafeLocalPath(workspaceRoot, temporary, { type: 'file' }),
      requireSafeLocalPath(workspaceRoot, file, {
        allowMissingLeaf: true,
        type: 'file',
      }),
    ]);
    await fs.promises.rename(temporary, file);
    await fs.promises.rm(rollback, { force: true });
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    if (originalMoved) {
      await fs.promises.rename(rollback, file).catch(() => undefined);
    }
    throw error;
  }
}

async function requireRecoverySnapshot(session: ConflictSession): Promise<void> {
  if (!session.record.localSnapshot) {
    throw new Error('recovery_unavailable');
  }
  try {
    await requireSafeLocalPath(
      path.dirname(session.record.reportFile),
      session.record.localSnapshot,
      { type: 'file' }
    );
  } catch (error) {
    if (error instanceof SafeLocalPathError) {
      throw bridgeError('recovery_unavailable', error);
    }
    throw error;
  }
}

async function submitLocalCandidate(
  session: ConflictSession,
  context: FileTransferContext,
  request: Extract<ConflictBridgeRequest, { kind: 'submit_local' }>
): Promise<void> {
  if (request.expectedRevision !== session.record.revision) {
    throw new Error('stale');
  }
  const bytes = Buffer.byteLength(request.content, 'utf8');
  if (bytes > MAX_CANDIDATE_BYTES || request.content.includes('\0')) {
    throw new Error('invalid_content');
  }
  const stat = await requireMutableLocalFile(session);
  const currentHash = await hashFile(session.record.localFile);
  if (
    currentHash !== session.record.local.sha256 ||
    currentHash !== request.expectedLocalSha256
  ) {
    await revalidateConflict(session, context);
    throw new Error('stale');
  }
  await captureLocalRecovery(session, session.record.localFile);
  if (!session.record.localSnapshot) {
    await writeConflictRecord(session.root, session.record);
    throw new Error('recovery_unavailable');
  }
  await requireRecoverySnapshot(session);
  suppressWatcherFor(session.record.localFile, 30_000);
  try {
    await replaceLocalAtomically(
      session.record.localFile,
      request.content,
      stat.mode,
      session.record.workspaceRoot
    );
  } catch (error) {
    if (error instanceof SafeLocalPathError) {
      throw bridgeError('unsupported_file', error);
    }
    throw error;
  }
  const updated = await requireMutableLocalFile(session);
  const candidateHash = await hashFile(session.record.localFile);
  session.record.revision += 1;
  session.record.local = {
    mtime: updated.mtimeMs,
    size: updated.size,
    sha256: candidateHash,
  };
  session.record.candidate = {
    source: 'submitted',
    sha256: candidateHash,
    preparedAt: now(),
  };
  session.record.staleReason = undefined;
  context.sourceMtime = updated.mtimeMs;
  context.sourceSize = updated.size;
  await updateSession(session, 'pending');
}

async function acknowledgeLocalCandidate(
  session: ConflictSession,
  context: FileTransferContext,
  request: Extract<ConflictBridgeRequest, { kind: 'acknowledge_local' }>
): Promise<void> {
  if (request.expectedRevision !== session.record.revision) {
    throw new Error('stale');
  }
  const stat = await requireMutableLocalFile(session);
  await requireRecoverySnapshot(session);
  const hash = await hashFile(session.record.localFile);
  if (hash !== request.expectedLocalSha256) {
    await revalidateConflict(session, context);
    throw new Error('stale');
  }
  const remoteValidation = await revalidateConflict(session, context, hash);
  if (!remoteValidation.valid) {
    throw new Error('stale');
  }
  session.record.revision += 1;
  session.record.local = {
    mtime: stat.mtimeMs,
    size: stat.size,
    sha256: hash,
  };
  session.record.candidate = {
    source: 'acknowledged',
    sha256: hash,
    preparedAt: now(),
  };
  session.record.staleReason = undefined;
  context.sourceMtime = stat.mtimeMs;
  context.sourceSize = stat.size;
  await updateSession(session, 'pending');
}

async function respond(
  envelope: RequestEnvelope,
  session: ConflictSession,
  result: Record<string, unknown>
): Promise<void> {
  await atomicWriteJson(envelope.responseFile, {
    version: CONFLICT_PROTOCOL_VERSION,
    requestId: envelope.requestId,
    conflictId: session.record.id,
    revision: session.record.revision,
    status: session.record.status,
    respondedAt: now(),
    ...result,
  });
}

async function acceptDecision(
  session: ConflictSession,
  context: FileTransferContext,
  action: ConflictDecisionAction,
  source: ConflictDecisionSource,
  expectedRevision: number,
  requestId?: string
): Promise<{ accepted: boolean; stale: boolean; error?: string }> {
  if (isTerminal(session.record.status) || session.record.status === 'uploading') {
    return { accepted: false, stale: false, error: 'already_resolved' };
  }
  if (expectedRevision !== session.record.revision) {
    return { accepted: false, stale: true };
  }

  if (
    source === 'mcp' &&
    action !== 'cancel' &&
    !session.record.candidate
  ) {
    return { accepted: false, stale: false, error: 'candidate_required' };
  }

  if (action !== 'cancel') {
    const validation = await revalidateConflict(session, context);
    if (!validation.valid) {
      return { accepted: false, stale: true };
    }
    if (
      source === 'mcp' &&
      session.record.candidate?.sha256 !== session.record.local.sha256
    ) {
      return { accepted: false, stale: true };
    }
  }

  const acceptedAt = now();
  const decision: ConflictDecision = {
    requestId,
    action,
    source,
    requestedAt: acceptedAt,
    acceptedAt,
  };
  if (action === 'cancel') {
    await updateSession(session, 'cancelled', {
      decision,
      result: { cancelledAt: acceptedAt },
    });
    releaseConflictPath(session.record.localFile);
  } else {
    await updateSession(session, 'resolving', { decision });
  }
  return { accepted: true, stale: false };
}

function closeManualUi(session: ConflictSession): void {
  resolvedSessions.add(session.record.id);
  activeQuickPicks.get(session.record.id)?.hide();
}

export async function waitForConflictDecision(
  session: ConflictSession,
  context: FileTransferContext
): Promise<ConflictDecisionAction> {
  let manualDecision: ConflictDecisionAction | undefined;
  void enqueueManualUi(session, context).then(choice => {
    manualDecision = choice;
  });

  for (;;) {
    if (manualDecision) {
      const decision = manualDecision;
      manualDecision = undefined;
      const accepted = await acceptDecision(
        session,
        context,
        decision,
        'cursor',
        session.record.revision
      );
      if (accepted.accepted) {
        closeManualUi(session);
        const superseded = await pendingRequests(session);
        await Promise.all(
          superseded.map(envelope =>
            respond(envelope, session, {
              accepted: false,
              error: 'already_resolved',
              decision: session.record.decision,
            })
          )
        );
        return decision;
      }
    }

    const requests = await pendingRequests(session);
    for (const envelope of requests) {
      const parsed = conflictBridgeRequestSchema.safeParse(envelope.request);
      if (!parsed.success || parsed.data.requestId !== envelope.requestId) {
        await respond(envelope, session, {
          accepted: false,
          error: 'invalid_request',
          message: 'The request did not match the conflict bridge contract.',
        });
        continue;
      }
      const request = parsed.data;
      if (request.capability !== bridgeCapability) {
        await respond(envelope, session, {
          accepted: false,
          error: 'unauthorized',
          message: 'The request capability is invalid or expired.',
        });
        continue;
      }
      if (request.expectedRevision !== session.record.revision) {
        await respond(envelope, session, { accepted: false, stale: true });
        continue;
      }

      if (request.kind === 'submit_local' || request.kind === 'acknowledge_local') {
        try {
          if (request.kind === 'submit_local') {
            await submitLocalCandidate(session, context, request);
          } else {
            await acknowledgeLocalCandidate(session, context, request);
          }
          await respond(envelope, session, {
            accepted: true,
            candidateSha256: session.record.candidate?.sha256,
          });
        } catch (error) {
          const detail = cleanError(error);
          const knownErrors = new Set([
            'stale',
            'dirty_buffer',
            'unsupported_file',
            'invalid_content',
            'recovery_unavailable',
            'terminal_or_resolving',
          ]);
          const code = knownErrors.has(detail) ? detail : 'write_failed';
          if (code === 'write_failed') {
            logger.warn(
              `Could not prepare local conflict candidate for ${path.basename(
                session.record.localFile
              )}: ${detail}`
            );
          }
          await respond(envelope, session, {
            accepted: false,
            stale: code === 'stale',
            error: code,
            message:
              code === 'dirty_buffer'
                ? 'Save or revert the dirty editor buffer before preparing a candidate.'
                : code === 'recovery_unavailable'
                  ? 'A required local recovery snapshot could not be retained within the conflict-state limits.'
                  : code === 'write_failed'
                    ? 'The extension could not atomically replace the local file; the original file was restored.'
                  : undefined,
          });
        }
        continue;
      }

      const accepted = await acceptDecision(
        session,
        context,
        request.action === 'upload' ? 'overwrite' : 'cancel',
        'mcp',
        request.expectedRevision,
        envelope.requestId
      );
      if (!accepted.accepted) {
        await respond(envelope, session, {
          accepted: false,
          stale: accepted.stale,
          error: accepted.error,
          message:
            accepted.error === 'candidate_required'
              ? 'Submit or acknowledge resolved local content before requesting upload.'
              : undefined,
        });
        continue;
      }

      closeManualUi(session);
      await respond(envelope, session, { accepted: true });
      const superseded = (await pendingRequests(session)).filter(
        item => item.requestId !== envelope.requestId
      );
      await Promise.all(
        superseded.map(item =>
          respond(item, session, {
            accepted: false,
            error: 'already_resolved',
            message: 'Another manual or agent decision already won this conflict.',
          })
        )
      );
      return request.action === 'upload' ? 'overwrite' : 'cancel';
    }

    await delay(REQUEST_POLL_MS);
  }
}

export async function acceptBatchOverwrite(
  session: ConflictSession,
  context: FileTransferContext
): Promise<boolean> {
  const validation = await revalidateConflict(session, context);
  if (!validation.valid) {
    return false;
  }
  const acceptedAt = now();
  await updateSession(session, 'resolving', {
    decision: {
      action: 'overwrite_all',
      source: 'batch',
      requestedAt: acceptedAt,
      acceptedAt,
    },
  });
  return true;
}

export async function markConflictUploading(session: ConflictSession): Promise<ConflictReportRef> {
  await updateSession(session, 'uploading');
  return { root: session.root, id: session.record.id };
}

async function updateConflictByReference(
  reference: ConflictReportRef,
  status: ConflictStatus,
  changes: Partial<ConflictRecord>
): Promise<void> {
  const record = await requireStateStore().readRecord<ConflictRecord>(
    reference.root,
    reference.id
  );
  if (!record) {
    return;
  }
  const session = { root: reference.root, record };
  await updateSession(session, status, changes);
  if (isTerminal(status)) {
    releaseConflictPath(record.localFile);
  }
}

export async function markConflictUploaded(reference: ConflictReportRef): Promise<void> {
  const uploadedAt = now();
  await updateConflictByReference(reference, 'uploaded', {
    result: { uploadedAt },
  });
}

export async function markConflictFailed(
  reference: ConflictReportRef,
  error: unknown
): Promise<void> {
  const failedAt = now();
  await updateConflictByReference(reference, 'failed', {
    result: { failedAt, error: cleanError(error) },
  });
}
