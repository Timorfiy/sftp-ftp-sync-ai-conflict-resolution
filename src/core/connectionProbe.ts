import { FileType, RemoteFileSystem } from './fs';
import { createEphemeralRemoteFs } from './remoteFs';
import { ConnectOption } from './remote-client/remoteClient';
import { RedactionScope } from '../security/redaction';

export type ConnectionProbeCategory =
  | 'Configuration'
  | 'Authentication'
  | 'Network'
  | 'Remote path'
  | 'Permission'
  | 'Connection';

export type ConnectionProbeResult =
  | {
      ok: true;
      protocol: 'ftp' | 'sftp';
      profile: string;
      remotePath: string;
      message: string;
    }
  | {
      ok: false;
      category: ConnectionProbeCategory;
      message: string;
      nextStep: string;
    };

type ProbeStage = 'connect' | 'lstat' | 'list';

interface ProtocolError {
  code?: string | number;
  level?: string;
  message?: string;
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
  '421',
  '425',
  '426',
]);

function failure(
  category: ConnectionProbeCategory,
  message: string,
  nextStep: string
): ConnectionProbeResult {
  return { ok: false, category, message, nextStep };
}

function disconnectedFailure(): ConnectionProbeResult {
  return failure(
    'Network',
    'The connection closed while reading the configured remotePath.',
    'Check network stability, VPN/firewall rules, and the server timeout, then try again.'
  );
}

export function classifyConnectionProbeError(
  error: unknown,
  stage: ProbeStage
): ConnectionProbeResult {
  const protocolError = (error || {}) as ProtocolError;
  const code = protocolError.code;
  const codeText = String(code || '').toUpperCase();
  const message = String(protocolError.message || '');

  if (
    NETWORK_CODES.has(codeText) ||
    /connect (?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|timed out while waiting for handshake|connection (?:lost|closed|reset)|server sent fin|closed unexpectedly/i.test(message)
  ) {
    return failure(
      'Network',
      'The server could not be reached.',
      'Check the host, port, VPN/firewall, and selected FTP network interface, then try again.'
    );
  }

  if (
    stage === 'connect' &&
    (
      Number(code) === 530 ||
      protocolError.level === 'client-authentication' ||
      /all configured authentication methods failed|authentication failed|login incorrect/i.test(message)
    )
  ) {
    return failure(
      'Authentication',
      'The server rejected the credentials.',
      'Check the username and authentication method, then update or re-enter the saved password/passphrase.'
    );
  }

  if (
    Number(code) === 550 &&
    /\b(?:permission|access) denied\b|\bnot permitted\b/i.test(message)
  ) {
    return failure(
      'Permission',
      'The account cannot read and list the configured remotePath.',
      'Grant directory read/list permission or choose a remotePath this account can access.'
    );
  }

  if (stage === 'lstat' && (codeText === 'ENOENT' || Number(code) === 2 || Number(code) === 550)) {
    return failure(
      'Remote path',
      'The configured remotePath does not exist or is not accessible as a directory.',
      'Correct remotePath in .vscode/sftp.json and run Test Connection again.'
    );
  }

  if (
    (stage === 'lstat' || stage === 'list') &&
    (codeText === 'EACCES' || Number(code) === 3 || Number(code) === 550)
  ) {
    return failure(
      'Permission',
      'The account cannot read and list the configured remotePath.',
      'Grant directory read/list permission or choose a remotePath this account can access.'
    );
  }

  if (stage === 'list') {
    return failure(
      'Permission',
      'The connection succeeded, but the configured remotePath could not be listed.',
      'Verify directory permissions and that remotePath names a readable directory.'
    );
  }

  return failure(
    'Connection',
    'The connection test failed for an unclassified protocol reason.',
    'Verify the connection settings and inspect the SFTP output for redacted protocol details.'
  );
}

export async function probeConnection(
  option: ConnectOption & {
    protocol: 'ftp' | 'sftp';
    remoteTimeOffsetInHours: number;
  },
  remotePath: string,
  profile: string
): Promise<ConnectionProbeResult> {
  let remoteFs: RemoteFileSystem | undefined;
  const redactionScope = new RedactionScope();
  try {
    try {
      remoteFs = await createEphemeralRemoteFs(option, redactionScope);
    } catch (error) {
      return classifyConnectionProbeError(error, 'connect');
    }

    let stat;
    try {
      stat = await remoteFs.lstat(remotePath);
    } catch (error) {
      if (remoteFs.getClient().isClosed()) {
        return disconnectedFailure();
      }
      return classifyConnectionProbeError(error, 'lstat');
    }
    if (stat.type !== FileType.Directory) {
      return failure(
        'Remote path',
        'The configured remotePath is not a directory.',
        'Choose a remote directory in .vscode/sftp.json and run Test Connection again.'
      );
    }

    try {
      await remoteFs.list(remotePath);
    } catch (error) {
      if (remoteFs.getClient().isClosed()) {
        return disconnectedFailure();
      }
      return classifyConnectionProbeError(error, 'list');
    }

    return {
      ok: true,
      protocol: option.protocol,
      profile,
      remotePath,
      message: `Connected with ${option.protocol.toUpperCase()} and read ${remotePath}. No remote data was changed.`,
    };
  } finally {
    try {
      if (remoteFs) {
        remoteFs.end();
      }
    } finally {
      redactionScope.dispose();
    }
  }
}
