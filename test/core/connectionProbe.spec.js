jest.mock('../../src/core/remoteFs', () => ({
  createEphemeralRemoteFs: jest.fn(),
}));

const {
  classifyConnectionProbeError,
} = require('../../src/core/connectionProbe');
const { TypedFailure } = require('../../src/errors/actionable');

describe('connection probe error classification', () => {
  test.each([
    [{ code: 530, message: 'password=do-not-display' }, 'connect', 'Authentication'],
    [{ code: 'ECONNREFUSED', message: 'secret host detail' }, 'connect', 'Network'],
    [{ code: 'ENOENT', message: 'secret path detail' }, 'lstat', 'Remote path'],
    [{ code: 'EACCES', message: 'secret permission detail' }, 'list', 'Permission'],
    [{ code: 550, message: '550 Permission denied' }, 'lstat', 'Permission'],
    [{ code: 550, message: '550 Path unavailable' }, 'lstat', 'Remote path'],
  ])('classifies structured %s errors without echoing raw details', (error, stage, category) => {
    const result = classifyConnectionProbeError(error, stage);
    expect(result).toMatchObject({ ok: false, category });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });

  test('uses a safe generic fallback', () => {
    const result = classifyConnectionProbeError(
      { code: 'VENDOR_PRIVATE', message: 'password=hunter2' },
      'connect'
    );
    expect(result).toMatchObject({ ok: false, category: 'Connection' });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  test.each([
    ['configuration.invalid', 'Configuration'],
    ['authentication.rejected', 'Authentication'],
    ['network.unreachable', 'Network'],
    ['path.local-unavailable', 'Local path'],
    ['path.remote-unavailable', 'Remote path'],
    ['permission.denied', 'Permission'],
    ['host-key.changed', 'Host key'],
    ['host-key.rejected', 'Host key'],
    ['operation.cancelled', 'Cancelled'],
  ])('preserves the integrated %s contract without disclosing its raw message', (id, category) => {
    const error = new TypedFailure(id, 'private-diagnostic-canary', { protocol: 'sftp' });
    const result = classifyConnectionProbeError(error, 'connect');
    expect(result).toMatchObject({ ok: false, category });
    expect(result.nextStep).not.toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('private-diagnostic-canary');
  });
});
