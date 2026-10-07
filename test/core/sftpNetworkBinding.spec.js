const os = require('os');
const net = require('net');
jest.mock('../../src/logger', () => ({ __esModule: true, default: {
  info: jest.fn(), debug: jest.fn(), trace: jest.fn(), warn: jest.fn(), error: jest.fn(),
} }));
const SSHClient = require('../../src/core/remote-client/sshClient').default;
const startSFTPServer = require('../fixtures/sftpServer');

const adapter = address => ({ Ethernet: [{ address, family: 'IPv4', internal: false }] });
const authorization = {
  requestSecret: jest.fn(), verifyHostKey: jest.fn(async () => true),
};
const options = server => ({
  host: 'localhost', port: server.port,
  ...server.sandbox.credentials,
  networkInterface: 'Ethernet', debug: jest.fn(), connectTimeout: 2500,
});

afterEach(() => jest.restoreAllMocks());

test('SFTP binds authentication, file transfers and listings to the selected adapter', async () => {
  const snapshot = jest.spyOn(os, 'networkInterfaces').mockReturnValue(adapter('127.0.0.2'));
  const server = await startSFTPServer();
  const option = options(server);
  const client = new SSHClient(option);
  try {
    await client.connect(option, authorization);
    const sftp = client.getFsClient();
    const content = Buffer.from('interface-specific SFTP upload\n');
    await new Promise((resolve, reject) => sftp.writeFile('/sample.txt', content, error => error ? reject(error) : resolve()));
    const downloaded = await new Promise((resolve, reject) => sftp.readFile('/sample.txt', (error, data) => error ? reject(error) : resolve(data)));
    const entries = await new Promise((resolve, reject) => sftp.readdir('/', (error, data) => error ? reject(error) : resolve(data)));
    expect(downloaded).toEqual(content);
    expect(entries.some(entry => entry.filename === 'sample.txt')).toBe(true);
    expect(server.peers).toEqual(['127.0.0.2']);
    expect(client.isClosed()).toBe(false);
    snapshot.mockReturnValue(adapter('127.0.0.3'));
    expect(client.isClosed()).toBe(true);
  } finally {
    client.end();
    await server.close();
  }
}, 15000);

test('an unavailable adapter rejects before a TCP connection without fallback', async () => {
  jest.spyOn(os, 'networkInterfaces').mockReturnValue({});
  const server = await startSFTPServer();
  const option = options(server);
  const client = new SSHClient(option);
  const connect = jest.spyOn(client._client, 'connect');
  try {
    await expect(client.connect(option, authorization)).rejects.toThrow('unavailable');
    expect(connect).not.toHaveBeenCalled();
    expect(server.peers).toEqual([]);
  } finally {
    client.end();
    await server.close();
  }
});

test('reconnecting resolves the current adapter address instead of retaining the previous IP', async () => {
  const snapshot = jest.spyOn(os, 'networkInterfaces').mockReturnValue(adapter('127.0.0.2'));
  const server = await startSFTPServer();
  const option = options(server);
  const clients = [];
  try {
    for (const address of ['127.0.0.2', '127.0.0.3']) {
      snapshot.mockReturnValue(adapter(address));
      const client = new SSHClient(option);
      clients.push(client);
      await client.connect(option, authorization);
      client.end();
    }
    expect(server.peers).toEqual(['127.0.0.2', '127.0.0.3']);
  } finally {
    clients.forEach(client => client.end());
    await server.close();
  }
}, 15000);

test.each([null, undefined])('system routing (%s) does not require a named adapter', async networkInterface => {
  const interfaces = jest.spyOn(os, 'networkInterfaces').mockReturnValue({});
  const server = await startSFTPServer();
  const option = { ...options(server), host: '127.0.0.1', networkInterface };
  const client = new SSHClient(option);
  try {
    await client.connect(option, authorization);
    expect(client.isClosed()).toBe(false);
    expect(server.peers).toEqual(['127.0.0.1']);
    expect(interfaces).not.toHaveBeenCalled();
  } finally {
    client.end();
    await server.close();
  }
});

test('an existing forwarded socket is preserved and needs no local adapter on later hops', async () => {
  const interfaces = jest.spyOn(os, 'networkInterfaces').mockReturnValue({});
  const server = await startSFTPServer();
  const sock = net.connect({ host: '127.0.0.1', port: server.port });
  const option = { ...options(server), sock };
  const client = new SSHClient(option);
  try {
    await client.connect(option, authorization);
    expect(client._client._sock).toBe(sock);
    expect(interfaces).not.toHaveBeenCalled();
    expect(client.isClosed()).toBe(false);
  } finally {
    client.end();
    sock.destroy();
    await server.close();
  }
});

test.each([1, 2])('SSH hopping (%s hops) binds only the first socket and preserves forwarded channels', async hopCount => {
  const snapshot = jest.spyOn(os, 'networkInterfaces').mockReturnValue(adapter('127.0.0.2'));
  const servers = [];
  let client;
  try {
    const destination = await startSFTPServer();
    servers.push(destination);
    for (let index = 0; index < hopCount; index++) {
      servers.push(await startSFTPServer({ forwardPorts: [servers[index].port] }));
    }
    const chain = [...servers].reverse();
    const option = {
      ...options(chain[0]),
      hop: chain.slice(1).map(server => ({
        ...options(server), networkInterface: 'adapter-only-on-the-remote-host',
      })),
    };
    client = new SSHClient(option);
    await client.connect(option, authorization);
    const downloaded = await new Promise((resolve, reject) => client.getFsClient().readFile(
      '/sample.txt', (error, data) => error ? reject(error) : resolve(data)
    ));
    expect(downloaded.toString()).toBe('initial fixture data');
    expect(chain[0].peers).toEqual(['127.0.0.2']);
    expect(chain.slice(1).every(server => server.peers.length === 1 && server.peers[0] === '127.0.0.1')).toBe(true);
    expect(client.isClosed()).toBe(false);
    snapshot.mockReturnValue({});
    expect(client.isClosed()).toBe(true);
  } finally {
    client?.end();
    for (const server of [...servers].reverse()) await server.close();
  }
}, 15000);
