const fs = require('fs');
const os = require('os');
const path = require('path');
const upath = require('../../src/core/upath').default;
const localFs = require('../../src/core/localFs').default;
const FileService = require('../../src/core/fileService').default;
const { FTPFileSystem, SFTPFileSystem, FileType } = require('../../src/core/fs');
const { TransferDirection } = require('../../src/core/transferTask');
const { transfer } = require('../../src/fileHandlers/transfer/transfer');
const { createTransferRetryOptions } = require('../../src/fileHandlers/transfer/retryOptions');
const {
  createConflictLifecycle,
  UploadConflictAbortError,
} = require('../../src/fileHandlers/transfer/conflictCheck');
const { initRemoteBaselineStore } = require('../../src/fileHandlers/transfer/remoteBaseline');
const {
  createRemoteIfNoneExist,
  removeRemoteFs,
} = require('../../src/core/remoteFs');
const { withRetry, isConnectionError } = require('../../src/helper');
const { captureConflict, waitForConflictDecision } = require('../../src/fileHandlers/transfer/conflictBridge');

function memoryMemento() {
  let state = {};
  return {
    get(_key, fallback) {
      return state || fallback;
    },
    async update(_key, value) {
      state = value;
    },
  };
}

async function runTransfer({
  srcFs,
  targetFs,
  src,
  target,
  direction,
  lifecycle = {},
}) {
  const tasks = [];
  await transfer({
    srcFsPath: src,
    srcFs,
    targetFsPath: target,
    targetFs,
    transferDirection: direction,
    transferOption: {
      perserveTargetMode: false,
      useTempFile: false,
      openSsh: false,
      ...lifecycle,
    },
  }, task => tasks.push(task));
  for (const task of tasks) {
    await task.run();
  }
}

module.exports = function protocolContract({
  protocol,
  startServer,
  startUnknownTimestampServer,
}) {
  describe(`${protocol.toUpperCase()} loopback acceptance`, () => {
    let server;
    let remoteFs;
    let localRoot;
    let option;

    function connectOption(port, overrides = {}) {
      return {
        protocol,
        host: '127.0.0.1',
        port,
        username: 'test',
        password: 'test',
        connectTimeout: 750,
        keepalive: 0,
        remoteTimeOffsetInHours: 0,
        workspace: localRoot,
        debug: () => {},
        ...overrides,
      };
    }

    function serviceConfig(overrides = {}) {
      return {
        protocol,
        host: '127.0.0.1',
        port: server.port,
        username: 'test',
        password: 'test',
        remotePath: '/',
        conflictCheck: true,
        watcher: { files: false, autoUpload: false, autoDelete: false, autoRename: false },
        syncOption: {},
        backup: { enabled: false, folder: '.backup', versions: 0, onDelete: false },
        ignore: [],
        ignoreFile: '',
        concurrency: 1,
        remoteTimeOffsetInHours: 0,
        uploadOnSave: false,
        useTempFile: false,
        openSsh: false,
        downloadOnOpen: false,
        remoteExplorer: { order: 0 },
        limitOpenFilesOnRemote: false,
        secure: false,
        passphrase: '',
        interactiveAuth: false,
        algorithms: {},
        hop: [],
        ...overrides,
      };
    }

    async function createFs(overrides = {}) {
      const currentOption = connectOption(server.port, overrides);
      const Constructor = protocol === 'ftp' ? FTPFileSystem : SFTPFileSystem;
      const instance = new Constructor(upath, {
        clientOption: currentOption,
        remoteTimeOffsetInHours: 0,
      });
      await instance.connect(currentOption, {
        askForPasswd: async () => currentOption.password,
        verifyHostKey: async () => true,
      });
      return instance;
    }

    beforeEach(async () => {
      jest.clearAllMocks();
      server = undefined;
      remoteFs = undefined;
      option = undefined;
      localRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), `sftp-sync-${protocol}-`));
      server = await startServer();
      option = connectOption(server.port);
      remoteFs = await createFs();
      initRemoteBaselineStore(memoryMemento());
    });

    afterEach(async () => {
      if (option) removeRemoteFs(option);
      if (remoteFs) remoteFs.end();
      if (server) await server.close();
      if (localRoot) await fs.promises.rm(localRoot, { recursive: true, force: true });
    });

    test('connects, browses, uploads, and downloads byte-identical content', async () => {
      await server.sandbox.mkdir('/seed');
      await server.sandbox.seed('/seed/remote.bin', Buffer.from([0, 1, 2, 255]));

      const entries = await remoteFs.list('/seed');
      expect(entries.map(entry => entry.name)).toContain('remote.bin');
      expect(entries[0].type).toBe(FileType.File);

      const uploadPath = path.join(localRoot, 'upload.bin');
      const uploadBytes = Buffer.from('first transfer \0 bytes', 'utf8');
      await fs.promises.writeFile(uploadPath, uploadBytes);
      await runTransfer({
        srcFs: localFs,
        targetFs: remoteFs,
        src: uploadPath,
        target: '/uploaded/upload.bin',
        direction: TransferDirection.LOCAL_TO_REMOTE,
      });
      expect(await server.sandbox.read('/uploaded/upload.bin')).toEqual(uploadBytes);

      const downloadPath = path.join(localRoot, 'download.bin');
      await runTransfer({
        srcFs: remoteFs,
        targetFs: localFs,
        src: '/uploaded/upload.bin',
        target: downloadPath,
        direction: TransferDirection.REMOTE_TO_LOCAL,
      });
      expect(await fs.promises.readFile(downloadPath)).toEqual(uploadBytes);
    });

    test('records a baseline and blocks a changed remote with conflict metadata', async () => {
      const remotePath = '/conflict.txt';
      const initial = Buffer.from('remote baseline');
      const changed = Buffer.from('changed out of band');
      await server.sandbox.seed(remotePath, initial, new Date('2026-09-23T12:00:00Z'));
      const localPath = path.join(localRoot, 'conflict.txt');
      const config = serviceConfig();
      const fileService = new FileService(localRoot, localRoot, config);
      const lifecycle = createConflictLifecycle({ fileService, config });

      await runTransfer({
        srcFs: remoteFs,
        targetFs: localFs,
        src: remotePath,
        target: localPath,
        direction: TransferDirection.REMOTE_TO_LOCAL,
        lifecycle,
      });

      await server.sandbox.seed(remotePath, changed, new Date('2026-09-23T12:00:05Z'));
      await fs.promises.writeFile(localPath, 'local edit');
      await fs.promises.utimes(
        localPath,
        new Date('2026-09-23T12:00:10Z'),
        new Date('2026-09-23T12:00:10Z')
      );
      waitForConflictDecision.mockResolvedValueOnce('cancel');

      await expect(runTransfer({
        srcFs: localFs,
        targetFs: remoteFs,
        src: localPath,
        target: remotePath,
        direction: TransferDirection.LOCAL_TO_REMOTE,
        lifecycle: createConflictLifecycle({ fileService, config }),
      })).rejects.toBeInstanceOf(UploadConflictAbortError);

      expect(captureConflict).toHaveBeenCalledWith(
        localRoot,
        expect.any(String),
        expect.objectContaining({ targetFsPath: remotePath }),
        'remote-changed',
        expect.objectContaining({ size: changed.length, mtime: expect.any(Number) }),
        expect.objectContaining({ size: initial.length, mtime: expect.any(Number) })
      );
      expect(await server.sandbox.read(remotePath)).toEqual(changed);
    });

    test('reports deterministic authentication, path, and permission failures', async () => {
      expect(() => server.sandbox.resolve('/../outside.txt')).toThrow('traversal');
      const wrong = protocol === 'ftp' ? new FTPFileSystem(upath, {
        clientOption: connectOption(server.port, { password: 'wrong' }),
      }) : new SFTPFileSystem(upath, {
        clientOption: connectOption(server.port, { password: 'wrong' }),
      });
      await expect(wrong.connect(connectOption(server.port, { password: 'wrong' }), {
        askForPasswd: async () => 'wrong',
        verifyHostKey: async () => true,
      })).rejects.toThrow();
      wrong.end();

      await expect(remoteFs.list('/missing')).rejects.toThrow();

      await server.sandbox.mkdir('/denied');
      await server.sandbox.seed('/denied/remote.txt', 'protected');
      server.sandbox.deny('/denied');
      await expect(remoteFs.list('/denied')).rejects.toThrow(/permission|denied|550/i);
      const protectedLocal = path.join(localRoot, 'protected-local.txt');
      await fs.promises.writeFile(protectedLocal, 'keep local bytes');
      await expect(runTransfer({
        srcFs: remoteFs,
        targetFs: localFs,
        src: '/denied/remote.txt',
        target: protectedLocal,
        direction: TransferDirection.REMOTE_TO_LOCAL,
      })).rejects.toThrow();
      expect(await fs.promises.readFile(protectedLocal, 'utf8')).toBe('keep local bytes');

      const deniedUpload = path.join(localRoot, 'denied-upload.txt');
      await fs.promises.writeFile(deniedUpload, 'do not write remotely');
      await expect(runTransfer({
        srcFs: localFs,
        targetFs: remoteFs,
        src: deniedUpload,
        target: '/denied/new.txt',
        direction: TransferDirection.LOCAL_TO_REMOTE,
      })).rejects.toThrow();
      server.sandbox.allow('/denied');
      expect(await server.sandbox.exists('/denied/new.txt')).toBe(false);
      expect(await server.sandbox.read('/sample.txt')).toEqual(Buffer.from('initial fixture data'));
    });

    test('reconnects a safe download once, fails persistently, and observes disconnect', async () => {
      remoteFs.end();
      remoteFs = undefined;
      await server.sandbox.seed('/retry.txt', 'retry succeeds');
      const retryPath = path.join(localRoot, 'retry.txt');
      await fs.promises.writeFile(retryPath, 'existing local bytes');
      server.sandbox.disconnect('download', 'once');

      await withRetry(async () => {
        const cached = await createRemoteIfNoneExist(option);
        await runTransfer({
          srcFs: cached,
          targetFs: localFs,
          src: '/retry.txt',
          target: retryPath,
          direction: TransferDirection.REMOTE_TO_LOCAL,
        });
      }, {
        maxAttempts: 2,
        shouldRetry: isConnectionError,
        onRetry: () => removeRemoteFs(option),
      });
      expect(await fs.promises.readFile(retryPath, 'utf8')).toBe('retry succeeds');
      expect((await fs.promises.readdir(localRoot)).some(
        name => name.startsWith('retry.txt.sftp-sync-')
      )).toBe(false);
      expect(server.sandbox.connectionCount).toBeGreaterThanOrEqual(3);

      server.sandbox.disconnect('download', 'persistent');
      removeRemoteFs(option);
      const persistentPath = path.join(localRoot, 'persistent.txt');
      await fs.promises.writeFile(persistentPath, 'preserve existing local bytes');
      await expect(withRetry(async () => {
        const cached = await createRemoteIfNoneExist(option);
        await runTransfer({
          srcFs: cached,
          targetFs: localFs,
          src: '/retry.txt',
          target: persistentPath,
          direction: TransferDirection.REMOTE_TO_LOCAL,
        });
      }, {
        maxAttempts: 2,
        shouldRetry: isConnectionError,
        onRetry: () => removeRemoteFs(option),
      })).rejects.toThrow();
      expect(await fs.promises.readFile(persistentPath, 'utf8')).toBe(
        'preserve existing local bytes'
      );
      expect((await fs.promises.readdir(localRoot)).some(
        name => name.startsWith('persistent.txt.sftp-sync-')
      )).toBe(false);

      removeRemoteFs(option);
      await createRemoteIfNoneExist(option);
      const before = server.sandbox.connectionCount;
      await server.disconnectClients();
      const next = await createRemoteIfNoneExist(option);
      expect((await next.list('/')).map(entry => entry.name)).toContain('retry.txt');
      expect(server.sandbox.connectionCount).toBe(before + 1);
    });

    test('does not replay an interrupted upload through handler retry policy', async () => {
      remoteFs.end();
      remoteFs = undefined;
      removeRemoteFs(option);
      const localPath = path.join(localRoot, 'single-attempt.txt');
      const uploadBytes = Buffer.alloc(128 * 1024, 'x');
      await fs.promises.writeFile(localPath, uploadBytes);
      server.sandbox.disconnect('upload', 'once');
      const before = server.sandbox.connectionCount;
      const clearRemoteFileSystem = jest.fn(() => removeRemoteFs(option));
      const retryContext = {
        config: serviceConfig({ ftpReconnectAttempts: 2 }),
        fileService: { clearRemoteFileSystem },
      };

      await expect(withRetry(async () => {
        const cached = await createRemoteIfNoneExist(option);
        await runTransfer({
          srcFs: localFs,
          targetFs: cached,
          src: localPath,
          target: '/single-attempt.txt',
          direction: TransferDirection.LOCAL_TO_REMOTE,
        });
      }, createTransferRetryOptions(
        retryContext,
        TransferDirection.LOCAL_TO_REMOTE
      ))).rejects.toThrow();

      expect(clearRemoteFileSystem).not.toHaveBeenCalled();
      expect(server.sandbox.connectionCount).toBe(before + 1);
      expect(await server.sandbox.read('/single-attempt.txt')).toEqual(
        uploadBytes.subarray(0, 4)
      );
    });

    if (startUnknownTimestampServer) {
      test('uses timestamp-unavailable when FTP MDTM is disabled', async () => {
        remoteFs.end();
        await server.close();
        server = await startUnknownTimestampServer();
        option = connectOption(server.port);
        remoteFs = await createFs();
        const entry = (await remoteFs.list('/')).find(item => item.name === 'sample.txt');
        expect(entry.mtime).toBe(0);
        expect((await remoteFs.ensureAccurateMtime(entry)).mtime).toBe(0);

        const original = await server.sandbox.read('/sample.txt');
        const localPath = path.join(localRoot, 'unknown-timestamp.txt');
        await fs.promises.writeFile(localPath, 'local edit must not overwrite');
        const config = serviceConfig();
        const fileService = new FileService(localRoot, localRoot, config);
        waitForConflictDecision.mockResolvedValueOnce('cancel');

        await expect(runTransfer({
          srcFs: localFs,
          targetFs: remoteFs,
          src: localPath,
          target: '/sample.txt',
          direction: TransferDirection.LOCAL_TO_REMOTE,
          lifecycle: createConflictLifecycle({ fileService, config }),
        })).rejects.toBeInstanceOf(UploadConflictAbortError);

        expect(captureConflict).toHaveBeenCalledWith(
          localRoot,
          expect.any(String),
          expect.objectContaining({ targetFsPath: '/sample.txt' }),
          'timestamp-unavailable',
          expect.objectContaining({ size: original.length, mtime: 0 }),
          undefined
        );
        expect(await server.sandbox.read('/sample.txt')).toEqual(original);
      });
    } else {
      test('returns an exact positive SFTP timestamp', async () => {
        await server.sandbox.seed('/timestamp.txt', 'time', new Date('2026-09-23T12:34:56Z'));
        const stat = await remoteFs.lstat('/timestamp.txt');
        expect(stat.mtime).toBe(Date.parse('2026-09-23T12:34:56Z'));
      });
    }
  });
};
