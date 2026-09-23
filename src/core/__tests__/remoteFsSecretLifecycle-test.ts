const mockConnectErrors: Array<Error | undefined> = [];
const mockConnections: Array<{ option: any; callbacks: any; fs: any }> = [];
let mockConnectObserver: ((option: any, callbacks: any) => Promise<void>) | undefined;
let mockProbeStageError: Error | undefined;
let mockClosedConnections = 0;

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

    async connect(option: any, callbacks: any): Promise<void> {
      mockConnections.push({ option, callbacks, fs: this });
      if (mockConnectObserver) {
        await mockConnectObserver(option, callbacks);
      }
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

    async lstat() {
      if (mockProbeStageError) {
        throw mockProbeStageError;
      }
      return { type: actual.FileType.Directory };
    }

    async list() {
      return [];
    }

    end() {
      mockClosedConnections += 1;
      this.closed = true;
    }
  }

  return {
    ...actual,
    SFTPFileSystem: FakeRemoteFileSystem,
    FTPFileSystem: FakeRemoteFileSystem,
  };
});

import FileService, { prepareRemoteConnectionOption } from '../fileService';
import { probeConnection } from '../connectionProbe';
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
    mockConnections.length = 0;
    mockConnectObserver = undefined;
    mockProbeStageError = undefined;
    mockClosedConnections = 0;
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

  test('connection probe shares endpoint-scoped credentials without caching or retaining secrets', async () => {
    const config = createConfig();
    const endpoint = createCredentialEndpoint(config);
    const password = 'probe-password-canary';
    const passphrase = 'probe-passphrase-canary';
    await storeCredential(endpoint, 'password', password);
    await storeCredential(endpoint, 'passphrase', passphrase);
    mockConnectObserver = async (option, callbacks) => {
      expect(option.password).toBe(password);
      expect(option.passphrase).toBe(passphrase);
      expect(typeof callbacks.requestSecret).toBe('function');
      expect(callbacks.askForPasswd).toBeUndefined();
      expect(redactText(`${password} ${passphrase}`)).toBe('[REDACTED] [REDACTED]');
    };

    const options = await prepareRemoteConnectionOption(config as any, 'C:\\workspace');
    const result = await probeConnection(options, '/', 'base');

    expect(result).toMatchObject({ ok: true, protocol: 'sftp', profile: 'base' });
    expect(mockConnections).toHaveLength(1);
    expect(mockClosedConnections).toBe(1);
    expect(getAllRemoteFs()).toHaveLength(0);
    expect(redactText(`${password} ${passphrase}`)).toBe(`${password} ${passphrase}`);
  });

  test.each(['connect', 'lstat'])('failed probe releases its connection and scope after %s', async stage => {
    const config = createConfig();
    const password = `probe-${stage}-secret-canary`;
    await storeCredential(createCredentialEndpoint(config), 'password', password);
    mockConnectObserver = async () => {
      expect(redactText(password)).toBe('[REDACTED]');
    };
    const error = Object.assign(new Error(password), {
      code: stage === 'connect' ? 'ECONNREFUSED' : 'EACCES',
    });
    if (stage === 'connect') {
      mockConnectErrors.push(error);
    } else {
      mockProbeStageError = error;
    }

    const options = await prepareRemoteConnectionOption(config as any, 'C:\\workspace');
    const result = await probeConnection(options, '/', 'base');

    expect(result).toMatchObject({
      ok: false,
      category: stage === 'connect' ? 'Network' : 'Permission',
    });
    expect(JSON.stringify(result)).not.toContain(password);
    expect(mockClosedConnections).toBe(1);
    expect(getAllRemoteFs()).toHaveLength(0);
    expect(redactText(password)).toBe(password);
  });
});
