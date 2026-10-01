import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import * as path from 'path';
import { localPathContains, localPathKey } from '../helper/localPaths';
import { classifyError, ActionableError, ErrorContext } from '../errors/actionable';
import { redactText } from '../security/redaction';
import type TransferTask from '../core/transferTask';

export type ActivityOrigin = 'manual' | 'save' | 'watcher' | 'open';
export type ActivityKind = 'upload' | 'download' | 'delete' | 'rename' | 'mkdir' | 'other';
export type ActivityStatus = 'pending' | 'running' | 'conflict' | 'completed' | 'failed' | 'cancelled' | 'not-started';
export interface ActivityConnection {
  key: string;
  label: string;
  description?: string;
  workspace: string;
  basePath: string;
  remotePath: string;
  protocol: string;
}
export interface ActivityConflict {
  id: string;
  status: string;
  revision: number;
  reason?: string;
  staleReason?: string;
}
export interface ActivityItem {
  id: string;
  groupId: string;
  connection: ActivityConnection;
  kind: ActivityKind;
  localPath: string;
  remotePath: string;
  status: ActivityStatus;
  attempts: number;
  warnings: readonly string[];
  error?: ActionableError;
  conflict?: ActivityConflict;
  task?: TransferTask;
  cancel?: () => void;
}
export interface ActivityGroup {
  id: string;
  label: string;
  origin: ActivityOrigin;
  startedAt: number;
  updatedAt: number;
  lastArrivalAt: number;
  endedAt?: number;
  pending: number;
  owners: number;
  entered: boolean;
  preparing: number;
  cancelRequested: boolean;
  items: Map<string, ActivityItem>;
  connections: Map<string, ActivityConnection>;
  issues: ActionableError[];
  issueConnections: Map<ActionableError, ActivityConnection>;
  issueContexts: Map<ActionableError, ErrorContext>;
  cancellations: Set<() => void>;
}
interface ActivityScope {
  origin: ActivityOrigin;
  label?: string;
  invocation?: boolean;
  group?: ActivityGroup;
  connection?: ActivityConnection;
  prepared?: boolean;
}
const scopeStorage = new AsyncLocalStorage<ActivityScope>();
const handledErrors = new WeakMap<object, ActivityGroup>();
const liveStatuses = new Set<ActivityStatus>(['pending', 'running', 'conflict']);
const pendingConflicts = new Set(['capturing', 'pending', 'reviewing', 'resolving', 'uploading']);

export class ActivityCancelledError extends Error {
  constructor() { super('Transfer operation cancelled.'); this.name = 'ActivityCancelledError'; }
}

export function itemNeedsAttention(item: ActivityItem): boolean {
  return item.status === 'conflict' || item.status === 'failed' || item.warnings.length > 0 || item.conflict?.status === 'orphaned';
}
export function groupIsActive(group: ActivityGroup): boolean {
  return group.pending > 0 || group.owners > 0 || [...group.items.values()].some(item => liveStatuses.has(item.status));
}
export function groupAttentionCount(group: ActivityGroup): number {
  return [...group.items.values()].filter(itemNeedsAttention).length + group.issues.length;
}
export function relativeActivityPath(item: ActivityItem): string {
  return localPathContains(item.connection.workspace, item.localPath)
    ? path.relative(item.connection.workspace, item.localPath) || path.basename(item.localPath)
    : item.localPath;
}
export function activityCounts(group: ActivityGroup) {
  const items = [...group.items.values()];
  const files = items.filter(item => item.kind === 'upload' || item.kind === 'download');
  return {
    total: files.length,
    completed: files.filter(item => item.status === 'completed').length,
    uploaded: files.filter(item => item.kind === 'upload' && item.status === 'completed').length,
    downloaded: files.filter(item => item.kind === 'download' && item.status === 'completed').length,
    failed: files.filter(item => item.status === 'failed').length,
    cancelled: files.filter(item => item.status === 'cancelled' || item.status === 'not-started').length,
    conflicts: items.filter(item => item.status === 'conflict').length,
    issues: groupAttentionCount(group),
    actions: items.filter(item => item.kind !== 'upload' && item.kind !== 'download' && item.status === 'completed').length,
  };
}
export function activityResultMessage(group: ActivityGroup): string {
  const counts = activityCounts(group);
  const destination = [...group.connections.values()].map(connection => connection.label).join(', ');
  const suffix = destination ? ` · ${destination}` : '';
  let result = counts.uploaded && counts.downloaded
    ? `Uploaded ${counts.uploaded}; downloaded ${counts.downloaded} files`
    : counts.downloaded
      ? `Downloaded ${counts.downloaded}${counts.total > counts.completed ? ` of ${counts.total}` : ''} files`
      : counts.uploaded || counts.total
        ? `Uploaded ${counts.uploaded}${counts.total > counts.completed ? ` of ${counts.total}` : ''} files`
        : counts.actions ? `Completed ${counts.actions} actions` : group.cancelRequested ? 'Transfer cancelled' : group.issues.length ? 'Transfer could not be completed' : 'No files to transfer';
  const changes = [...group.items.values()].filter(item => (item.kind === 'rename' || item.kind === 'delete') && item.status === 'completed');
  if (changes.length && counts.total) result += `; ${changes.length} rename/delete actions completed`;
  if (group.cancelRequested || counts.cancelled) result += '; remaining work cancelled or not started';
  if (counts.issues) result += `; ${counts.issues} ${counts.issues === 1 ? 'issue needs' : 'issues need'} attention`;
  if (group.issues.length) result += `. ${group.issues[0].summary}`;
  return redactText(`${result}${suffix}.`);
}

export class ActivityStore {
  readonly groups = new Map<string, ActivityGroup>();
  private readonly events = new EventEmitter();
  private readonly background = new Map<string, string>();
  private readonly conflicts = new Map<string, ActivityItem>();
  constructor(private readonly clock: () => number = Date.now) {}
  onChange(listener: () => void): () => void { this.events.on('change', listener); return () => this.events.off('change', listener); }
  onFinish(listener: (group: ActivityGroup) => void): () => void { this.events.on('finish', listener); return () => this.events.off('finish', listener); }
  changed(): void { this.events.emit('change'); }
  begin(label: string, origin: ActivityOrigin, connection: ActivityConnection, owner = false): ActivityGroup {
    const now = this.clock();
    const key = JSON.stringify([connection.key, label, origin]);
    const previous = this.groups.get(this.background.get(key) || '');
    if (origin !== 'manual' && previous && !previous.cancelRequested && !groupAttentionCount(previous) && now - previous.lastArrivalAt <= 1000) {
      previous.endedAt = undefined;
      previous.updatedAt = now;
      previous.lastArrivalAt = now;
      return previous;
    }
    const group: ActivityGroup = {
      id: randomUUID(), label: redactText(label), origin, startedAt: now, updatedAt: now, lastArrivalAt: now,
      pending: 0, owners: owner ? 1 : 0, preparing: 0, entered: false, cancelRequested: false,
      items: new Map(), connections: new Map(), issues: [], issueConnections: new Map(), issueContexts: new Map(), cancellations: new Set(),
    };
    this.groups.set(group.id, group);
    if (origin !== 'manual') this.background.set(key, group.id);
    return group;
  }
  discover(group: ActivityGroup, connection: ActivityConnection, kind: ActivityKind, localPath: string, remotePath: string): ActivityItem {
    const key = JSON.stringify([connection.key, kind, localPathKey(localPath), remotePath]);
    let item = group.items.get(key);
    if (!item) {
      item = { id: `${group.id}:${group.items.size + 1}`, groupId: group.id, connection, kind,
        localPath, remotePath, status: 'pending', attempts: 0, warnings: [] };
      group.items.set(key, item);
    }
    group.connections.set(connection.key, connection);
    group.updatedAt = this.clock();
    this.changed();
    return item;
  }
  update(item: ActivityItem, changes: Partial<ActivityItem>): void {
    if (changes.warnings) changes.warnings = changes.warnings.map(redactText);
    Object.assign(item, changes);
    const group = this.groups.get(item.groupId);
    if (group) group.updatedAt = this.clock();
    this.changed();
  }
  recordError(group: ActivityGroup, error: unknown, context: ErrorContext = {}): void {
    if (typeof error === 'object' && error !== null && handledErrors.get(error) === group) return;
    if (typeof error === 'object' && error !== null) handledErrors.set(error, group);
    if (error instanceof ActivityCancelledError || (error instanceof Error && error.name === 'UploadConflictAbortError')) {
      this.cancel(group.id);
      return;
    }
    const actionable = classifyError(error, { operation: group.label, ...context });
    const partial = actionable.partialResult;
    if (partial && partial.failed === 0 && partial.warnings === 0 && (partial.cancelled > 0 || partial.notStarted > 0)) {
      this.changed();
      return;
    }
    if (context.operation === 'postUpload' || context.operation === 'postDownload' || context.operation === 'postSync') {
      actionable.title = 'Post-transfer check failed';
      actionable.summary = 'Files were transferred, but the post-transfer hook failed.';
    }
    const connection = currentActivity()?.connection;
    const covered = [...group.items.values()].some(item => (!connection || item.connection.key === connection.key) && (item.status === 'failed'
      || (actionable.id === 'backup.overwrite-failed' && item.warnings.length > 0)));
    if (!covered && !group.issues.some(issue => issue.id === actionable.id && issue.summary === actionable.summary
      && group.issueConnections.get(issue)?.key === connection?.key)) {
      group.issues.push(actionable);
      if (connection) group.issueConnections.set(actionable, connection);
      group.issueContexts.set(actionable, context);
    }
    this.changed();
  }
  registerConflict(conflict: ActivityConflict, localPath: string, remotePath: string, workspace: string): void {
    let item = this.conflicts.get(conflict.id);
    if (!item) {
      const scope = scopeStorage.getStore();
      const connection = scope?.connection || { key: `recovered:${localPathKey(workspace)}`, label: path.basename(workspace),
        workspace, basePath: workspace, remotePath: '', protocol: '' };
      const group = scope?.group || [...this.groups.values()].find(candidate => candidate.label === 'Previous conflicts' && candidate.connections.has(connection.key))
        || this.begin('Previous conflicts', 'open', connection);
      group.entered = true;
      item = this.discover(group, connection, 'upload', localPath, remotePath);
      this.conflicts.set(conflict.id, item);
    }
    const status: ActivityStatus = pendingConflicts.has(conflict.status) ? 'conflict'
      : conflict.status === 'uploaded' ? 'completed' : conflict.status === 'cancelled' ? 'cancelled' : 'failed';
    this.update(item, { conflict: { ...conflict }, status });
  }
  conflictItem(id: string): ActivityItem | undefined { return this.conflicts.get(id); }
  cancel(id: string): void {
    const group = this.groups.get(id);
    if (!group || group.cancelRequested) return;
    group.cancelRequested = true;
    for (const cancel of [...group.cancellations]) cancel();
    for (const item of group.items.values()) {
      item.cancel?.();
      if (item.status === 'pending') item.status = 'cancelled';
    }
    this.changed();
  }
  finish(group: ActivityGroup): void {
    if (group.pending > 0 || group.owners > 0 || [...group.items.values()].some(item => item.status === 'conflict' || item.status === 'running')) return;
    for (const item of group.items.values()) {
      if (item.status === 'pending') item.status = group.cancelRequested ? 'cancelled' : 'not-started';
      item.task = undefined;
      item.cancel = undefined;
    }
    group.cancellations.clear();
    if (group.endedAt === undefined) {
      group.endedAt = this.clock();
      this.events.emit('finish', group);
    }
    this.prune();
    this.changed();
  }
  clearCompleted(): void {
    for (const group of [...this.groups.values()]) if (!groupIsActive(group)) this.remove(group.id);
    this.changed();
  }
  remove(id: string): void {
    const group = this.groups.get(id);
    if (!group || groupIsActive(group)) return;
    this.groups.delete(id);
    for (const [key, groupId] of this.background) if (groupId === id) this.background.delete(key);
    for (const [key, item] of this.conflicts) if (item.groupId === id) this.conflicts.delete(key);
  }
  reset(): void { this.groups.clear(); this.background.clear(); this.conflicts.clear(); this.changed(); }
  private prune(): void {
    const terminal = [...this.groups.values()].filter(group => !groupIsActive(group)).sort((a, b) => a.startedAt - b.startedAt);
    for (const group of terminal.slice(0, Math.max(0, terminal.length - 100))) this.remove(group.id);
  }
}
export const activityStore = new ActivityStore();
export function currentActivity(): ActivityScope | undefined { return scopeStorage.getStore(); }
export function assertActivityNotCancelled(): void {
  if (currentActivity()?.group?.cancelRequested) throw new ActivityCancelledError();
}
export function withActivityOrigin<T>(origin: ActivityOrigin, fn: () => Promise<T>): Promise<T> {
  return scopeStorage.run({ origin }, fn);
}
export async function withActivityInvocation<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const scope: ActivityScope = { origin: 'manual', label, invocation: true };
  return scopeStorage.run(scope, async () => {
    try { return await fn(); }
    catch (error) { if (scope.group) activityStore.recordError(scope.group, error); throw error; }
    finally { if (scope.group) { scope.group.owners -= 1; activityStore.finish(scope.group); } }
  });
}
export async function withActivityOperation<T>(label: string, connection: ActivityConnection, fn: () => Promise<T>): Promise<T> {
  const parent = currentActivity();
  const origin = parent?.origin || 'manual';
  const group = parent?.group || activityStore.begin(parent?.label || label, origin, connection, Boolean(parent?.invocation));
  if (parent?.invocation && !parent.group) parent.group = group;
  group.entered = true;
  group.connections.set(connection.key, connection);
  group.endedAt = undefined;
  group.pending += 1;
  group.preparing += 1;
  activityStore.changed();
  const scope: ActivityScope = { origin, group, connection };
  return scopeStorage.run(scope, async () => {
    try { assertActivityNotCancelled(); return await fn(); }
    catch (error) { activityStore.recordError(group, error, { protocol: connection.protocol === 'ftp' ? 'ftp' : 'sftp' }); throw error; }
    finally { group.pending -= 1; if (!scope.prepared) group.preparing = Math.max(0, group.preparing - 1); activityStore.finish(group); }
  });
}
export function activityPrepared(): void {
  const scope = currentActivity();
  if (scope?.group && !scope.prepared) {
    scope.prepared = true; scope.group.preparing = Math.max(0, scope.group.preparing - 1); activityStore.changed();
  }
}
export function discoverActivityItem(kind: ActivityKind, localPath: string, remotePath: string): ActivityItem | undefined {
  const scope = currentActivity();
  if (!scope?.group || !scope.connection) return undefined;
  assertActivityNotCancelled();
  return activityStore.discover(scope.group, scope.connection, kind, localPath, remotePath);
}
export async function recordActivityAction<T>(kind: ActivityKind, localPath: string, remotePath: string, fn: () => Promise<T>): Promise<T> {
  const item = discoverActivityItem(kind, localPath, remotePath);
  if (item) activityStore.update(item, { status: 'running', attempts: item.attempts + 1 });
  try {
    assertActivityNotCancelled();
    const result = await fn();
    if (item) activityStore.update(item, { status: 'completed' });
    return result;
  } catch (error) {
    if (item) activityStore.update(item, { status: error instanceof ActivityCancelledError ? 'cancelled' : 'failed', error: classifyError(error) });
    throw error;
  }
}
export function registerActivityCancellation(cancel: () => void): () => void {
  const group = currentActivity()?.group;
  if (!group) return () => undefined;
  group.cancellations.add(cancel);
  if (group.cancelRequested) cancel();
  return () => group.cancellations.delete(cancel);
}
export function captureActivityError(error: unknown, context: ErrorContext = {}): boolean {
  const group = currentActivity()?.group || (typeof error === 'object' && error !== null ? handledErrors.get(error) : undefined);
  if (!group) return false;
  activityStore.recordError(group, error, context);
  return true;
}
export async function settleActivityChildren<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => (result as PromiseFulfilledResult<T>).value);
}
