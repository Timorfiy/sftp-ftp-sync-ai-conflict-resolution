describe('FTPClient', () => {
  let FTPClient;
  let ftpClient;
  let mockClient;

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
    ftpReconnectAttempts: 1,
    ...overrides,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();

    mockClient = {
      closed: true,
      ftp: {
        log: jest.fn(),
      },
      access: jest.fn(async () => {
        mockClient.closed = false;
      }),
      close: jest.fn(() => {
        mockClient.closed = true;
      }),
      ensureDir: jest.fn(async () => {}),
      list: jest.fn(async () => []),
      send: jest.fn(async () => ({ code: 200, message: '200 NOOP' })),
      uploadFrom: jest.fn(async () => {}),
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
    return ftpClient.getFsClient();
  }

  test('sends NOOP on the configured keepalive interval', async () => {
    await connect({ ftpKeepAliveInterval: 1000 });

    await jest.advanceTimersByTimeAsync(1000);

    expect(mockClient.send).toHaveBeenCalledTimes(1);
    expect(mockClient.send).toHaveBeenCalledWith('NOOP');
  });

  test('keeps FTP keepalive disabled by default', async () => {
    await connect();

    await jest.advanceTimersByTimeAsync(180000);

    expect(mockClient.send).not.toHaveBeenCalled();
  });

  test('reconnects before an operation when the control connection is already closed', async () => {
    const client = await connect();
    mockClient.closed = true;

    await client.ensureDir('/public_html/local');

    expect(mockClient.access).toHaveBeenCalledTimes(2);
    expect(mockClient.ensureDir).toHaveBeenCalledTimes(1);
  });

  test('reconnects and retries a safe operation after a mid-command disconnect', async () => {
    const client = await connect();
    mockClient.ensureDir
      .mockImplementationOnce(async () => {
        mockClient.closed = true;
        throw new Error('Server sent FIN packet unexpectedly, closing connection.');
      })
      .mockResolvedValueOnce(undefined);

    await client.ensureDir('/public_html/local');

    expect(mockClient.access).toHaveBeenCalledTimes(2);
    expect(mockClient.ensureDir).toHaveBeenCalledTimes(2);
  });

  test('reconnects but does not replay a streaming upload after a mid-command disconnect', async () => {
    const client = await connect();
    mockClient.uploadFrom.mockImplementationOnce(async () => {
      mockClient.closed = true;
      throw new Error('Server sent FIN packet unexpectedly, closing connection.');
    });

    await expect(client.uploadFrom({}, '/public_html/index.php')).rejects.toThrow(
      'Server sent FIN packet unexpectedly'
    );

    expect(mockClient.access).toHaveBeenCalledTimes(2);
    expect(mockClient.uploadFrom).toHaveBeenCalledTimes(1);
  });

  test('notifies the filesystem when reconnect attempts are exhausted', async () => {
    const client = await connect();
    const disconnected = jest.fn();
    ftpClient.onDisconnected(disconnected);
    mockClient.closed = true;
    mockClient.access.mockRejectedValueOnce(new Error('FTP server is unavailable'));

    await expect(client.ensureDir('/public_html/local')).rejects.toThrow('FTP server is unavailable');

    expect(disconnected).toHaveBeenCalledWith('reconnect-failed');
    expect(mockClient.ensureDir).not.toHaveBeenCalled();
  });
});
