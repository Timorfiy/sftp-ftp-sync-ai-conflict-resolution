const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const quickPicks = [];
jest.mock('vscode', () => ({
  Uri: { file: fsPath => ({ fsPath }) },
  commands: { executeCommand: jest.fn(async () => undefined) },
  workspace: { textDocuments: [] },
  window: {
    showErrorMessage: jest.fn(async () => undefined),
    createOutputChannel: jest.fn(() => ({
      append: jest.fn(),
      appendLine: jest.fn(),
      clear: jest.fn(),
      dispose: jest.fn(),
      hide: jest.fn(),
      show: jest.fn(),
    })),
    withProgress: jest.fn((_options, task) =>
      task({ report: jest.fn() }, { isCancellationRequested: false })
    ),
    createQuickPick: jest.fn(() => {
      let hideHandler = () => undefined;
      const quickPick = {
        items: [],
        selectedItems: [],
        manualClicks: 0,
        show: jest.fn(),
        hide: jest.fn(() => hideHandler()),
        dispose: jest.fn(),
        onDidAccept: jest.fn(() => ({ dispose: jest.fn() })),
        onDidHide: jest.fn(handler => {
          hideHandler = handler;
          return { dispose: jest.fn() };
        }),
      };
      quickPicks.push(quickPick);
      return quickPick;
    }),
  },
}));

jest.mock('../../src/logger', () => ({
  __esModule: true,
  default: {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('../../src/app', () => ({
  __esModule: true,
  default: {
    fsCache: new Map(),
    state: {},
    sftpBarItem: {
      showMsg: jest.fn(),
      reset: jest.fn(),
      startSpinner: jest.fn(),
      stopSpinner: jest.fn(),
      updateStatus: jest.fn(),
    },
  },
}));
jest.mock('../../src/host', () => ({
  promptForPassword: jest.fn(),
  showConfirmMessage: jest.fn(async () => false),
  showWarningMessage: jest.fn(),
  getOpenTextDocuments: jest.fn(() => []),
  getUserSetting: jest.fn(() => ({ get: jest.fn(() => false), update: jest.fn() })),
}));
jest.mock('../../src/modules/secrets', () => ({
  storeCredential: jest.fn(),
  getCredential: jest.fn(async () => undefined),
}));
jest.mock('../../src/core/remote-client/hostKeyStore', () => ({
  checkHostKey: jest.fn(async () => true),
}));
jest.mock('../../src/modules/connectionHealth', () => ({
  setConnectionState: jest.fn(),
  removeConnection: jest.fn(),
}));
jest.mock('../../src/fileHandlers/diff', () => ({
  diff: jest.fn(async () => undefined),
}));

const startFTPServer = require('../fixtures/ftpServer');
const startSFTPServer = require('../fixtures/sftpServer');
const upath = require('../../src/core/upath').default;
const localFs = require('../../src/core/localFs').default;
const FileService = require('../../src/core/fileService').default;
const { FTPFileSystem, SFTPFileSystem } = require('../../src/core/fs');
const { TransferDirection } = require('../../src/core/transferTask');
const { transfer } = require('../../src/fileHandlers/transfer/transfer');
const {
  createConflictLifecycle,
  UploadConflictAbortError,
} = require('../../src/fileHandlers/transfer/conflictCheck');
const {
  disposeConflictBridge,
  getConflictMcpConfiguration,
  initializeConflictBridge,
} = require('../../src/fileHandlers/transfer/conflictBridge');
const {
  initRemoteBaselineStore,
} = require('../../src/fileHandlers/transfer/remoteBaseline');
const {
  MCP_CONFIG_ENV,
} = require('../../src/mcp/conflictContract');

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

async function runTransfer({ srcFs, targetFs, src, target, direction, lifecycle }) {
  const tasks = [];
  await transfer(
    {
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
    },
    task => tasks.push(task)
  );
  for (const task of tasks) {
    await task.run();
  }
}

function structured(result) {
  if (!result.structuredContent) {
    throw new Error(`Expected structured MCP result: ${JSON.stringify(result)}`);
  }
  return result.structuredContent;
}

async function waitForConflict(client, expectedPath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = structured(
      await client.callTool({ name: 'conflicts_list', arguments: {} })
    );
    const conflict = result.conflicts.find(item => item.path === expectedPath);
    if (conflict) {
      return conflict;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for conflict ${expectedPath}`);
}

function serviceConfig(protocol, port) {
  return {
    protocol,
    host: '127.0.0.1',
    port,
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
  };
}

for (const protocol of ['ftp', 'sftp']) {
  test(`${protocol.toUpperCase()} scripted MCP agent handles stale, cancel, and upload failure without a click`, async () => {
    quickPicks.length = 0;
    const localRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), `sftp-sync-mcp-${protocol}-`)
    );
    const globalStorageRoot = path.join(localRoot, 'global');
    const server =
      protocol === 'ftp' ? await startFTPServer() : await startSFTPServer();
    const config = serviceConfig(protocol, server.port);
    const option = {
      protocol,
      host: '127.0.0.1',
      port: server.port,
      username: 'test',
      password: 'test',
      connectTimeout: 1000,
      keepalive: 0,
      remoteTimeOffsetInHours: 0,
      workspace: localRoot,
      debug: () => undefined,
    };
    const Constructor = protocol === 'ftp' ? FTPFileSystem : SFTPFileSystem;
    const remoteFs = new Constructor(upath, {
      clientOption: option,
      remoteTimeOffsetInHours: 0,
    });
    let transport;
    let client;
    try {
      await remoteFs.connect(option, {
        askForPasswd: async () => 'test',
        verifyHostKey: async () => true,
      });
      initRemoteBaselineStore(memoryMemento());
      await initializeConflictBridge([localRoot], '0.1.0-test', {
        globalStorageRoot,
        notifications: false,
      });
      const mcpConfiguration = getConflictMcpConfiguration(
        '0.1.0-test',
        new Map()
      );
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(__dirname, '..', '..', 'dist', 'mcp-server.js')],
        env: {
          ...process.env,
          [MCP_CONFIG_ENV]: JSON.stringify(mcpConfiguration),
        },
        stderr: 'pipe',
      });
      client = new Client({ name: 'scripted-fake-agent', version: '1.0.0' });
      await client.connect(transport);

      const fileService = new FileService(localRoot, localRoot, config);
      let sequence = 0;
      async function beginConflict(label) {
        sequence += 1;
        const remotePath = `/${label}.txt`;
        const localPath = path.join(localRoot, `${label}.txt`);
        const initial = Buffer.from(`${label} remote baseline\n`);
        const changed = Buffer.from(`${label} remote changed\n`);
        await server.sandbox.seed(
          remotePath,
          initial,
          new Date(`2026-09-23T12:00:${String(sequence * 10).padStart(2, '0')}Z`)
        );
        await runTransfer({
          srcFs: remoteFs,
          targetFs: localFs,
          src: remotePath,
          target: localPath,
          direction: TransferDirection.REMOTE_TO_LOCAL,
          lifecycle: createConflictLifecycle({ fileService, config }),
        });
        await server.sandbox.seed(
          remotePath,
          changed,
          new Date(`2026-09-23T12:01:${String(sequence * 10).padStart(2, '0')}Z`)
        );
        await fs.promises.writeFile(localPath, `${label} local edit\n`);
        await fs.promises.utimes(
          localPath,
          new Date('2026-09-23T12:02:00Z'),
          new Date('2026-09-23T12:02:00Z')
        );
        const upload = runTransfer({
          srcFs: localFs,
          targetFs: remoteFs,
          src: localPath,
          target: remotePath,
          direction: TransferDirection.LOCAL_TO_REMOTE,
          lifecycle: createConflictLifecycle({ fileService, config }),
        });
        const conflict = await waitForConflict(client, `${label}.txt`);
        return { remotePath, localPath, changed, upload, conflict };
      }

      const happy = await beginConflict('happy');
      const context = structured(
        await client.callTool({
          name: 'conflicts_get',
          arguments: {
            conflictId: happy.conflict.conflictId,
            workspace: happy.conflict.workspace,
          },
        })
      );
      expect(context).toMatchObject({ status: 'pending', revision: 1 });
      const localRead = structured(
        await client.callTool({
          name: 'conflicts_read',
          arguments: {
            conflictId: happy.conflict.conflictId,
            workspace: happy.conflict.workspace,
            side: 'local',
          },
        })
      );
      const remoteRead = structured(
        await client.callTool({
          name: 'conflicts_read',
          arguments: {
            conflictId: happy.conflict.conflictId,
            workspace: happy.conflict.workspace,
            side: 'remote',
          },
        })
      );
      expect(remoteRead.content).toBe(happy.changed.toString());
      const firstMerged = 'happy merged before remote raced\n';
      const submitted = structured(
        await client.callTool({
          name: 'conflicts_submit_local',
          arguments: {
            conflictId: happy.conflict.conflictId,
            workspace: happy.conflict.workspace,
            expectedRevision: context.revision,
            expectedLocalSha256: localRead.sha256,
            content: firstMerged,
          },
        })
      );
      expect(submitted).toMatchObject({ ok: true, accepted: true, revision: 2 });
      expect(await server.sandbox.read(happy.remotePath)).toEqual(happy.changed);

      const racedRemote = Buffer.from('happy remote changed again\n');
      await server.sandbox.seed(
        happy.remotePath,
        racedRemote,
        new Date('2026-09-23T12:03:00Z')
      );
      const staleResolve = await client.callTool({
        name: 'conflicts_resolve',
        arguments: {
          conflictId: happy.conflict.conflictId,
          workspace: happy.conflict.workspace,
          expectedRevision: submitted.revision,
          action: 'upload',
        },
      });
      expect(staleResolve.isError).toBe(true);
      expect(structured(staleResolve).error).toMatchObject({
        code: 'stale',
        revision: 3,
        stale: true,
      });
      const refreshedLocal = structured(
        await client.callTool({
          name: 'conflicts_read',
          arguments: {
            conflictId: happy.conflict.conflictId,
            workspace: happy.conflict.workspace,
            side: 'local',
          },
        })
      );
      const refreshedRemote = structured(
        await client.callTool({
          name: 'conflicts_read',
          arguments: {
            conflictId: happy.conflict.conflictId,
            workspace: happy.conflict.workspace,
            side: 'remote',
          },
        })
      );
      expect(refreshedRemote.content).toBe(racedRemote.toString());
      const finalMerged = Buffer.from('happy final exact merged bytes\n');
      const resubmitted = structured(
        await client.callTool({
          name: 'conflicts_submit_local',
          arguments: {
            conflictId: happy.conflict.conflictId,
            workspace: happy.conflict.workspace,
            expectedRevision: 3,
            expectedLocalSha256: refreshedLocal.sha256,
            content: finalMerged.toString(),
          },
        })
      );
      const resolved = structured(
        await client.callTool({
          name: 'conflicts_resolve',
          arguments: {
            conflictId: happy.conflict.conflictId,
            workspace: happy.conflict.workspace,
            expectedRevision: resubmitted.revision,
            action: 'upload',
          },
        })
      );
      expect(resolved.accepted).toBe(true);
      await happy.upload;
      const uploaded = structured(
        await client.callTool({
          name: 'conflicts_wait',
          arguments: {
            conflictId: happy.conflict.conflictId,
            workspace: happy.conflict.workspace,
            expectedRevision: resubmitted.revision,
            timeoutSeconds: 5,
          },
        })
      );
      expect(uploaded).toMatchObject({ terminal: true, status: 'uploaded' });
      expect(await server.sandbox.read(happy.remotePath)).toEqual(finalMerged);

      const deleted = await beginConflict('deleted');
      const deletedLocal = structured(
        await client.callTool({
          name: 'conflicts_read',
          arguments: {
            conflictId: deleted.conflict.conflictId,
            workspace: deleted.conflict.workspace,
            side: 'local',
          },
        })
      );
      const deletedSubmit = structured(
        await client.callTool({
          name: 'conflicts_submit_local',
          arguments: {
            conflictId: deleted.conflict.conflictId,
            workspace: deleted.conflict.workspace,
            expectedRevision: 1,
            expectedLocalSha256: deletedLocal.sha256,
            content: 'must not recreate deleted remote\n',
          },
        })
      );
      await fs.promises.unlink(server.sandbox.assertAllowed(deleted.remotePath));
      const deletedResolve = await client.callTool({
        name: 'conflicts_resolve',
        arguments: {
          conflictId: deleted.conflict.conflictId,
          workspace: deleted.conflict.workspace,
          expectedRevision: deletedSubmit.revision,
          action: 'upload',
        },
      });
      expect(deletedResolve.isError).toBe(true);
      expect(structured(deletedResolve).error).toMatchObject({
        code: 'stale',
        revision: 3,
        stale: true,
      });
      expect(await server.sandbox.exists(deleted.remotePath)).toBe(false);
      const deletedContext = structured(
        await client.callTool({
          name: 'conflicts_get',
          arguments: {
            conflictId: deleted.conflict.conflictId,
            workspace: deleted.conflict.workspace,
          },
        })
      );
      expect(deletedContext).toMatchObject({
        revision: 3,
        staleReason: 'remote-missing',
        candidate: null,
      });
      const deletedCancel = structured(
        await client.callTool({
          name: 'conflicts_resolve',
          arguments: {
            conflictId: deleted.conflict.conflictId,
            workspace: deleted.conflict.workspace,
            expectedRevision: 3,
            action: 'cancel',
          },
        })
      );
      expect(deletedCancel.accepted).toBe(true);
      await expect(deleted.upload).rejects.toBeInstanceOf(UploadConflictAbortError);
      expect(await server.sandbox.exists(deleted.remotePath)).toBe(false);

      const cancelled = await beginConflict('cancelled');
      const cancel = structured(
        await client.callTool({
          name: 'conflicts_resolve',
          arguments: {
            conflictId: cancelled.conflict.conflictId,
            workspace: cancelled.conflict.workspace,
            expectedRevision: 1,
            action: 'cancel',
          },
        })
      );
      expect(cancel.accepted).toBe(true);
      await expect(cancelled.upload).rejects.toBeInstanceOf(UploadConflictAbortError);
      expect(await server.sandbox.read(cancelled.remotePath)).toEqual(cancelled.changed);

      const failed = await beginConflict('failed');
      const failedLocal = structured(
        await client.callTool({
          name: 'conflicts_read',
          arguments: {
            conflictId: failed.conflict.conflictId,
            workspace: failed.conflict.workspace,
            side: 'local',
          },
        })
      );
      const failedSubmit = structured(
        await client.callTool({
          name: 'conflicts_submit_local',
          arguments: {
            conflictId: failed.conflict.conflictId,
            workspace: failed.conflict.workspace,
            expectedRevision: 1,
            expectedLocalSha256: failedLocal.sha256,
            content: 'upload must fail\n',
          },
        })
      );
      const originalPut = remoteFs.put.bind(remoteFs);
      remoteFs.put = jest.fn(async () => {
        throw new Error('induced upload failure');
      });
      await client.callTool({
        name: 'conflicts_resolve',
        arguments: {
          conflictId: failed.conflict.conflictId,
          workspace: failed.conflict.workspace,
          expectedRevision: failedSubmit.revision,
          action: 'upload',
        },
      });
      await expect(failed.upload).rejects.toThrow();
      remoteFs.put = originalPut;
      const failure = structured(
        await client.callTool({
          name: 'conflicts_wait',
          arguments: {
            conflictId: failed.conflict.conflictId,
            workspace: failed.conflict.workspace,
            expectedRevision: failedSubmit.revision,
            timeoutSeconds: 5,
          },
        })
      );
      expect(failure).toMatchObject({ terminal: true, status: 'failed' });
      expect(failure.result.error).toBeTruthy();
      expect(quickPicks.every(item => item.manualClicks === 0)).toBe(true);
    } finally {
      if (client) {
        await client.close().catch(() => {});
      } else if (transport) {
        await transport.close().catch(() => {});
      }
      remoteFs.end();
      await disposeConflictBridge();
      await server.close();
      await fs.promises.rm(localRoot, { recursive: true, force: true });
    }
  }, 45_000);
}
