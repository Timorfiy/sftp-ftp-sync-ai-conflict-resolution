import { EventEmitter } from 'events';

const mockSshClient = jest.fn();

jest.mock('ssh2', () => ({
  Client: mockSshClient,
}));

import RemoteClient, {
  Config,
  ConnectOption,
  SecretRequest,
} from '../remoteClient';
import SSHClient from '../sshClient';
import { classifyError } from '../../../errors/actionable';

class TestRemoteClient extends RemoteClient {
  received?: ConnectOption;

  _initClient() {
    return new EventEmitter();
  }

  end() {}

  getFsClient() {
    return undefined;
  }

  isClosed() {
    return false;
  }

  protected _hasProvideAuth(option: ConnectOption) {
    return option.password !== undefined;
  }

  protected async _doConnect(option: ConnectOption): Promise<void> {
    this.received = option;
  }
}

function option(overrides: Partial<ConnectOption> = {}): ConnectOption {
  return {
    host: 'example.com',
    port: 22,
    username: 'deploy',
    debug: jest.fn(),
    ...overrides,
  };
}

function config(
  requestSecret: (request: SecretRequest) => Promise<string | undefined>
): Config {
  return {
    requestSecret,
    verifyHostKey: jest.fn(async () => true),
  };
}

describe('typed remote authentication requests', () => {
  beforeEach(() => {
    mockSshClient.mockImplementation(() => new EventEmitter());
  });

  test('requests a persistable password when no authentication is supplied', async () => {
    const client = new TestRemoteClient(option());
    const requestSecret = jest.fn(async () => 'password-canary');

    await client.connect(option(), config(requestSecret));

    expect(requestSecret).toHaveBeenCalledWith({
      kind: 'password',
      prompt: '[example.com]: Enter your password',
      persist: true,
    });
    expect(client.received?.password).toBe('password-canary');
  });

  test('requests a persistable passphrase for an encrypted private key', async () => {
    const ssh = new SSHClient(option());
    const transport = new EventEmitter() as EventEmitter & {
      connect: (value: unknown) => void;
    };
    transport.connect = jest.fn(() => {
      queueMicrotask(() => transport.emit('ready'));
    });
    const requestSecret = jest.fn(async () => 'passphrase-canary');

    await (ssh as any)._connectSSHClient(
      transport,
      option({ privateKey: 'private-key', passphrase: true }),
      config(requestSecret)
    );

    expect(requestSecret).toHaveBeenCalledWith({
      kind: 'passphrase',
      prompt: '[example.com]: Enter your passphrase',
      persist: true,
    });
    expect((transport.connect as jest.Mock).mock.calls[0][0].passphrase)
      .toBe('passphrase-canary');
  });

  test('requests keyboard-interactive answers as memory-only values', async () => {
    const ssh = new SSHClient(option());
    const transport = new EventEmitter() as EventEmitter & {
      connect: (value: unknown) => void;
    };
    let finishedAnswers: string[] = [];
    transport.connect = jest.fn(() => {
      transport.emit(
        'keyboard-interactive',
        '',
        '',
        '',
        [{ prompt: 'Verification code', echo: false }],
        (answers: string[]) => {
          finishedAnswers = answers;
          transport.emit('ready');
        }
      );
    });
    const requestSecret = jest.fn(async () => 'interactive-answer-canary');

    await (ssh as any)._connectSSHClient(
      transport,
      option({ interactiveAuth: true }),
      config(requestSecret)
    );

    expect(requestSecret).toHaveBeenCalledWith({
      kind: 'interactive-answer',
      prompt: '[example.com]: Verification code',
      persist: false,
    });
    expect(finishedAnswers).toEqual(['interactive-answer-canary']);
  });

  test('missing configured private key keeps Configuration and Open Config', async () => {
    const ssh = new SSHClient(option());

    let error: unknown;
    try {
      await (ssh as any)._doConnect(
        option({
          privateKeyPath:
            'C:\\missing\\sftp-sync-ai-private-key-routing-test.pem',
        }),
        config(jest.fn(async () => undefined))
      );
    } catch (caught) {
      error = caught;
    }
    const actionable = classifyError(error);

    expect(actionable.id).toBe('configuration.invalid');
    expect(actionable.actions).toContain('open-config');
    expect(actionable.troubleshootingSection).toBe('configuration');
  });
});
