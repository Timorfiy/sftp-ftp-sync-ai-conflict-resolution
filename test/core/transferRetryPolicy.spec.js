jest.mock('../../src/helper/error', () => ({
  isConnectionError: jest.fn(() => true),
}));
jest.mock('../../src/logger', () => ({
  __esModule: true,
  default: { info: jest.fn() },
}));

const {
  DEFAULT_TRANSFER_RETRY_ATTEMPTS,
  getTransferRetryAttempts,
} = require('../../src/fileHandlers/transfer/retryPolicy');
const {
  createTransferRetryOptions,
} = require('../../src/fileHandlers/transfer/retryOptions');
const { TransferDirection } = require('../../src/core/transferTask');

describe('transfer retry policy', () => {
  test('does not replay FTP transfers by default', () => {
    expect(getTransferRetryAttempts('ftp')).toBe(1);
  });

  test('uses the explicit FTP reconnect count', () => {
    expect(getTransferRetryAttempts('ftp', 0)).toBe(1);
    expect(getTransferRetryAttempts('ftp', 1)).toBe(2);
    expect(getTransferRetryAttempts('ftp', 2)).toBe(3);
  });

  test('keeps the upstream retry policy for non-FTP transfers', () => {
    expect(getTransferRetryAttempts('sftp')).toBe(DEFAULT_TRANSFER_RETRY_ATTEMPTS);
  });

  test.each([
    ['ftp', 2],
    ['sftp', undefined],
  ])('never retries %s uploads at the handler boundary', (protocol, ftpReconnectAttempts) => {
    const clearRemoteFileSystem = jest.fn();
    const options = createTransferRetryOptions({
      config: { protocol, ftpReconnectAttempts },
      fileService: { clearRemoteFileSystem },
    }, TransferDirection.LOCAL_TO_REMOTE);

    expect(options.maxAttempts).toBe(1);
  });

  test('retains configured reconnect attempts for safe downloads', () => {
    const options = createTransferRetryOptions({
      config: { protocol: 'ftp', ftpReconnectAttempts: 2 },
      fileService: { clearRemoteFileSystem: jest.fn() },
    }, TransferDirection.REMOTE_TO_LOCAL);

    expect(options.maxAttempts).toBe(3);
  });
});
