import { randomUUID } from 'crypto';
import TransferTask from './transferTask';
import {
  classifyFailureId,
  classifyError,
  FailureId,
  TransferResultSummary,
  TypedFailure,
} from '../errors/actionable';
import { redactedErrorMessage } from '../security/redaction';
import { localPathKey } from '../helper/localPaths';
import { activityStore, currentActivity } from '../modules/activity';
import { FileType } from './fs/fileSystem';

export type TransferItemStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'not-started';

export interface TransferItemResult {
  id: string;
  localPath: string;
  sourcePath: string;
  targetPath: string;
  status: TransferItemStatus;
  attempts: number;
  warnings: readonly string[];
  error?: string;
  attemptErrors?: readonly string[];
}

export interface TransferOperationResult extends TransferResultSummary {
  items: readonly TransferItemResult[];
  isPartial: boolean;
}

interface MutableTransferItem {
  id: string;
  task: TransferTask;
  status: TransferItemStatus;
  attempts: number;
  warnings: string[];
  error?: string;
  attemptErrors: string[];
}

export class TransferOperation {
  readonly id: string;
  private readonly items = new Map<TransferTask, MutableTransferItem>();
  private sequence = 0;
  private readonly logicalItems = new Map<string, MutableTransferItem>();
  private readonly scope = currentActivity();
  private readonly listeners = new Set<(item: TransferItemResult) => void>();
  private readonly taskCancels = new WeakMap<TransferTask, () => void>();

  constructor(id: string = randomUUID()) {
    this.id = id;
  }

  add(task: TransferTask): void {
    if (this.scope?.group && !this.taskCancels.has(task)) {
      const cancel = () => task.cancel();
      this.taskCancels.set(task, cancel);
      this.scope.group.cancellations.add(cancel);
      if (this.scope.group.cancelRequested) cancel();
    }
    const existing = this.items.get(task);
    if (existing) {
      existing.status = 'pending';
      this.changed(existing);
      return;
    }
    const key = JSON.stringify([localPathKey(task.localFsPath), task.transferType,
      task.transferType === 'local ➞ remote' ? task.targetFsPath : task.srcFsPath]);
    const logical = this.logicalItems.get(key);
    if (logical) {
      logical.task = task;
      logical.status = 'pending';
      logical.error = undefined;
      logical.warnings = [];
      this.items.set(task, logical);
      this.changed(logical);
      return;
    }
    const item: MutableTransferItem = {
      id: `${this.id}:${++this.sequence}`,
      task,
      status: 'pending',
      attempts: 0,
      warnings: [],
      attemptErrors: [],
    };
    this.items.set(task, item);
    this.logicalItems.set(key, item);
    this.changed(item);
  }

  onChange(listener: (item: TransferItemResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(task: TransferTask): void {
    const item = this.requireItem(task);
    item.status = 'running';
    item.attempts += 1;
    this.changed(item);
  }

  finish(task: TransferTask, error?: unknown): void {
    const item = this.requireItem(task);
    const cancel = this.taskCancels.get(task);
    if (cancel) this.scope?.group?.cancellations.delete(cancel);
    this.taskCancels.delete(task);
    if (item.task !== task) return;
    item.warnings = task.getWarnings().map(warning => warning.message);
    if (task.isCancelled()) {
      item.status = 'cancelled';
      item.error = undefined;
    } else if (error) {
      item.status = 'failed';
      item.error = redactedErrorMessage(error);
      item.attemptErrors.push(item.error);
    } else {
      item.status = 'completed';
      item.error = undefined;
    }
    this.changed(item);
  }

  cancelQueued(task: TransferTask): void {
    const item = this.requireItem(task);
    item.status = 'cancelled';
    task.cancel();
    this.changed(item);
  }

  markNotStarted(task: TransferTask): void {
    const item = this.requireItem(task);
    item.status = 'not-started';
    this.changed(item);
  }

  result(): TransferOperationResult {
    const items = [...this.logicalItems.values()].map(item => ({
      id: item.id,
      localPath: item.task.localFsPath,
      sourcePath: item.task.srcFsPath,
      targetPath: item.task.targetFsPath,
      status: item.status,
      attempts: item.attempts,
      warnings: [...item.warnings],
      error: item.error,
      attemptErrors: [...item.attemptErrors],
    }));
    const count = (status: TransferItemStatus) =>
      items.filter(item => item.status === status).length;
    const completed = count('completed');
    const failed = count('failed');
    const cancelled = count('cancelled');
    const notStarted = count('not-started');
    const warnings = items.reduce((total, item) => total + item.warnings.length, 0);

    return {
      operationId: this.id,
      completed,
      failed,
      cancelled,
      notStarted,
      warnings,
      items,
      isPartial: failed > 0 || cancelled > 0 || notStarted > 0 || warnings > 0,
    };
  }

  private changed(item: MutableTransferItem): void {
    for (const listener of this.listeners) listener({ id: item.id, localPath: item.task.localFsPath,
      sourcePath: item.task.srcFsPath, targetPath: item.task.targetFsPath, status: item.status,
      attempts: item.attempts, warnings: [...item.warnings], error: item.error });
    const { group, connection } = this.scope || {};
    if (!group || !connection) return;
    const task = item.task;
    const kind = task.fileType === FileType.Directory ? 'mkdir' : task.transferType === 'local ➞ remote' ? 'upload' : 'download';
    const activity = activityStore.discover(group, connection, kind, task.localFsPath,
      kind === 'upload' ? task.targetFsPath : task.srcFsPath);
    activityStore.update(activity, { status: item.status, attempts: item.attempts, warnings: [...item.warnings],
      task, cancel: () => task.cancel(),
      error: item.error ? classifyError(item.error) : undefined });
  }

  private requireItem(task: TransferTask): MutableTransferItem {
    let item = this.items.get(task);
    if (!item) {
      this.add(task);
      item = this.items.get(task)!;
    }
    return item;
  }
}

export class TransferBatchFailure extends TypedFailure {
  readonly result: TransferOperationResult;
  readonly firstCause: unknown;

  constructor(result: TransferOperationResult, firstCause?: unknown) {
    const onlyWarnings =
      result.warnings > 0 &&
      result.failed === 0 &&
      result.cancelled === 0 &&
      result.notStarted === 0;
    const onlyCancellation =
      result.completed === 0 &&
      result.failed === 0 &&
      (result.cancelled > 0 || result.notStarted > 0);
    const causeFailureId = firstCause === undefined
      ? undefined
      : classifyFailureId(firstCause);
    const specificCauseFailureId: FailureId | undefined =
      causeFailureId &&
      !['transfer.failed', 'operation.cancelled', 'operation.partial'].includes(
        causeFailureId
      )
        ? causeFailureId
        : undefined;
    const failureId = onlyWarnings
      ? 'backup.overwrite-failed'
      : onlyCancellation
        ? 'operation.cancelled'
        : specificCauseFailureId ||
          (result.completed > 0 || result.cancelled > 0 || result.notStarted > 0
            ? 'operation.partial'
            : 'transfer.failed');
    super(
      failureId,
      failureId === 'operation.partial'
        ? 'Transfer operation finished with partial results.'
        : 'Transfer operation failed.',
      { partialResult: result },
      firstCause
    );
    this.name = 'TransferBatchFailure';
    this.result = result;
    this.firstCause = firstCause;
    const causeCode =
      firstCause && typeof firstCause === 'object' && 'code' in firstCause
        ? (firstCause as { code?: unknown }).code
        : undefined;
    if (causeCode !== undefined) {
      (this as Error & { code?: unknown }).code = causeCode;
    }
  }
}
