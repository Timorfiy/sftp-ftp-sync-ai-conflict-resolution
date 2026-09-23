import * as vscode from 'vscode';
import { createHash } from 'crypto';

let _secrets: vscode.SecretStorage | undefined;
const migrationLocks = new Map<string, Promise<void>>();

export function initSecrets(context: vscode.ExtensionContext) {
  _secrets = context.secrets;
}

export type CredentialKind = 'password' | 'passphrase';
export type CredentialTransport =
  | 'sftp'
  | 'ftp'
  | 'ftps-explicit'
  | 'ftps-implicit';

export interface CredentialEndpoint {
  readonly transport: CredentialTransport;
  readonly host: string;
  readonly port: number;
  readonly username: string;
}

export interface CredentialMigrationCandidate {
  readonly endpoint: CredentialEndpoint;
  readonly legacyHost: string;
}

export interface LegacyCredential {
  readonly key: string;
  readonly host: string;
  readonly username: string;
  readonly kind: CredentialKind;
  readonly ambiguous: boolean;
}

function requireSecrets(): vscode.SecretStorage | undefined {
  return _secrets;
}

function normalizeTransport(
  protocol: unknown,
  secure?: unknown
): CredentialTransport {
  const normalized = String(protocol || '').trim().toLocaleLowerCase('en-US');
  if (normalized === 'sftp') {
    return 'sftp';
  }
  if (normalized !== 'ftp') {
    throw new Error(`Unsupported credential transport "${String(protocol)}".`);
  }
  if (secure === 'implicit') {
    return 'ftps-implicit';
  }
  if (secure === true || secure === 'control') {
    return 'ftps-explicit';
  }
  return 'ftp';
}

export function createCredentialEndpoint(config: {
  protocol?: unknown;
  transport?: unknown;
  host: unknown;
  port?: unknown;
  username?: unknown;
  secure?: unknown;
}): CredentialEndpoint {
  const transport = config.transport
    ? String(config.transport) as CredentialTransport
    : normalizeTransport(config.protocol, config.secure);
  if (
    !['sftp', 'ftp', 'ftps-explicit', 'ftps-implicit'].includes(transport)
  ) {
    throw new Error(`Unsupported credential transport "${transport}".`);
  }
  const host = typeof config.host === 'string'
    ? config.host.trim().toLocaleLowerCase('en-US')
    : '';
  const username = typeof config.username === 'string' ? config.username : '';
  const defaultPort = transport === 'sftp' ? 22 : 21;
  const port = config.port === undefined || config.port === null
    ? defaultPort
    : Number(config.port);

  if (!host || !username || !Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Credential endpoint requires a resolved host, port, and username.');
  }

  return Object.freeze({ transport, host, port, username });
}

export function credentialEndpointId(endpoint: CredentialEndpoint): string {
  return JSON.stringify([
    endpoint.transport,
    endpoint.host,
    endpoint.port,
    endpoint.username,
  ]);
}

export function getCredentialKey(
  endpoint: CredentialEndpoint,
  kind: CredentialKind
): string {
  const identity = JSON.stringify({
    kind,
    endpoint: [
      endpoint.transport,
      endpoint.host,
      endpoint.port,
      endpoint.username,
    ],
  });
  const digest = createHash('sha256').update(identity).digest('hex');
  return `sftp-sync-ai:credential:v2:${digest}`;
}

export function getLegacyCredentialKey(
  host: string,
  username: string,
  kind: CredentialKind
): string {
  return `sftp-neo:${host}:${username}:${kind}`;
}

export async function getCredential(
  endpoint: CredentialEndpoint,
  kind: CredentialKind
): Promise<string | undefined> {
  const secrets = requireSecrets();
  if (!secrets) {
    return undefined;
  }
  return secrets.get(getCredentialKey(endpoint, kind));
}

export async function storeCredential(
  endpoint: CredentialEndpoint,
  kind: CredentialKind,
  value: string
): Promise<void> {
  const secrets = requireSecrets();
  if (!secrets) {
    return;
  }
  await secrets.store(getCredentialKey(endpoint, kind), value);
}

export async function deleteCredential(
  endpoint: CredentialEndpoint,
  kind: CredentialKind
): Promise<void> {
  const secrets = requireSecrets();
  if (!secrets) {
    return;
  }
  await secrets.delete(getCredentialKey(endpoint, kind));
}

async function withMigrationLock(
  key: string,
  operation: () => Promise<void>
): Promise<void> {
  const previous = migrationLocks.get(key) || Promise.resolve();
  const current = previous.then(operation, operation);
  const tracked = current.then(() => undefined, () => undefined);
  migrationLocks.set(key, tracked);
  try {
    await current;
  } finally {
    if (migrationLocks.get(key) === tracked) {
      migrationLocks.delete(key);
    }
  }
}

function uniqueCandidates(
  candidates: readonly CredentialMigrationCandidate[]
): CredentialMigrationCandidate[] {
  const unique = new Map<string, CredentialMigrationCandidate>();
  for (const candidate of candidates) {
    const endpoint = createCredentialEndpoint(candidate.endpoint);
    const legacyHost = candidate.legacyHost.trim();
    if (!legacyHost) {
      continue;
    }
    unique.set(
      `${credentialEndpointId(endpoint)}\u0000${legacyHost}`,
      { endpoint, legacyHost }
    );
  }
  return [...unique.values()];
}

export async function migrateLegacyCredentials(
  candidates: readonly CredentialMigrationCandidate[]
): Promise<void> {
  const secrets = requireSecrets();
  if (!secrets) {
    return;
  }
  const groups = new Map<
    string,
    { endpoints: Map<string, CredentialEndpoint>; kind: CredentialKind }
  >();
  for (const candidate of uniqueCandidates(candidates)) {
    for (const kind of ['password', 'passphrase'] as const) {
      const key = getLegacyCredentialKey(
        candidate.legacyHost,
        candidate.endpoint.username,
        kind
      );
      const group = groups.get(key) || {
        endpoints: new Map<string, CredentialEndpoint>(),
        kind,
      };
      group.endpoints.set(
        credentialEndpointId(candidate.endpoint),
        candidate.endpoint
      );
      groups.set(key, group);
    }
  }

  await Promise.all(
    [...groups].map(([legacyKey, group]) =>
      withMigrationLock(legacyKey, async () => {
        if (group.endpoints.size !== 1) {
          return;
        }
        const legacyValue = await secrets.get(legacyKey);
        if (legacyValue === undefined) {
          return;
        }
        const endpoint = [...group.endpoints.values()][0];
        const v2Key = getCredentialKey(endpoint, group.kind);
        if ((await secrets.get(v2Key)) === undefined) {
          await secrets.store(v2Key, legacyValue);
        }
        await secrets.delete(legacyKey);
      })
    )
  );
}

export async function findLegacyCredentials(
  candidates: readonly CredentialMigrationCandidate[]
): Promise<LegacyCredential[]> {
  const secrets = requireSecrets();
  if (!secrets) {
    return [];
  }
  const grouped = new Map<
    string,
    { host: string; username: string; kind: CredentialKind; endpointIds: Set<string> }
  >();
  for (const candidate of uniqueCandidates(candidates)) {
    for (const kind of ['password', 'passphrase'] as const) {
      const key = getLegacyCredentialKey(
        candidate.legacyHost,
        candidate.endpoint.username,
        kind
      );
      const value = grouped.get(key) || {
        host: candidate.legacyHost,
        username: candidate.endpoint.username,
        kind,
        endpointIds: new Set<string>(),
      };
      value.endpointIds.add(credentialEndpointId(candidate.endpoint));
      grouped.set(key, value);
    }
  }
  const found: LegacyCredential[] = [];
  for (const [key, value] of grouped) {
    if ((await secrets.get(key)) !== undefined) {
      found.push({
        key,
        host: value.host,
        username: value.username,
        kind: value.kind,
        ambiguous: value.endpointIds.size > 1,
      });
    }
  }
  return found;
}

export async function deleteLegacyCredential(key: string): Promise<void> {
  const secrets = requireSecrets();
  if (secrets) {
    await secrets.delete(key);
  }
}
