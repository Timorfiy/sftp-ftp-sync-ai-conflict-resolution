const {
  DEFAULT_TRANSFER_RETRY_ATTEMPTS,
  getTransferRetryAttempts,
} = require('../../src/fileHandlers/transfer/retryPolicy');

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
});
