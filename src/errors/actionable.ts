import { redactText, redactedErrorMessage } from '../security/redaction';

export type FailureId =
  | 'configuration.invalid'
  | 'authentication.rejected'
  | 'network.unreachable'
  | 'path.remote-unavailable'
  | 'path.local-unavailable'
  | 'permission.denied'
  | 'host-key.changed'
  | 'host-key.rejected'
  | 'ftp.timestamp-unavailable'
  | 'conflict.unresolved'
  | 'backup.overwrite-failed'
  | 'backup.delete-preflight-failed'
  | 'packaging.inspection-failed'
  | 'transfer.failed'
  | 'operation.cancelled'
  | 'operation.partial';

export type RecoveryActionId =
  | 'open-config'
  | 'retry'
  | 'review-conflict'
  | 'copy-diagnostics'
  | 'troubleshoot'
  | 'show-output';

export type RetrySafety = 'safe' | 'unsafe' | 'not-applicable';

export interface TransferResultSummary {
  operationId: string;
  completed: number;
  failed: number;
  cancelled: number;
  notStarted: number;
  warnings: number;
}

export interface ErrorContext {
  operation?: string;
  protocol?: 'ftp' | 'ftps' | 'sftp';
  pathKind?: 'local' | 'remote';
  failureId?: FailureId;
  retrySafety?: RetrySafety;
  retry?: () => Promise<unknown>;
  openConfig?: boolean;
  reviewConflict?: () => Promise<unknown>;
  partialResult?: TransferResultSummary;
  backupProgress?: {
    created: number;
    total: number;
    nothingDeleted: boolean;
  };
}

export interface ActionableError {
  id: FailureId;
  title: string;
  summary: string;
  nextStep: string;
  troubleshootingSection: string;
  retrySafety: RetrySafety;
  severity: 'error' | 'warning' | 'information';
  actions: RecoveryActionId[];
  diagnostics: string;
  partialResult?: TransferResultSummary;
  backupProgress?: ErrorContext['backupProgress'];
}

export class TypedFailure extends Error {
  readonly failureId: FailureId;
  readonly context: ErrorContext;
  readonly cause: unknown;

  constructor(
    failureId: FailureId,
    message: string,
    context: ErrorContext = {},
    cause?: unknown
  ) {
    super(message);
    this.name = 'TypedFailure';
    this.failureId = failureId;
    this.context = context;
    this.cause = cause;
  }
}

interface FailureDefinition {
  title: string;
  summary: string;
  nextStep: string;
  section: string;
  retrySafety: RetrySafety;
  severity?: ActionableError['severity'];
  actions?: RecoveryActionId[];
}

const DEFINITIONS: Record<FailureId, FailureDefinition> = {
  'configuration.invalid': {
    title: 'Configuration needs attention',
    summary: 'The workspace configuration could not be loaded or validated.',
    nextStep: 'Open sftp.json, fix the reported setting, and run the command again.',
    section: 'configuration',
    retrySafety: 'not-applicable',
    actions: ['open-config'],
  },
  'authentication.rejected': {
    title: 'Authentication was rejected',
    summary: 'The server did not accept the configured or prompted credentials.',
    nextStep: 'Verify the username and credential source, then reconnect.',
    section: 'authentication',
    retrySafety: 'safe',
  },
  'network.unreachable': {
    title: 'Server could not be reached',
    summary: 'The connection was refused, interrupted, or timed out.',
    nextStep: 'Check the host, port, VPN, firewall, and server availability.',
    section: 'network',
    retrySafety: 'safe',
  },
  'path.remote-unavailable': {
    title: 'Remote path is unavailable',
    summary: 'The server could not find or access the requested remote path.',
    nextStep: 'Verify remotePath and the item path, including letter case.',
    section: 'remote-paths',
    retrySafety: 'safe',
  },
  'path.local-unavailable': {
    title: 'Local path is unavailable',
    summary: 'The local file or folder could not be read or created.',
    nextStep: 'Verify the workspace path and local filesystem access.',
    section: 'local-paths',
    retrySafety: 'safe',
  },
  'permission.denied': {
    title: 'Permission was denied',
    summary: 'The account or local process is not allowed to perform this operation.',
    nextStep: 'Check server ownership/mode or Windows file access before trying again.',
    section: 'permissions',
    retrySafety: 'unsafe',
  },
  'host-key.changed': {
    title: 'SSH host key changed',
    summary: 'The received SFTP host key does not match the saved key.',
    nextStep: 'Verify the fingerprint with the server owner, then update the known-host entry manually.',
    section: 'host-keys',
    retrySafety: 'not-applicable',
  },
  'host-key.rejected': {
    title: 'SSH host key was not accepted',
    summary: 'The SFTP connection stopped because the host identity was rejected.',
    nextStep: 'Verify the fingerprint before reconnecting; it will not be accepted automatically.',
    section: 'host-keys',
    retrySafety: 'not-applicable',
    severity: 'information',
  },
  'ftp.timestamp-unavailable': {
    title: 'FTP timestamp is unavailable',
    summary: 'The FTP server did not provide an exact modification time for a safe comparison.',
    nextStep: 'Review the captured conflict and compare both versions before overwriting.',
    section: 'ftp-timestamps',
    retrySafety: 'not-applicable',
    severity: 'warning',
    actions: ['review-conflict'],
  },
  'conflict.unresolved': {
    title: 'Transfer conflict needs a decision',
    summary: 'The remote item changed or cannot be compared safely.',
    nextStep: 'Open the diff and choose whether to keep or overwrite the remote version.',
    section: 'conflicts',
    retrySafety: 'not-applicable',
    severity: 'warning',
    actions: ['review-conflict'],
  },
  'backup.overwrite-failed': {
    title: 'Upload completed without an overwrite backup',
    summary: 'The configured backup could not be created, but the upload continued.',
    nextStep: 'Verify the uploaded file and fix backup access; the previous remote text may not be recoverable.',
    section: 'overwrite-backups',
    retrySafety: 'unsafe',
    severity: 'warning',
  },
  'backup.delete-preflight-failed': {
    title: 'Delete stopped because backup failed',
    summary: 'At least one promised backup copy could not be created, so nothing was deleted.',
    nextStep: 'Review the copies already created, fix backup access, and start the delete again.',
    section: 'delete-backups',
    retrySafety: 'unsafe',
  },
  'packaging.inspection-failed': {
    title: 'Package inspection failed',
    summary: 'The local VSIX is missing or contains content that cannot be shipped.',
    nextStep: 'Review the redacted inspection output, fix the package contents, and rebuild locally.',
    section: 'packaging',
    retrySafety: 'safe',
  },
  'transfer.failed': {
    title: 'Transfer failed',
    summary: 'The item could not be transferred.',
    nextStep: 'Inspect the completed and failed queue entries before choosing a recovery action.',
    section: 'transfers',
    retrySafety: 'unsafe',
  },
  'operation.cancelled': {
    title: 'Operation cancelled',
    summary: 'The operation was cancelled and queued items were not started.',
    nextStep: 'Review completed and cancelled queue entries before starting another operation.',
    section: 'partial-results',
    retrySafety: 'not-applicable',
    severity: 'information',
  },
  'operation.partial': {
    title: 'Operation finished with partial results',
    summary: 'Some items completed while others failed, were cancelled, or were not started.',
    nextStep: 'Review the retained queue entries and retry only operations documented as safe.',
    section: 'partial-results',
    retrySafety: 'unsafe',
    severity: 'warning',
  },
};

const NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
]);

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return '';
  }
  return String((error as { code?: unknown }).code || '').toUpperCase();
}

function inferFailureId(error: unknown, context: ErrorContext): FailureId {
  if (context.failureId) {
    return context.failureId;
  }
  if (error instanceof TypedFailure) {
    return error.failureId;
  }

  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const text = `${code} ${message}`;

  if (/host key.+changed|host key.+mismatch|man-in-the-middle/i.test(text)) {
    return 'host-key.changed';
  }
  if (/host key.+reject|host identity.+reject/i.test(text)) {
    return 'host-key.rejected';
  }
  if (/cancel(?:led|ed)|aborted by (?:the )?user/i.test(text)) {
    return context.partialResult ? 'operation.partial' : 'operation.cancelled';
  }
  if (/timestamp-unavailable|exact (?:remote )?modification time/i.test(text)) {
    return 'ftp.timestamp-unavailable';
  }
  if (/conflict|remote.+changed|stale decision/i.test(text)) {
    return 'conflict.unresolved';
  }
  if (/vsix|packag(?:e|ing).+inspect|forbidden path|secret canary/i.test(text)) {
    return 'packaging.inspection-failed';
  }
  if (/invalid config|configuration|unsupported protocol|sftp\.json/i.test(text)) {
    return 'configuration.invalid';
  }
  if (
    code === '530' ||
    /authentication|all configured authentication methods failed|login (?:incorrect|failed)|bad credentials/i.test(
      text
    )
  ) {
    return 'authentication.rejected';
  }
  if (NETWORK_CODES.has(code) || /connection.+(?:closed|lost|reset|refused)|timed?\s*out/i.test(text)) {
    return 'network.unreachable';
  }
  if (code === 'EACCES' || code === 'EPERM' || /permission denied|not permitted|access denied/i.test(text)) {
    return 'permission.denied';
  }
  if (code === 'ENOENT' || /no such file|not found|file unavailable/i.test(text)) {
    if (context.pathKind === 'local') {
      return 'path.local-unavailable';
    }
    if (context.pathKind === 'remote') {
      return 'path.remote-unavailable';
    }
    return context.partialResult ? 'operation.partial' : 'transfer.failed';
  }
  return context.partialResult ? 'operation.partial' : 'transfer.failed';
}

export function classifyFailureId(
  error: unknown,
  context: ErrorContext = {}
): FailureId {
  return inferFailureId(error, context);
}

export function contextualizePathFailure(
  error: unknown,
  pathKind: NonNullable<ErrorContext['pathKind']>
): unknown {
  if (error instanceof TypedFailure) {
    return error;
  }
  const failureId = inferFailureId(error, { pathKind });
  if (
    failureId !== 'path.local-unavailable' &&
    failureId !== 'path.remote-unavailable'
  ) {
    return error;
  }
  const failure = new TypedFailure(
    failureId,
    redactedErrorMessage(error),
    { pathKind },
    error
  );
  const code = errorCode(error);
  if (code) {
    (failure as Error & { code?: string }).code = code;
  }
  return failure;
}

export async function withPathFailure<T>(
  pathKind: NonNullable<ErrorContext['pathKind']>,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw contextualizePathFailure(error, pathKind);
  }
}

function mergedContext(error: unknown, context: ErrorContext): ErrorContext {
  if (!(error instanceof TypedFailure)) {
    return context;
  }
  return {
    ...error.context,
    ...context,
    partialResult: context.partialResult || error.context.partialResult,
  };
}

function diagnosticObject(
  error: unknown,
  id: FailureId,
  context: ErrorContext,
  definition: FailureDefinition
): Record<string, unknown> {
  const diagnosticCause =
    error instanceof TypedFailure && error.cause !== undefined
      ? error.cause
      : error;
  const result: Record<string, unknown> = {
    failureId: id,
    operation: context.operation,
    protocol: context.protocol,
    retrySafety: context.retrySafety || definition.retrySafety,
    troubleshootingSection: definition.section,
    causeCode: errorCode(error) || undefined,
    causeMessage: redactedErrorMessage(diagnosticCause),
  };
  if (context.partialResult) {
    result.partialResult = {
      operationId: context.partialResult.operationId,
      completed: context.partialResult.completed,
      failed: context.partialResult.failed,
      cancelled: context.partialResult.cancelled,
      notStarted: context.partialResult.notStarted,
      warnings: context.partialResult.warnings,
    };
  }
  if (context.backupProgress) {
    result.backupProgress = {
      created: context.backupProgress.created,
      total: context.backupProgress.total,
      nothingDeleted: context.backupProgress.nothingDeleted,
    };
  }
  return result;
}

export function classifyError(error: unknown, suppliedContext: ErrorContext = {}): ActionableError {
  const context = mergedContext(error, suppliedContext);
  const id = inferFailureId(error, context);
  const definition = DEFINITIONS[id];
  const retrySafety = context.retrySafety || definition.retrySafety;
  const actions = new Set<RecoveryActionId>(definition.actions || []);

  if (retrySafety === 'safe' && context.retry) {
    actions.add('retry');
  }
  if (context.openConfig) {
    actions.add('open-config');
  }
  if (context.reviewConflict) {
    actions.add('review-conflict');
  }
  actions.add('copy-diagnostics');
  actions.add('troubleshoot');
  actions.add('show-output');

  return {
    id,
    title: definition.title,
    summary: definition.summary,
    nextStep: definition.nextStep,
    troubleshootingSection: definition.section,
    retrySafety,
    severity: definition.severity || 'error',
    actions: [...actions],
    diagnostics: redactText(
      JSON.stringify(diagnosticObject(error, id, context, definition), null, 2)
    ),
    partialResult: context.partialResult,
    backupProgress: context.backupProgress,
  };
}

export function actionableMessage(error: ActionableError): string {
  const result = error.partialResult;
  const counts = result
    ? ` Completed: ${result.completed}; failed: ${result.failed}; cancelled: ${result.cancelled}; not started: ${result.notStarted}; warnings: ${result.warnings}.`
    : '';
  const backupCounts = error.backupProgress
    ? ` Backups created: ${error.backupProgress.created}/${error.backupProgress.total}; nothing deleted.`
    : '';
  return `${error.title}: ${error.summary}${counts}${backupCounts} ${error.nextStep}`;
}
