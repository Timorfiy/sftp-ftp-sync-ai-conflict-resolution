const mockConnectErrors: Array<Error | undefined> = [];

jest.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((_key: string, fallback: unknown) => fallback),
      update: jest.fn(async () => undefined),
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
    showWarningMessage: jest.fn(async () => undefined),
    showInformationMessage: jest.fn(async () => undefined),
    showInputBox: jest.fn(async () => undefined),
  },
  commands: {
    executeCommand: jest.fn(async () => undefined),
  },
  Uri: {
    file: jest.fn((fsPath: string) => ({ fsPath, scheme: 'file' })),
  },
}));

jest.mock('../../app', () => ({
  __esModule: true,
  default: {
    fsCache: new Map(),
    state: { profile: null },
    sftpBarItem: {
      showMsg: jest.fn(),
      reset: jest.fn(),
    },
  },
}));

jest.mock('../remote-client/hostKeyStore', () => ({
  checkHostKey: jest.fn(async () => true),
}));

jest.mock('../../modules/connectionHealth', () => ({
  setConnectionState: jest.fn(),
  removeConnection: jest.fn(),
}));

jest.mock('../fs', () => {
  const actual = jest.requireActual('../fs');
  class FakeRemoteFileSystem {
    private closed = false;

    constructor(_resolver: unknown, _options: unknown) {}

    async connect(): Promise<void> {
      const error = mockConnectErrors.shift();
      if (error) {
        this.closed = true;
        throw error;
      }
      this.closed = false;
    }

    onDisconnected(_callback: () => void) {}

    getClient() {
      return {
        isClosed: () => this.closed,
      };
    }

    end() {
      this.closed = true;
    }
  }

  return {
    ...actual,
    SFTPFileSystem: FakeRemoteFileSystem,
    FTPFileSystem: FakeRemoteFileSystem,
  };
});

import FileService from '../fileService';
import {
  createCredentialEndpoint,
  initSecrets,
  storeCredential,
} from '../../modules/secrets';
import { getAllRemoteFs, remoteCacheIdentity } from '../remoteFs';
import { redactText } from '../../security/redaction';

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

function createConfig() {
  return {
    name: 'test',
    context: '',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    password: 'prompt',
    protocol: 'sftp',
    remotePath: '/',
    connectTimeout: 1000,
    uploadOnSave: false,
    conflictCheck: false,
    useTempFile: false,
    openSsh: false,
    downloadOnOpen: false,
    filePerm: undefined,
    dirPerm: undefined,
    syncOption: {
      delete: false,
      skipCreate: false,
      ignoreExisting: false,
      update: false,
    },
    backup: {
      enabled: false,
      folder: '',
      versions: 0,
      onDelete: false,
    },
    ignore: [],
    ignoreFile: '',
    remoteExplorer: { order: 0 },
    remoteTimeOffsetInHours: 0,
    limitOpenFilesOnRemote: false,
    passphrase: null,
    interactiveAuth: false,
    algorithms: {},
    concurrency: 1,
    hop: [],
    secure: false,
    secureOptions: {},
    watcher: {
      files: false,
      autoUpload: false,
      autoDelete: false,
      autoRename: false,
    },
  };
}

describe('remote secret scope lifecycle', () => {
  let storage: MemorySecretStorage;

  beforeEach(() => {
    mockConnectErrors.length = 0;
    storage = new MemorySecretStorage();
    initSecrets({ secrets: storage } as any);
    expect(getAllRemoteFs()).toHaveLength(0);
  });

  test('cache identity ignores secret values but preserves authentication mode', () => {
    const base = createConfig();
    expect(
      remoteCacheIdentity({
        ...base,
        password: 'first-password',
        passphrase: 'first-passphrase',
        interactiveAuth: ['first-answer'],
      })
    ).toBe(
      remoteCacheIdentity({
        ...base,
        password: 'second-password',
        passphrase: 'second-passphrase',
        interactiveAuth: ['second-answer'],
      })
    );
    expect(
      remoteCacheIdentity({ ...base, interactiveAuth: true })
    ).not.toBe(
      remoteCacheIdentity({ ...base, interactiveAuth: false })
    );
  });

  test('dispose finds a cache created with loaded v2 password and passphrase', async () => {
    const config = createConfig();
    const endpoint = createCredentialEndpoint(config);
    const password = 'lifecycle-password-canary';
    const passphrase = 'lifecycle-passphrase-canary';
    await storeCredential(endpoint, 'password', password);
    await storeCredential(endpoint, 'passphrase', passphrase);
    const service = new FileService('C:\\workspace', 'C:\\workspace', config as any);

    await service.getRemoteFileSystem(config as any);

    expect(getAllRemoteFs()).toHaveLength(1);
    expect(redactText(`${password} ${passphrase}`)).toBe(
      '[REDACTED] [REDACTED]'
    );

    service.dispose();

    expect(getAllRemoteFs()).toHaveLength(0);
    expect(redactText(`${password} ${passphrase}`)).toBe(
      `${password} ${passphrase}`
    );
  });

  test.each([
    'authentication failed',
    'cancelled',
  ])('retry and dispose release the scope after: %s', async message => {
    const failure = new Error(message);
    const config = createConfig();
    const endpoint = createCredentialEndpoint(config);
    const password = `failed-${failure.message}-password`;
    await storeCredential(endpoint, 'password', password);
    mockConnectErrors.push(failure);
    const service = new FileService('C:\\workspace', 'C:\\workspace', config as any);

    await expect(service.getRemoteFileSystem(config as any)).rejects.toBe(failure);

    expect(getAllRemoteFs()).toHaveLength(1);
    expect(redactText(password)).toBe('[REDACTED]');

    await expect(service.getRemoteFileSystem(config as any)).resolves.toBeDefined();
    expect(getAllRemoteFs()).toHaveLength(1);

    service.dispose();

    expect(getAllRemoteFs()).toHaveLength(0);
    expect(redactText(password)).toBe(password);
  });
});
