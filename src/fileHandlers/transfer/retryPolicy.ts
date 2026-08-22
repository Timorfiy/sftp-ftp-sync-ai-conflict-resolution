export const DEFAULT_TRANSFER_RETRY_ATTEMPTS = 3;

export function getTransferRetryAttempts(
  protocol: string,
  ftpReconnectAttempts?: number
): number {
  if (protocol !== 'ftp') {
    return DEFAULT_TRANSFER_RETRY_ATTEMPTS;
  }

  // Replaying a complete FTP upload can duplicate writes and open additional
  // control/data connections while a shared host is already unhealthy. Keep
  // FTP retries opt-in through the fork-specific compatibility option.
  const reconnectAttempts = ftpReconnectAttempts ?? 0;
  return Math.max(1, Math.floor(reconnectAttempts) + 1);
}
