const mockShowQuickPick = jest.fn();
const mockShowInformationMessage = jest.fn();
const mockCandidates: any[] = [];

jest.mock('vscode', () => ({
  window: {
    showQuickPick: mockShowQuickPick,
  },
}));

jest.mock('../../host', () => ({
  showInformationMessage: mockShowInformationMessage,
}));

jest.mock('../../modules/serviceManager', () => ({
  getCredentialMigrationCandidates: jest.fn(() => mockCandidates),
}));

jest.mock('../abstract/createCommand', () => ({
  checkCommand: (value: unknown) => value,
}));

import command from '../commandDeleteSavedPassword';
import {
  createCredentialEndpoint,
  getCredential,
  getLegacyCredentialKey,
  initSecrets,
  storeCredential,
} from '../../modules/secrets';

class MemorySecretStorage {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function candidate(
  protocol: 'ftp' | 'sftp',
  port: number
) {
  const endpoint = createCredentialEndpoint({
    protocol,
    host: 'example.com',
    port,
    username: 'deploy',
  });
  return { endpoint, legacyHost: 'example.com' };
}

describe('delete saved password command', () => {
  let storage: MemorySecretStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCandidates.length = 0;
    storage = new MemorySecretStorage();
    initSecrets({ secrets: storage } as any);
  });

  test('deduplicates endpoints and deletes only the selected v2 credential', async () => {
    const sftp = candidate('sftp', 22);
    const ftp = candidate('ftp', 21);
    mockCandidates.push(sftp, sftp, ftp);
    await storeCredential(sftp.endpoint, 'password', 'sftp-password');
    await storeCredential(sftp.endpoint, 'passphrase', 'sftp-passphrase');
    await storeCredential(ftp.endpoint, 'password', 'ftp-password');
    mockShowQuickPick.mockImplementation(async (items: any[]) => [
      items.find(item =>
        item.description === 'sftp://deploy@example.com:22' &&
        item.credentialKind === 'password'
      ),
    ]);

    await (command.handleCommand as any)();

    const items = mockShowQuickPick.mock.calls[0][0];
    expect(items).toHaveLength(3);
    expect(items.map((item: any) => item.description)).toEqual(
      expect.arrayContaining([
        'sftp://deploy@example.com:22',
        'ftp://deploy@example.com:21',
      ])
    );
    await expect(
      getCredential(sftp.endpoint, 'password')
    ).resolves.toBeUndefined();
    await expect(
      getCredential(sftp.endpoint, 'passphrase')
    ).resolves.toBe('sftp-passphrase');
    await expect(
      getCredential(ftp.endpoint, 'password')
    ).resolves.toBe('ftp-password');
  });

  test('surfaces and deletes an ambiguous legacy credential', async () => {
    const sftp = candidate('sftp', 22);
    const ftp = candidate('ftp', 21);
    mockCandidates.push(sftp, ftp);
    const legacyKey = getLegacyCredentialKey(
      'example.com',
      'deploy',
      'password'
    );
    storage.values.set(legacyKey, 'ambiguous-password');
    mockShowQuickPick.mockImplementation(async (items: any[]) => [
      items.find(item => item.legacyKey === legacyKey),
    ]);

    await (command.handleCommand as any)();

    expect(
      mockShowQuickPick.mock.calls[0][0]
        .find((item: any) => item.legacyKey === legacyKey).description
    ).toContain('ambiguous endpoint');
    expect(storage.values.has(legacyKey)).toBe(false);
  });
});
