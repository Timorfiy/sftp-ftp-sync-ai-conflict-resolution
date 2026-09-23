import {
  createCredentialEndpoint,
  deleteCredential,
  deleteLegacyCredential,
  findLegacyCredentials,
  getCredential,
  getCredentialKey,
  getLegacyCredentialKey,
  initSecrets,
  migrateLegacyCredentials,
  storeCredential,
} from '../secrets';

class MemorySecretStorage {
  readonly values = new Map<string, string>();
  readonly operations: string[] = [];

  async get(key: string): Promise<string | undefined> {
    this.operations.push(`get:${key}`);
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.operations.push(`store:${key}`);
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.operations.push(`delete:${key}`);
    this.values.delete(key);
  }
}

function endpoint(overrides: Record<string, unknown> = {}) {
  return createCredentialEndpoint({
    protocol: 'sftp',
    host: 'Example.COM',
    port: 22,
    username: 'deploy',
    ...overrides,
  });
}

function candidate(value = endpoint(), legacyHost = value.host) {
  return { endpoint: value, legacyHost };
}

describe('endpoint-scoped SecretStorage', () => {
  let storage: MemorySecretStorage;

  beforeEach(() => {
    storage = new MemorySecretStorage();
    initSecrets({ secrets: storage } as any);
  });

  test('canonicalizes host and resolves omitted default ports', () => {
    expect(
      createCredentialEndpoint({
        protocol: 'SFTP',
        host: ' Example.COM ',
        username: 'deploy',
      })
    ).toEqual(endpoint());
    expect(
      createCredentialEndpoint({
        protocol: 'ftp',
        host: 'Example.COM',
        username: 'deploy',
      }).port
    ).toBe(21);
  });

  test('isolates protocol, port, username, and credential kind', async () => {
    const sftp = endpoint();
    const ftp = endpoint({ protocol: 'ftp', port: 21 });
    const alternatePort = endpoint({ port: 2222 });
    const alternateUser = endpoint({ username: 'other' });

    await storeCredential(sftp, 'password', 'sftp-password');
    await storeCredential(ftp, 'password', 'ftp-password');
    await storeCredential(alternatePort, 'password', 'port-password');
    await storeCredential(alternateUser, 'password', 'user-password');
    await storeCredential(sftp, 'passphrase', 'sftp-passphrase');

    await expect(getCredential(sftp, 'password')).resolves.toBe('sftp-password');
    await expect(getCredential(ftp, 'password')).resolves.toBe('ftp-password');
    await expect(getCredential(alternatePort, 'password')).resolves.toBe('port-password');
    await expect(getCredential(alternateUser, 'password')).resolves.toBe('user-password');
    await expect(getCredential(sftp, 'passphrase')).resolves.toBe('sftp-passphrase');

    await deleteCredential(ftp, 'password');
    await expect(getCredential(ftp, 'password')).resolves.toBeUndefined();
    await expect(getCredential(sftp, 'password')).resolves.toBe('sftp-password');
  });

  test('uses delimiter-safe versioned hashed keys', () => {
    const first = endpoint({ host: 'a:b', username: 'c' });
    const second = endpoint({ host: 'a', username: 'b:c' });
    const firstKey = getCredentialKey(first, 'password');
    const secondKey = getCredentialKey(second, 'password');

    expect(firstKey).toMatch(/^sftp-sync-ai:credential:v2:[0-9a-f]{64}$/);
    expect(secondKey).toMatch(/^sftp-sync-ai:credential:v2:[0-9a-f]{64}$/);
    expect(firstKey).not.toBe(secondKey);
  });

  test('migrates a uniquely mappable legacy value store-before-delete', async () => {
    const target = endpoint();
    const legacyKey = getLegacyCredentialKey('example.com', 'deploy', 'password');
    storage.values.set(legacyKey, 'legacy-password');

    await migrateLegacyCredentials([candidate(target)]);

    await expect(getCredential(target, 'password')).resolves.toBe('legacy-password');
    expect(storage.values.has(legacyKey)).toBe(false);
    const storeIndex = storage.operations.findIndex(item =>
      item.startsWith(`store:${getCredentialKey(target, 'password')}`)
    );
    const deleteIndex = storage.operations.indexOf(`delete:${legacyKey}`);
    expect(storeIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(storeIndex);
  });

  test('keeps an existing v2 value while retiring a unique legacy value', async () => {
    const target = endpoint();
    const legacyKey = getLegacyCredentialKey('example.com', 'deploy', 'password');
    storage.values.set(legacyKey, 'legacy-password');
    await storeCredential(target, 'password', 'v2-password');

    await migrateLegacyCredentials([candidate(target)]);

    await expect(getCredential(target, 'password')).resolves.toBe('v2-password');
    expect(storage.values.has(legacyKey)).toBe(false);
  });

  test('leaves an ambiguous legacy value inert and detectable for deletion', async () => {
    const first = endpoint({ protocol: 'sftp', port: 22 });
    const second = endpoint({ protocol: 'ftp', port: 21 });
    const candidates = [candidate(first), candidate(second)];
    const legacyKey = getLegacyCredentialKey('example.com', 'deploy', 'password');
    storage.values.set(legacyKey, 'ambiguous-password');

    await migrateLegacyCredentials(candidates);

    await expect(getCredential(first, 'password')).resolves.toBeUndefined();
    await expect(getCredential(second, 'password')).resolves.toBeUndefined();
    expect(storage.values.get(legacyKey)).toBe('ambiguous-password');
    await expect(findLegacyCredentials(candidates)).resolves.toContainEqual({
      key: legacyKey,
      host: 'example.com',
      username: 'deploy',
      kind: 'password',
      ambiguous: true,
    });
    await deleteLegacyCredential(legacyKey);
    await expect(findLegacyCredentials(candidates)).resolves.toEqual([]);
  });

  test('does not migrate one legacy value across distinct ports', async () => {
    const first = endpoint({ port: 22 });
    const second = endpoint({ port: 2222 });
    const candidates = [candidate(first), candidate(second)];
    const legacyKey = getLegacyCredentialKey(
      'example.com',
      'deploy',
      'passphrase'
    );
    storage.values.set(legacyKey, 'ambiguous-passphrase');

    await migrateLegacyCredentials(candidates);

    await expect(getCredential(first, 'passphrase')).resolves.toBeUndefined();
    await expect(getCredential(second, 'passphrase')).resolves.toBeUndefined();
    expect(storage.values.get(legacyKey)).toBe('ambiguous-passphrase');
  });

  test('profile names and workspaces are not credential identity inputs', () => {
    const first = createCredentialEndpoint({
      protocol: 'sftp',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      profile: 'development',
      workspace: 'C:\\one',
    } as any);
    const second = createCredentialEndpoint({
      protocol: 'sftp',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      profile: 'production',
      workspace: 'C:\\two',
    } as any);

    expect(Object.isFrozen(first)).toBe(true);
    expect(getCredentialKey(first, 'password')).toBe(
      getCredentialKey(second, 'password')
    );
  });

  test('migration is idempotent and serialized for concurrent callers', async () => {
    const target = endpoint();
    const legacyKey = getLegacyCredentialKey('example.com', 'deploy', 'password');
    storage.values.set(legacyKey, 'legacy-password');

    await Promise.all([
      migrateLegacyCredentials([candidate(target)]),
      migrateLegacyCredentials([candidate(target)]),
      migrateLegacyCredentials([candidate(target)]),
    ]);
    await migrateLegacyCredentials([candidate(target)]);

    await expect(getCredential(target, 'password')).resolves.toBe('legacy-password');
    expect(
      storage.operations.filter(item =>
        item.startsWith(`store:${getCredentialKey(target, 'password')}`)
      )
    ).toHaveLength(1);
    expect(storage.operations.filter(item => item === `delete:${legacyKey}`)).toHaveLength(1);
  });
});
