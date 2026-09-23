import {
  actionableMessage,
  classifyError,
  ErrorContext,
  TypedFailure,
} from '../actionable';
import { RedactionScope } from '../../security/redaction';

function codedError(message: string, code: string | number): Error {
  return Object.assign(new Error(message), { code });
}

describe('actionable error taxonomy', () => {
  const partialResult = {
    operationId: 'operation-1',
    completed: 2,
    failed: 1,
    cancelled: 1,
    notStarted: 0,
    warnings: 1,
  };
  const fixtures: Array<[string, unknown, ErrorContext]> = [
    ['configuration.invalid', new Error('Invalid configuration in sftp.json'), {}],
    ['authentication.rejected', codedError('Login incorrect', 530), { protocol: 'ftp' }],
    ['network.unreachable', codedError('connect ECONNREFUSED', 'ECONNREFUSED'), {}],
    ['path.remote-unavailable', codedError('No such file', 'ENOENT'), { pathKind: 'remote' }],
    ['path.local-unavailable', codedError('No such file', 'ENOENT'), { pathKind: 'local' }],
    ['permission.denied', codedError('Permission denied', 'EACCES'), {}],
    ['host-key.changed', new Error('SSH host key has CHANGED'), {}],
    [
      'host-key.rejected',
      new TypedFailure('host-key.rejected', 'Host identity rejected'),
      {},
    ],
    ['ftp.timestamp-unavailable', new Error('timestamp-unavailable'), { protocol: 'ftp' }],
    ['conflict.unresolved', new Error('Remote file changed conflict'), {}],
    [
      'backup.overwrite-failed',
      new TypedFailure('backup.overwrite-failed', 'backup write failed'),
      {},
    ],
    [
      'backup.delete-preflight-failed',
      new TypedFailure('backup.delete-preflight-failed', 'backup failed', {
        backupProgress: { created: 1, total: 3, nothingDeleted: true },
      }),
      {},
    ],
    ['packaging.inspection-failed', new Error('VSIX security inspection failed'), {}],
    ['transfer.failed', new Error('Remote stream failed unexpectedly'), {}],
    ['operation.cancelled', new Error('Cancelled by user'), {}],
    ['operation.partial', new Error('Cancelled by user'), { partialResult }],
  ];

  test.each(fixtures)('maps representative fixture to %s', (expectedId, error, context) => {
    const result = classifyError(error, context);

    expect(result.id).toBe(expectedId);
    expect(result.title).not.toBe(error instanceof Error ? error.message : String(error));
    expect(result.nextStep.length).toBeGreaterThan(20);
    expect(result.troubleshootingSection).toMatch(/^[a-z-]+$/);
    expect(result.actions).toContain('troubleshoot');
    expect(result.actions).toContain('copy-diagnostics');
  });

  test('keeps the stable messages and recovery anchors snapshot', () => {
    expect(
      fixtures.map(([, error, context]) => {
        const result = classifyError(error, context);
        return {
          id: result.id,
          title: result.title,
          nextStep: result.nextStep,
          section: result.troubleshootingSection,
          retrySafety: result.retrySafety,
          severity: result.severity,
          actions: result.actions,
        };
      })
    ).toMatchSnapshot();
  });

  test('offers retry only with a safe callback', () => {
    const retry = jest.fn(async () => undefined);
    const safe = classifyError(codedError('connect ETIMEDOUT', 'ETIMEDOUT'), {
      retry,
    });
    const unsafe = classifyError(new Error('upload stream failed'), {
      retry,
      retrySafety: 'unsafe',
    });
    const noCallback = classifyError(codedError('connect ETIMEDOUT', 'ETIMEDOUT'));

    expect(safe.actions).toContain('retry');
    expect(unsafe.actions).not.toContain('retry');
    expect(noCallback.actions).not.toContain('retry');
  });

  test('does not guess remote for an uncontextualized missing path', () => {
    const actionable = classifyError(
      Object.assign(new Error('No such file'), { code: 'ENOENT' })
    );

    expect(actionable.id).toBe('transfer.failed');
    expect(actionable.troubleshootingSection).toBe('transfers');
  });

  test('builds copied diagnostics from a redacted allowlist', () => {
    const scope = new RedactionScope();
    scope.register('diagnostic-password-canary');
    const error = Object.assign(
      new Error('Authentication failed with diagnostic-password-canary'),
      {
        code: 530,
        password: 'unregistered-password-field',
        config: { privateKey: 'private-key-content' },
      }
    );

    const actionable = classifyError(error, {
      operation: 'connect',
      protocol: 'ftp',
    });
    const diagnostics = JSON.parse(actionable.diagnostics);

    expect(diagnostics).toEqual({
      failureId: 'authentication.rejected',
      operation: 'connect',
      protocol: 'ftp',
      retrySafety: 'safe',
      troubleshootingSection: 'authentication',
      causeCode: '530',
      causeMessage: 'Authentication failed with [REDACTED]',
    });
    expect(actionable.diagnostics).not.toContain('diagnostic-password-canary');
    expect(actionable.diagnostics).not.toContain('unregistered-password-field');
    expect(actionable.diagnostics).not.toContain('private-key-content');
    expect(actionable.diagnostics).not.toContain('stack');
    scope.dispose();
  });

  test('states partial counts and fail-closed backup progress accurately', () => {
    const partial = classifyError(new Error('cancelled'), { partialResult });
    const deleteFailure = classifyError(
      new TypedFailure('backup.delete-preflight-failed', 'failed', {
        backupProgress: { created: 2, total: 4, nothingDeleted: true },
      })
    );

    expect(actionableMessage(partial)).toContain(
      'Completed: 2; failed: 1; cancelled: 1; not started: 0; warnings: 1.'
    );
    expect(actionableMessage(deleteFailure)).toContain(
      'Backups created: 2/4; nothing deleted.'
    );
  });
});
