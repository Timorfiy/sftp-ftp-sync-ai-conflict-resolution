const fs = require('fs');
const path = require('path');
const {
  sandbox, reset, upload, removeRemote, localFs, pause, logger,
} = require('../fixtures/downloadWatcherHarness');
const { transfer, sync } = require('../../src/fileHandlers/transfer/transfer');
const { FTPFileSystem, SFTPFileSystem } = require('../../src/core/fs');
const upath = require('../../src/core/upath').default;
const startFTP = require('../fixtures/ftpServer');
const startSFTP = require('../fixtures/sftpServer');

jest.setTimeout(30_000);
describe.each(['ftp', 'sftp'])('%s loopback downloads with native fs.watch', protocol => {
  let box, server, remote;
  beforeEach(async () => {
    reset();
    box = await sandbox();
    box.watch(box.root, true);
    server = await (protocol === 'ftp' ? startFTP : startSFTP)();
    await server.sandbox.seed('/source/nested/file.txt', 'remote protocol bytes');
    const option = {
      protocol, host: '127.0.0.1', port: server.port,
      username: 'test', password: 'test', workspace: box.root,
      connectTimeout: 2000, keepalive: 0, remoteTimeOffsetInHours: 0,
      debug: () => {},
    };
    const Constructor = protocol === 'ftp' ? FTPFileSystem : SFTPFileSystem;
    remote = new Constructor(upath, { clientOption: option, remoteTimeOffsetInHours: 0 });
    await remote.connect(option, {
      requestSecret: async () => 'test', verifyHostKey: async () => true,
    });
  });
  afterEach(async () => {
    remote?.end();
    await server?.close();
    await box?.close();
  });

  test.each(['file', 'folder', 'remote-sync', 'both-sync'])('%s does not bounce bytes back', async mode => {
    const destination = path.join(box.root, 'destination');
    const tasks = [];
    const config = {
      srcFsPath: mode === 'file' ? '/source/nested/file.txt' : '/source',
      targetFsPath: mode === 'file' ? path.join(destination, 'nested', 'file.txt') : destination,
      srcFs: remote, targetFs: localFs, transferDirection: 'remote ➞ local',
      transferOption: { perserveTargetMode: false, bothDiretions: mode === 'both-sync' },
    };
    if (mode === 'both-sync') {
      await fs.promises.mkdir(destination);
      await pause(100);
      await box.flush();
      upload.mockClear();
      [config.srcFsPath, config.targetFsPath] = [destination, '/source'];
      [config.srcFs, config.targetFs] = [localFs, remote];
      config.transferDirection = 'local ➞ remote';
    }
    await (mode.includes('sync') ? sync : transfer)(config, task => tasks.push(task));
    for (const task of tasks) await task.run();
    const file = path.join(destination, 'nested', 'file.txt');
    expect(await fs.promises.readFile(file, 'utf8')).toBe('remote protocol bytes');
    await pause(700);
    await box.flush();
    expect(box.observed.has(file)).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(removeRemote).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    await fs.promises.writeFile(file, 'local protocol edit');
    await pause(650);
    await box.flush();
    expect(upload.mock.calls.some(([uri]) => uri.fsPath === file)).toBe(true);
  });
});
