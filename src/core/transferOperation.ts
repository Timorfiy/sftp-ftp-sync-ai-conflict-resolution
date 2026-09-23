import { randomUUID } from 'crypto';
import TransferTask from './transferTask';
import {
  classifyFailureId,
  FailureId,
  TransferResultSummary,
  TypedFailure,
} from '../errors/actionable';
import { redactedErrorMessage } from '../security/redaction';

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
}

export class TransferOperation {
  readonly id: string;
  private readonly items = new Map<TransferTask, MutableTransferItem>();
  private sequence = 0;

  constructor(id: string = randomUUID()) {
    this.id = id;
  }

  add(task: TransferTask): void {
    const existing = this.items.get(task);
    if (existing) {
      existing.status = 'pending';
      return;
    }
    this.items.set(task, {
      id: `${this.id}:${++this.sequence}`,
      task,
      status: 'pending',
      attempts: 0,
      warnings: [],
    });
  }

  start(task: TransferTask): void {
    const item = this.requireItem(task);
    item.status = 'running';
    item.attempts += 1;
  }

  finish(task: TransferTask, error?: unknown): void {
    const item = this.requireItem(task);
    item.warnings = task.getWarnings().map(warning => warning.message);
    if (task.isCancelled()) {
      item.status = 'cancelled';
      item.error = undefined;
    } else if (error) {
      item.status = 'failed';
      item.error = redactedErrorMessage(error);
    } else {
      item.status = 'completed';
      item.error = undefined;
    }
  }

  cancelQueued(task: TransferTask): void {
    const item = this.requireItem(task);
    item.status = 'cancelled';
    task.cancel();
  }

  markNotStarted(task: TransferTask): void {
    const item = this.requireItem(task);
    item.status = 'not-started';
  }

  result(): TransferOperationResult {
    const items = [...this.items.values()].map(item => ({
      id: item.id,
      localPath: item.task.localFsPath,
      sourcePath: item.task.srcFsPath,
      targetPath: item.task.targetFsPath,
      status: item.status,
      attempts: item.attempts,
      warnings: [...item.warnings],
      error: item.error,
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
