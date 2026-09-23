import * as output from '../ui/output';
import logger from '../logger';
import { showErrorMessage } from '../host';
import { redactedErrorMessage } from '../security/redaction';

const CONNECTION_ERROR_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /ENOTFOUND/i,
  /ECONNABORTED/i,
  /connection lost/i,
  /connection closed/i,
  /connection ended/i,
  /connection reset/i,
  /connection broken/i,
  /server closed/i,
  /client is closed/i,
  /socket closed/i,
  /no response from server/i,
  /unable to start subsystem/i,
  /ended by server/i,
  /\bfin\b/i,
];

export function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const message = (err as Error).message || '';
  const code = (err as { code?: unknown }).code || '';
  const text = `${message} ${code}`;
  return CONNECTION_ERROR_PATTERNS.some(pattern => pattern.test(text));
}

export function reportError(err: Error | string, ctx?: string) {
  const errorString = redactedErrorMessage(err);
  if (err instanceof Error) {
    logger.error(err, ctx);
  } else {
    logger.error(err, ctx);
  }

  showErrorMessage(errorString, 'Detail').then(result => {
    if (result === 'Detail') {
      output.show();
    }
  });
  return;
}
