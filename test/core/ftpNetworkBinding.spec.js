const os = require('os');
const { Client } = require('basic-ftp');
const { Readable, Writable } = require('stream');
jest.mock('../../src/logger', () => ({ __esModule: true, default: { info: jest.fn(), debug: jest.fn() } }));
const FTPClient = require('../../src/core/remote-client/ftpClient').default;
const { bindFTPNetworkInterface } = require('../../src/core/remote-client/ftpNetworkBinding');
const startFTPServer = require('../fixtures/ftpServer');

const adapter = address => ({ Ethernet: [{ address, family: 'IPv4', internal: false }] });
const authorization = { askForPasswd: jest.fn(), verifyHostKey: jest.fn() };
afterEach(() => jest.restoreAllMocks());

test.each([
  ['FTP EPSV', false, false],
  ['FTP PASV fallback', false, true],
  ['explicit FTPS', true, false],
  ['implicit FTPS', 'implicit', false],
])('%s binds control, upload, download and listing sockets', async (_label, secure, pasvOnly) => {
  jest.spyOn(os, 'networkInterfaces').mockReturnValue(adapter('127.0.0.2'));
  const server = await startFTPServer({ secure, pasvOnly });
  const option = {
    host: '127.0.0.1', port: server.port, username: 'test', password: 'test',
    secure, secureOptions: { rejectUnauthorized: false },
    networkInterface: 'Ethernet', debug: jest.fn(), connectTimeout: 2500,
  };
  const client = new FTPClient(option);
  try {
    await client.connect(option, authorization);
    const ftp = client.getFsClient();
    const content = Buffer.from('interface-specific upload\n');
    await ftp.uploadFrom(Readable.from(content), 'sample.txt');
    const chunks = [];
    await ftp.downloadTo(new Writable({ write(chunk, _, next) { chunks.push(chunk); next(); } }), 'sample.txt');
    expect(Buffer.concat(chunks)).toEqual(content);
    expect((await ftp.list())[0].name).toBe('sample.txt');
    expect(server.peers.filter(peer => peer.kind === 'control')).toHaveLength(1);
    expect(server.peers.filter(peer => peer.kind === 'data')).toHaveLength(3);
    expect(server.peers.every(peer => peer.address === '127.0.0.2')).toBe(true);
    os.networkInterfaces.mockReturnValue({});
    expect(client.isClosed()).toBe(true);
    await ftp.close();
  } finally {
    client.end();
    await server.close();
  }
}, 15000);

test('unavailable interface fails before connecting, without a system-routed fallback', () => {
  jest.spyOn(os, 'networkInterfaces').mockReturnValue({});
  const client = new Client();
  const factory = client.ftp._newSocket;
  expect(() => bindFTPNetworkInterface(client, 'Ethernet')).toThrow('unavailable');
  expect(client.ftp._newSocket).toBe(factory);
  client.close();
});

test('adapter loss before a passive socket rejects; a new client can resolve the new IP', () => {
  const snapshot = jest.spyOn(os, 'networkInterfaces').mockReturnValue(adapter('127.0.0.2'));
  const first = new Client(), second = new Client();
  const originalFactory = first.ftp._newSocket;
  const binding = bindFTPNetworkInterface(first, 'Ethernet');
  snapshot.mockReturnValue(adapter('127.0.0.3'));
  const socket = first.ftp._newSocket();
  expect(() => socket.connect({ host: '127.0.0.1', port: 21 })).toThrow('lost address');
  expect(binding.isAvailable()).toBe(false);
  expect(bindFTPNetworkInterface(second, 'Ethernet').address).toBe('127.0.0.3');
  socket.destroy();
  binding.dispose();
  expect(first.ftp._newSocket).toBe(originalFactory);
  first.close(); second.close();
});
