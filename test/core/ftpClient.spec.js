const { EventEmitter } = require('events');

describe('FTPClient', () => {
  let FTPClient;
  let ftpClient;
  let mockClient;
  let socket;

  const connectionConfig = {
    askForPasswd: jest.fn(),
    verifyHostKey: jest.fn(),
  };

  const createOption = overrides => ({
    host: 'ftp.example.com',
    port: 21,
    username: 'user',
    password: 'secret',
    debug: jest.fn(),
    ...overrides,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();
    socket = new EventEmitter();

    mockClient = {
      closed: true,
      ftp: {
        log: jest.fn(),
        socket,
      },
      access: jest.fn(async () => {
        mockClient.closed = false;
      }),
      close: jest.fn(() => {
        mockClient.closed = true;
      }),
      sendIgnoringError: jest.fn(async () => ({ code: 200, message: '200 NOOP' })),
    };

    jest.doMock('basic-ftp', () => ({
      Client: jest.fn(() => mockClient),
    }));
    FTPClient = require('../../src/core/remote-client/ftpClient').default;
  });

  afterEach(() => {
    ftpClient?.end();
    jest.useRealTimers();
    jest.dontMock('basic-ftp');
  });

  async function connect(overrides = {}) {
    const option = createOption(overrides);
    ftpClient = new FTPClient(option);
    await ftpClient.connect(option, connectionConfig);
  }

  test('sends NOOP on the legacy fork keepalive interval', async () => {
    await connect({ ftpKeepAliveInterval: 1000 });

    await jest.advanceTimersByTimeAsync(1000);

    expect(mockClient.sendIgnoringError).toHaveBeenCalledTimes(1);
    expect(mockClient.sendIgnoringError).toHaveBeenCalledWith('NOOP');
  });

  test('uses the upstream 30-second keepalive by default', async () => {
    await connect();

    await jest.advanceTimersByTimeAsync(29999);
    expect(mockClient.sendIgnoringError).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(mockClient.sendIgnoringError).toHaveBeenCalledTimes(1);
  });

  test('allows the common keepalive option to disable NOOP', async () => {
    await connect({ keepalive: 0 });

    await jest.advanceTimersByTimeAsync(180000);

    expect(mockClient.sendIgnoringError).not.toHaveBeenCalled();
  });

  test('gives the legacy FTP keepalive override precedence', async () => {
    await connect({ keepalive: 1000, ftpKeepAliveInterval: 0 });

    await jest.advanceTimersByTimeAsync(1000);

    expect(mockClient.sendIgnoringError).not.toHaveBeenCalled();
  });

  test('reports whether the cached FTP control connection is closed', async () => {
    await connect({ keepalive: 0 });

    expect(ftpClient.isClosed()).toBe(false);
    mockClient.closed = true;
    expect(ftpClient.isClosed()).toBe(true);
  });

  test.each(['end', 'close', 'error'])(
    'invalidates the cached filesystem on socket %s',
    async eventName => {
      await connect({ keepalive: 0 });
      const disconnected = jest.fn();
      ftpClient.onDisconnected(disconnected);

      socket.emit(eventName, eventName === 'error' ? new Error('reset') : undefined);

      expect(disconnected).toHaveBeenCalledWith(eventName);
    }
  );
});
