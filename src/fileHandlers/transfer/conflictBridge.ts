import { spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { COMMAND_OPEN_TROUBLESHOOTING } from '../../constants';
import * as fileOperations from '../../core/fileBaseOperations';
import type { FileStats } from '../../core/fs/fileSystem';
import localFs from '../../core/localFs';
import logger from '../../logger';
import { redactedErrorMessage } from '../../security/redaction';
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
} from './conflictStateStore';
import {
  clearConflictStateIsolation,
  configureConflictStateIsolation,
} from './conflictStateIsolation';

export { atomicWriteJson } from './conflictStateStore';

export const CONFLICT_PROTOCOL_VERSION = 2;

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

interface BridgeRequest {
  version: 2;
  requestId?: string;
  kind: 'open_diff' | 'resolve';
  expectedRevision: number;
  action?: ConflictDecisionAction;
  source?: 'mcp';
  createdAt?: string;
}

interface RequestEnvelope {
  request: BridgeRequest;
  requestId: string;
  responseFile: string;
}

const REQUEST_POLL_MS = 200;
const resolvedSessions = new Set<string>();
const activeQuickPicks = new Map<string, vscode.QuickPick<vscode.QuickPickItem>>();
let manualUiQueue: Promise<void> = Promise.resolve();
let conflictSequence = 0;
let stateStore: ConflictStateStore | undefined;

function now(): string {
  return new Date().toISOString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function cleanError(error: unknown): string {
  return redactedErrorMessage(error);
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
  if (process.platform !== 'win32') {
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
  clearConflictStateIsolation();
  await store?.dispose();
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
  await writeConflictRecord(root, record);
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
    await replaceSnapshot(temporarySnapshot, remoteSnapshot);
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

async function replaceSnapshot(source: string, destination: string): Promise<void> {
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
      await replaceSnapshot(temporary, permanent);
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
  context: FileTransferContext
): Promise<{ valid: boolean; revision: number }> {
  const localStat = await fs.promises.stat(context.srcFsPath);
  const localHash = await hashFileOrNull(context.srcFsPath);
  const localChanged = localHash !== session.record.local.sha256;
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
    session.record.remoteMissingAt = now();
    session.record.local = {
      mtime: localStat.mtimeMs,
      size: localStat.size,
      sha256: localHash,
    };
    await writeConflictRecord(session.root, session.record);
    return { valid: true, revision: session.record.revision };
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
): Promise<ConflictDecisionAction | 'open_diff' | 'troubleshoot' | undefined> {
  return new Promise(resolve => {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = `SFTP/FTP Sync + AI Conflict Resolution blocked upload of ${path.basename(context.srcFsPath)}`;
    quickPick.placeholder = conflictDetail(session.record.reason);
    quickPick.ignoreFocusOut = true;
    quickPick.items = [
      { label: 'Open Diff', description: 'Compare the captured remote file with local content' },
      { label: 'Troubleshoot', description: 'Open the bundled recovery guide' },
      { label: 'Overwrite', description: 'Upload this file' },
      { label: 'Overwrite All', description: 'Upload every remaining conflict in this batch' },
      { label: 'Cancel upload', description: 'Keep the remote file unchanged' },
    ];
    activeQuickPicks.set(session.record.id, quickPick);
    let finished = false;
    const finish = (
      value: ConflictDecisionAction | 'open_diff' | 'troubleshoot' | undefined
    ) => {
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
      } else if (label === 'Troubleshoot') {
        finish('troubleshoot');
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
    if (choice === 'troubleshoot') {
      await vscode.commands.executeCommand(
        COMMAND_OPEN_TROUBLESHOOTING,
        session.record.reason === 'timestamp-unavailable'
          ? 'ftp-timestamps'
          : 'conflicts'
      );
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
    const request = await readJson<BridgeRequest>(requestFile);
    if (request) {
      pending.push({ request, requestId, responseFile });
    }
  }
  return pending;
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
): Promise<{ accepted: boolean; stale: boolean }> {
  if (expectedRevision !== session.record.revision) {
    return { accepted: false, stale: true };
  }

  if (action !== 'cancel') {
    const validation = await revalidateConflict(session, context);
    if (!validation.valid) {
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
      const request = envelope.request;
      if (request.version !== CONFLICT_PROTOCOL_VERSION) {
        await respond(envelope, session, { accepted: false, error: 'unsupported_protocol' });
        continue;
      }
      if (request.expectedRevision !== session.record.revision) {
        await respond(envelope, session, { accepted: false, stale: true });
        continue;
      }
      if (request.kind === 'open_diff') {
        try {
          await openNativeDiff(session, context);
          await respond(envelope, session, { accepted: true, opened: true });
        } catch (error) {
          await respond(envelope, session, {
            accepted: false,
            error: cleanError(error),
          });
        }
        continue;
      }
      if (
        request.kind !== 'resolve' ||
        !request.action ||
        !['overwrite', 'overwrite_all', 'cancel'].includes(request.action)
      ) {
        await respond(envelope, session, { accepted: false, error: 'invalid_request' });
        continue;
      }

      const accepted = await acceptDecision(
        session,
        context,
        request.action,
        'mcp',
        request.expectedRevision,
        envelope.requestId
      );
      if (!accepted.accepted) {
        await respond(envelope, session, { accepted: false, stale: accepted.stale });
        continue;
      }

      closeManualUi(session);
      await respond(envelope, session, { accepted: true, action: request.action });
      return request.action;
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
