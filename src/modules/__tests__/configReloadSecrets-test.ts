const mockReportError = jest.fn();
const mockRefresh = jest.fn();
const mockConfigs: any[] = [];
const mockCandidates: any[] = [];
const mockDisposedServices: any[] = [];
let mockMigrationError: Error | undefined;

jest.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  workspace: {
    getWorkspaceFolder: jest.fn(() => ({
      uri: { fsPath: 'C:\\workspace' },
    })),
    getConfiguration: jest.fn(() => ({
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    })),
  },
  window: {
    createOutputChannel: jest.fn(() => ({
      show: jest.fn(),
      hide: jest.fn(),
      appendLine: jest.fn(),
    })),
    createStatusBarItem: jest.fn(() => ({
      show: jest.fn(),
      hide: jest.fn(),
    })),
  },
  commands: {
    executeCommand: jest.fn(async () => undefined),
  },
}));

jest.mock('../../app', () => ({
  __esModule: true,
  default: {
    fsCache: new Map(),
    remoteExplorer: { refresh: mockRefresh },
    sftpBarItem: { updateStatus: jest.fn() },
  },
}));

jest.mock('../../helper', () => ({
  reportError: mockReportError,
  isValidFile: jest.fn(),
  isConfigFile: jest.fn(),
  isInWorkspace: jest.fn(),
}));

jest.mock('../../host', () => ({
  getUserSetting: jest.fn(() => ({
    get: jest.fn((_key: string, fallback: unknown) => fallback),
  })),
  onDidOpenTextDocument: jest.fn(),
  onDidRenameFiles: jest.fn(),
  onDidSaveTextDocument: jest.fn(),
  onWillRenameFiles: jest.fn(),
  onWillSaveTextDocument: jest.fn(),
  showConfirmMessage: jest.fn(),
}));

jest.mock('../config', () => ({
  readConfigsFromFile: jest.fn(async () => mockConfigs),
}));

jest.mock('../serviceManager', () => ({
  createFileService: jest.fn((config: any) => {
    const secrets = jest.requireActual('../secrets');
    mockCandidates.push({
      endpoint: secrets.createCredentialEndpoint(config),
      legacyHost: config.host,
    });
    return { config };
  }),
  disposeFileService: jest.fn((service: any) => {
    mockDisposedServices.push(service);
  }),
  findAllFileService: jest.fn(() => [{ workspace: 'C:\\workspace' }]),
  getFileService: jest.fn(),
  migrateLoadedServiceCredentials: jest.fn(async () => {
    if (mockMigrationError) {
      throw mockMigrationError;
    }
    const secrets = jest.requireActual('../secrets');
    await secrets.migrateLegacyCredentials(mockCandidates);
  }),
}));

jest.mock('../../fileHandlers', () => ({
  downloadFile: jest.fn(),
  renameRemote: jest.fn(),
  upload: jest.fn(),
  uploadFile: jest.fn(),
}));

import {
  createCredentialEndpoint,
  getCredential,
  getCredentialKey,
  getLegacyCredentialKey,
  initSecrets,
} from '../secrets';
import { handleConfigSave } from '../fileActivityMonitor';

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

const config = (
  protocol: 'ftp' | 'sftp',
  port: number
) => ({
  protocol,
  host: 'example.com',
  port,
  username: 'deploy',
});

describe('credential migration after sftp.json reload', () => {
  let storage: MemorySecretStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConfigs.length = 0;
    mockCandidates.length = 0;
    mockDisposedServices.length = 0;
    mockMigrationError = undefined;
    storage = new MemorySecretStorage();
    initSecrets({ secrets: storage } as any);
  });

  test('migrates a newly unique legacy value store-before-delete', async () => {
    const current = config('sftp', 22);
    mockConfigs.push(current);
    const endpoint = createCredentialEndpoint(current);
    const legacyKey = getLegacyCredentialKey(
      current.host,
      current.username,
      'password'
    );
    storage.values.set(legacyKey, 'reload-legacy-password');

    await handleConfigSave({ fsPath: 'C:\\workspace\\.vscode\\sftp.json' } as any);

    await expect(getCredential(endpoint, 'password')).resolves.toBe(
      'reload-legacy-password'
    );
    const v2Key = getCredentialKey(endpoint, 'password');
    expect(storage.operations.findIndex(item => item === `store:${v2Key}`))
      .toBeLessThan(
        storage.operations.findIndex(item => item === `delete:${legacyKey}`)
      );
    expect(mockRefresh).toHaveBeenCalled();
  });

  test('preserves v2 precedence during reload migration', async () => {
    const current = config('sftp', 22);
    mockConfigs.push(current);
    const endpoint = createCredentialEndpoint(current);
    storage.values.set(
      getLegacyCredentialKey(current.host, current.username, 'password'),
      'legacy-password'
    );
    storage.values.set(getCredentialKey(endpoint, 'password'), 'v2-password');

    await handleConfigSave({ fsPath: 'C:\\workspace\\.vscode\\sftp.json' } as any);

    await expect(getCredential(endpoint, 'password')).resolves.toBe('v2-password');
  });

  test('keeps a protocol-ambiguous legacy value inert after reload', async () => {
    const sftp = config('sftp', 22);
    const ftp = config('ftp', 21);
    mockConfigs.push(sftp, ftp);
    const legacyKey = getLegacyCredentialKey(
      sftp.host,
      sftp.username,
      'passphrase'
    );
    storage.values.set(legacyKey, 'ambiguous-passphrase');

    await handleConfigSave({ fsPath: 'C:\\workspace\\.vscode\\sftp.json' } as any);

    await expect(
      getCredential(createCredentialEndpoint(sftp), 'passphrase')
    ).resolves.toBeUndefined();
    await expect(
      getCredential(createCredentialEndpoint(ftp), 'passphrase')
    ).resolves.toBeUndefined();
    expect(storage.values.get(legacyKey)).toBe('ambiguous-passphrase');
  });

  test('reports migration failure without disposing newly created services', async () => {
    mockConfigs.push(config('sftp', 22));
    mockMigrationError = new Error('SecretStorage unavailable');

    await handleConfigSave({ fsPath: 'C:\\workspace\\.vscode\\sftp.json' } as any);

    expect(mockDisposedServices).toHaveLength(1);
    expect(mockReportError).toHaveBeenCalledWith(
      mockMigrationError,
      'migrate saved credentials after config reload'
    );
    expect(mockRefresh).toHaveBeenCalled();
  });
});
