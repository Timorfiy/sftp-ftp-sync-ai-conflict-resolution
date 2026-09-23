import {
  TransferBatchFailure,
  TransferOperation,
} from '../transferOperation';
import {
  classifyError,
  contextualizePathFailure,
} from '../../errors/actionable';

function task(path: string, options: {
  cancelled?: boolean;
  warnings?: string[];
} = {}) {
  let cancelled = !!options.cancelled;
  return {
    localFsPath: `C:\\workspace\\${path}`,
    srcFsPath: `/source/${path}`,
    targetFsPath: `/target/${path}`,
    getWarnings: () =>
      (options.warnings || []).map(message => ({
        failureId: 'backup.overwrite-failed',
        message,
      })),
    isCancelled: () => cancelled,
    cancel: () => {
      cancelled = true;
    },
  } as any;
}

describe('TransferOperation', () => {
  test('preserves completed, failed, cancelled, and warning outcomes', () => {
    const operation = new TransferOperation('batch-1');
    const completed = task('completed.txt');
    const failed = task('failed.txt');
    const cancelled = task('cancelled.txt');
    const warning = task('warning.txt', {
      warnings: ['Previous remote text may not be recoverable.'],
    });

    [completed, failed, cancelled, warning].forEach(item => operation.add(item));
    operation.start(completed);
    operation.finish(completed);
    operation.start(failed);
    operation.finish(failed, new Error('PASS secret-value'));
    operation.cancelQueued(cancelled);
    operation.start(warning);
    operation.finish(warning);

    expect(operation.result()).toEqual({
      operationId: 'batch-1',
      completed: 2,
      failed: 1,
      cancelled: 1,
      notStarted: 0,
      warnings: 1,
      isPartial: true,
      items: [
        expect.objectContaining({ status: 'completed', attempts: 1 }),
        expect.objectContaining({
          status: 'failed',
          attempts: 1,
          error: 'PASS [REDACTED]',
        }),
        expect.objectContaining({ status: 'cancelled', attempts: 0 }),
        expect.objectContaining({
          status: 'completed',
          attempts: 1,
          warnings: ['Previous remote text may not be recoverable.'],
        }),
      ],
    });
  });

  test('keeps safe retry attempts in one operation instead of erasing the first failure', () => {
    const operation = new TransferOperation('retry-batch');
    const firstAttempt = task('download.txt');
    const secondAttempt = task('download.txt');

    operation.add(firstAttempt);
    operation.start(firstAttempt);
    operation.finish(firstAttempt, Object.assign(new Error('connection lost'), {
      code: 'ECONNRESET',
    }));
    operation.add(secondAttempt);
    operation.start(secondAttempt);
    operation.finish(secondAttempt);

    const result = operation.result();
    expect(result.operationId).toBe('retry-batch');
    expect(result.completed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.items).toHaveLength(2);
  });

  test('classifies warning-only, cancellation-only, and mixed batch results', () => {
    const warningResult = {
      operationId: 'warning',
      completed: 1,
      failed: 0,
      cancelled: 0,
      notStarted: 0,
      warnings: 1,
      items: [],
      isPartial: true,
    };
    const cancelledResult = {
      ...warningResult,
      operationId: 'cancelled',
      completed: 0,
      cancelled: 2,
      warnings: 0,
    };
    const mixedResult = {
      ...warningResult,
      operationId: 'mixed',
      failed: 1,
      warnings: 0,
    };

    expect(new TransferBatchFailure(warningResult).failureId).toBe(
      'backup.overwrite-failed'
    );
    expect(new TransferBatchFailure(cancelledResult).failureId).toBe(
      'operation.cancelled'
    );
    expect(new TransferBatchFailure(mixedResult).failureId).toBe(
      'operation.partial'
    );
  });

  test.each([
    ['permission.denied', Object.assign(new Error('Permission denied'), { code: 'EACCES' })],
    [
      'path.remote-unavailable',
      contextualizePathFailure(
        Object.assign(new Error('No such file'), { code: 'ENOENT' }),
        'remote'
      ),
    ],
  ])('preserves runtime %s category with partial counts', (failureId, cause) => {
    const result = {
      operationId: 'runtime-boundary',
      completed: 1,
      failed: 1,
      cancelled: 0,
      notStarted: 0,
      warnings: 0,
      items: [],
      isPartial: true,
    };
    const failure = new TransferBatchFailure(result, cause);
    const actionable = classifyError(failure);

    expect(failure.failureId).toBe(failureId);
    expect(actionable.id).toBe(failureId);
    expect(actionable.partialResult).toEqual(result);
    expect(actionable.diagnostics).toContain(
      cause instanceof Error ? cause.message : String(cause)
    );
  });
});
