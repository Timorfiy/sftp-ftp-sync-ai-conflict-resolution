import type { FileHandlerContext } from '../createFileHandler';
import { TransferDirection } from '../../core/transferTask';
import { isConnectionError } from '../../helper/error';
import logger from '../../logger';
import { getTransferRetryAttempts } from './retryPolicy';

type RetryContext = Pick<FileHandlerContext, 'config' | 'fileService'>;

export function createTransferRetryOptions(
  context: RetryContext,
  direction: TransferDirection
) {
  const maxAttempts = direction === TransferDirection.REMOTE_TO_LOCAL
    ? getTransferRetryAttempts(
      context.config.protocol,
      context.config.ftpReconnectAttempts
    )
    : 1;

  return {
    maxAttempts,
    shouldRetry: isConnectionError,
    onRetry: (_err: unknown, attempt: number) => {
      logger.info(
        `Connection lost during transfer (attempt ${attempt}/${maxAttempts - 1}). Reconnecting...`
      );
      context.fileService.clearRemoteFileSystem(context.config);
    },
  };
}
