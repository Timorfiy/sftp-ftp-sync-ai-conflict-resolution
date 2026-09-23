const settingStore = {
  sftp: {
    suppressPlaintextPasswordWarning: false,
  },
  'remotefs.remote': {},
};

jest.mock('vscode', () => ({
  EventEmitter: class EventEmitter {
    constructor() {
      this.event = jest.fn();
      this.fire = jest.fn();
    }
  },
  ThemeIcon: class ThemeIcon {
    constructor(id) {
      this.id = id;
    }
  },
  TreeItemCollapsibleState: { None: 0 },
  workspace: {
    getConfiguration: jest.fn((section) => {
      const settings = settingStore[section] || {};
      return {
        get: jest.fn((key, defaultValue) => {
          const value = settings[key];
          return value === undefined ? defaultValue : value;
        }),
        update: jest.fn((key, value, global) => {
          settings[key] = value;
          return Promise.resolve();
        }),
      };
    }),
  },
  window: {
    showWarningMessage: jest.fn(() => Promise.resolve(undefined)),
    createStatusBarItem: jest.fn(() => ({
      show: jest.fn(),
      hide: jest.fn(),
      text: '',
      tooltip: '',
      command: undefined,
    })),
    createOutputChannel: jest.fn(() => ({
      show: jest.fn(),
      hide: jest.fn(),
      appendLine: jest.fn(),
      clear: jest.fn(),
    })),
  },
  StatusBarAlignment: { Left: 1 },
  commands: {
    executeCommand: jest.fn(() => Promise.resolve()),
  },
  Uri: {
    file: jest.fn((path) => ({ fsPath: path, scheme: 'file' })),
    parse: jest.fn((path) => ({ fsPath: path, scheme: 'file' })),
  },
}));

jest.mock('../../src/core/remoteFs', () => ({
  createRemoteIfNoneExist: jest.fn(() => Promise.resolve({})),
  removeRemoteFs: jest.fn(),
}));

jest.mock('../../src/modules/secrets', () => ({
  getCredential: jest.fn(() => Promise.resolve(undefined)),
  createCredentialEndpoint: jest.fn(config => ({
    transport: config.protocol,
    host: config.host.trim().toLowerCase(),
    port: config.port,
    username: config.username,
  })),
}));

const vscode = require('vscode');
const FileService = require('../../src/core/fileService').default;
const TransferTask = require('../../src/core/transferTask').default;
const { TransferDirection } = require('../../src/core/transferTask');
const { FileType } = require('../../src/core/fs');
const {
  TransferQueueProvider,
} = require('../../src/modules/transferQueue');
const { classifyError } = require('../../src/errors/actionable');
const {
  transfer,
} = require('../../src/fileHandlers/transfer/transfer');
const { createRemoteIfNoneExist, removeRemoteFs } = require('../../src/core/remoteFs');
const {
  clearConflictStateIsolation,
  configureConflictStateIsolation,
} = require('../../src/fileHandlers/transfer/conflictStateIsolation');

function createConfig(overrides = {}) {
  return {
    name: 'test',
    context: '/tmp',
    host: 'example.com',
    port: 22,
    username: 'user',
    password: 'secret',
    protocol: 'sftp',
    remotePath: '/',
    uploadOnSave: false,
    useTempFile: false,
    openSsh: false,
    downloadOnOpen: false,
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
    },
    ignore: [],
    ignoreFile: '',
    remoteExplorer: {
      order: 0,
    },
    remoteTimeOffsetInHours: 0,
    limitOpenFilesOnRemote: 0,
    passphrase: null,
    interactiveAuth: false,
    algorithms: {},
    concurrency: 1,
    sshConfigPath: undefined,
    hop: undefined,
    agent: null,
    privateKeyPath: null,
    secure: false,
    secureOptions: {},
    watcher: {
      files: false,
      autoUpload: false,
      autoDelete: false,
    },
    ...overrides,
  };
}

describe('FileService connection labels', () => {
  test('uses the selected profile name', () => {
    const service = new FileService('/tmp', '/tmp', createConfig({
      profiles: { production: { host: 'prod.example.com' } },
    }));
    service.name = 'Website';

    expect(service.getConnectionLabel('production')).toBe('Profile "production"');
  });

  test('uses a named base connection when profiles exist but none is selected', () => {
    const service = new FileService('/tmp', '/tmp', createConfig({
      profiles: { production: { host: 'prod.example.com' } },
    }));
    service.name = 'Website';

    expect(service.getConnectionLabel(null)).toBe('Base connection "Website"');
  });

  test('uses the connection name when no profiles exist', () => {
    const service = new FileService('/tmp', '/tmp', createConfig());
    service.name = 'Website';

    expect(service.getConnectionLabel(null)).toBe('Connection "Website"');
  });

  test('has a deterministic unnamed fallback', () => {
    const service = new FileService('/tmp', '/tmp', createConfig());

    expect(service.getConnectionLabel(null)).toBe('Default connection');
  });
});

describe('FileService plaintext password warning', () => {
  beforeEach(() => {
    settingStore.sftp.suppressPlaintextPasswordWarning = false;
    vscode.window.showWarningMessage.mockClear();
    vscode.window.showWarningMessage.mockImplementation(() => Promise.resolve(undefined));
    createRemoteIfNoneExist.mockClear();
  });

  test('shows warning when a plaintext password is present', async () => {
    const service = new FileService('/tmp', '/tmp', createConfig());
    await service.getRemoteFileSystem(createConfig());

    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('plaintext password'),
      "Don't show again"
    );
  });

  test('plaintext warning never contains the configured password', async () => {
    const password = 'plaintext-warning-canary-94865a';
    const service = new FileService(
      '/tmp',
      '/tmp',
      createConfig({ password })
    );
    await service.getRemoteFileSystem(createConfig({ password }));

    const displayed = JSON.stringify(
      vscode.window.showWarningMessage.mock.calls
    );
    expect(displayed).toContain('plaintext password');
    expect(displayed).not.toContain(password);
  });

  test('does not show warning when sentinel value "prompt" is used', async () => {
    const service = new FileService('/tmp', '/tmp', createConfig({ password: 'prompt' }));
    await service.getRemoteFileSystem(createConfig({ password: 'prompt' }));

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  test('does not show warning when sentinel value "secretStorage" is used', async () => {
    const service = new FileService('/tmp', '/tmp', createConfig({ password: 'secretStorage' }));
    await service.getRemoteFileSystem(createConfig({ password: 'secretStorage' }));

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  test('does not show warning when suppressPlaintextPasswordWarning is true', async () => {
    settingStore.sftp.suppressPlaintextPasswordWarning = true;

    const service = new FileService('/tmp', '/tmp', createConfig());
    await service.getRemoteFileSystem(createConfig());

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  test('persists suppression when "Don\'t show again" is clicked', async () => {
    vscode.window.showWarningMessage.mockImplementation(() =>
      Promise.resolve("Don't show again")
    );

    const service = new FileService('/tmp', '/tmp', createConfig());
    await service.getRemoteFileSystem(createConfig());

    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(settingStore.sftp.suppressPlaintextPasswordWarning).toBe(true);
  });
});

describe('FileService remote connection identity', () => {
  beforeEach(() => {
    createRemoteIfNoneExist.mockClear();
    removeRemoteFs.mockClear();
  });

  test('uses the workspace-scoped identity when clearing a cached connection', async () => {
    const config = createConfig({ password: 'prompt' });
    const service = new FileService('/tmp', 'C:\\workspace\\site', config);
    await service.getRemoteFileSystem(config);

    service.clearRemoteFileSystem(config);

    expect(createRemoteIfNoneExist).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: 'C:\\workspace\\site' })
    );
    expect(removeRemoteFs).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: 'C:\\workspace\\site' })
    );
  });
});

describe('FileService watcher profile override', () => {
  const app = require('../../src/app').default;

  // AppState invokes its observer on every change and holds only one, so the
  // tests need something registered before touching the profile.
  app.state.subscribe(() => {});

  function watcherConfigPassedTo(create) {
    return create.mock.calls[create.mock.calls.length - 1][1];
  }

  function serviceWithWatcherService(config) {
    const create = jest.fn();
    const dispose = jest.fn();
    const service = new FileService('/tmp', '/tmp', config);
    service.setWatcherService({ create, dispose });
    return { service, create, dispose };
  }

  beforeEach(() => {
    app.state.profile = null;
  });

  afterEach(() => {
    app.state.profile = null;
  });

  test('uses the root watcher config when no profile is active', () => {
    const { create } = serviceWithWatcherService(
      createConfig({ watcher: { files: '**/*', autoUpload: true, autoDelete: false } })
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(watcherConfigPassedTo(create)).toEqual({
      files: '**/*',
      autoUpload: true,
      autoDelete: false,
    });
  });

  test('a profile overrides the watcher config', () => {
    const { service, create } = serviceWithWatcherService(
      createConfig({
        watcher: { files: '**/*', autoUpload: true, autoDelete: false },
        profiles: {
          dev: { watcher: { files: '**/*', autoUpload: true, autoDelete: false } },
          prod: { watcher: { files: '**/*', autoUpload: false, autoDelete: false } },
        },
      })
    );

    app.state.profile = 'prod';
    service.reloadWatcher();

    expect(watcherConfigPassedTo(create).autoUpload).toBe(false);

    app.state.profile = 'dev';
    service.reloadWatcher();

    expect(watcherConfigPassedTo(create).autoUpload).toBe(true);
  });

  test('profiles that do not mention watcher inherit the root one', () => {
    const { service, create } = serviceWithWatcherService(
      createConfig({
        watcher: { files: '**/*', autoUpload: true, autoDelete: false },
        profiles: {
          prod: { host: 'prod.example.com' },
        },
      })
    );

    app.state.profile = 'prod';
    service.reloadWatcher();

    expect(watcherConfigPassedTo(create).autoUpload).toBe(true);
  });

  test('reloadWatcher disposes the previous watcher before rebuilding', () => {
    const { service, create, dispose } = serviceWithWatcherService(
      createConfig({ watcher: { files: '**/*', autoUpload: true, autoDelete: false } })
    );

    dispose.mockClear();
    service.reloadWatcher();

    expect(dispose).toHaveBeenCalledWith('/tmp');
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('FileService .vscode safeguard', () => {
  afterEach(() => {
    clearConflictStateIsolation();
  });

  test('.vscode is ignored even when user "ignore" is empty', () => {
    const service = new FileService('/tmp', '/tmp', createConfig({ ignore: [] }));
    const { ignore } = service.getConfig();

    expect(ignore('/tmp/.vscode/sftp.json')).toBe(true);
    expect(ignore('/tmp/.vscode')).toBe(true);
  });

  test('.vscode stays ignored even if user "ignore" tries to negate it', () => {
    const service = new FileService(
      '/tmp',
      '/tmp',
      createConfig({ ignore: ['!.vscode', '!.vscode/**'] })
    );
    const { ignore } = service.getConfig();

    expect(ignore('/tmp/.vscode/sftp.json')).toBe(true);
  });

  test('unrelated files are not affected by the safeguard', () => {
    const service = new FileService('/tmp', '/tmp', createConfig({ ignore: [] }));
    const { ignore } = service.getConfig();

    expect(ignore('/tmp/index.js')).toBe(false);
  });

  test('legacy conflict state stays ignored even when user rules negate it', () => {
    const service = new FileService(
      '/tmp',
      '/tmp',
      createConfig({
        ignore: ['!.kent-tmp', '!.kent-tmp/**'],
      })
    );
    const { ignore } = service.getConfig();

    expect(ignore('/tmp/.kent-tmp/sftp-conflicts/record/conflict.json')).toBe(true);
  });

  test('registered global conflict storage is always ignored', () => {
    configureConflictStateIsolation('/private/conflict-state-v2', ['/tmp']);
    const service = new FileService('/tmp', '/tmp', createConfig({ ignore: [] }));
    const { ignore } = service.getConfig();

    expect(ignore('/private/conflict-state-v2/workspaces/bucket/conflict.json')).toBe(true);
  });
});


describe('FTP profile network interface inheritance', () => {
  test('each profile can select an adapter or explicitly restore system routing', () => {
    const service = new FileService('/tmp', '/tmp', createConfig({
      protocol: 'ftp', networkInterface: 'Ethernet',
      profiles: { inherit: {}, wifi: { networkInterface: 'Wi-Fi' }, system: { networkInterface: null } },
    }));
    expect(service.getConfig('inherit').networkInterface).toBe('Ethernet');
    expect(service.getConfig('wifi').networkInterface).toBe('Wi-Fi');
    expect(service.getConfig('system').networkInterface).toBeNull();
  });
});

describe('FileService transfer operation results', () => {
  function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  }

  function transferTask(name, gate) {
    let cancelled = false;
    return {
      localFsPath: `C:\\workspace\\${name}`,
      srcFsPath: `/source/${name}`,
      targetFsPath: `/target/${name}`,
      run: () => gate ? gate.promise : Promise.resolve(),
      cancel: () => {
        cancelled = true;
        if (gate) {
          gate.resolve();
        }
      },
      isCancelled: () => cancelled,
      getWarnings: () => [],
    };
  }

  test('cancelling retains active and queued items as cancelled', async () => {
    const service = new FileService('/tmp', '/tmp', createConfig());
    const gate = deferred();
    const active = transferTask('active.txt', gate);
    const queued = transferTask('queued.txt');
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(active);
    scheduler.add(queued);

    const running = scheduler.run();
    service.cancelTransferTasks();

    await expect(running).rejects.toMatchObject({
      failureId: 'operation.cancelled',
      result: {
        completed: 0,
        failed: 0,
        cancelled: 2,
        notStarted: 0,
      },
    });
    expect(scheduler.operation.result().items).toEqual([
      expect.objectContaining({ status: 'cancelled', attempts: 1 }),
      expect.objectContaining({ status: 'cancelled', attempts: 0 }),
    ]);
  });

  test('cancelling one pending queue row prevents every transfer side effect', async () => {
    const service = new FileService('/tmp', '/tmp', createConfig());
    const queue = new TransferQueueProvider();
    const queueIds = new Map();
    service.queuedTransfer(task => {
      queueIds.set(task, queue.add(task));
    });
    service.beforeTransfer(task => queue.start(queueIds.get(task)));
    service.afterTransfer((error, task) =>
      queue.done(queueIds.get(task), error || undefined)
    );

    const gate = deferred();
    const active = transferTask('active.txt', gate);
    const sourceFs = {
      get: jest.fn(() => {
        throw new Error('cancelled task read source');
      }),
    };
    const targetFs = {
      lstat: jest.fn(() => {
        throw new Error('cancelled task inspected target');
      }),
      open: jest.fn(() => {
        throw new Error('cancelled task opened target');
      }),
      put: jest.fn(() => {
        throw new Error('cancelled task wrote target');
      }),
    };
    const pending = new TransferTask(
      { fsPath: '/source/pending.txt', fileSystem: sourceFs },
      { fsPath: '/target/pending.txt', fileSystem: targetFs },
      {
        fileType: FileType.File,
        transferDirection: TransferDirection.LOCAL_TO_REMOTE,
        transferOption: {
          atime: Date.now(),
          mtime: Date.now(),
          perserveTargetMode: false,
        },
      }
    );
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(active);
    scheduler.add(pending);
    const running = scheduler.run();

    const pendingQueueId = queueIds.get(pending);
    queue.cancel(pendingQueueId);
    gate.resolve();

    await expect(running).rejects.toMatchObject({
      failureId: 'operation.partial',
      result: {
        completed: 1,
        failed: 0,
        cancelled: 1,
        notStarted: 0,
      },
    });
    expect(sourceFs.get).not.toHaveBeenCalled();
    expect(targetFs.lstat).not.toHaveBeenCalled();
    expect(targetFs.open).not.toHaveBeenCalled();
    expect(targetFs.put).not.toHaveBeenCalled();
    expect(
      queue.getChildren().find(item => item.id === pendingQueueId)
    ).toMatchObject({ status: 'cancelled', error: undefined });
  });

  test('warning-only completion resolves and retains a completed warning row', async () => {
    const service = new FileService('/tmp', '/tmp', createConfig());
    const queue = new TransferQueueProvider();
    const warningTask = transferTask('warning.txt');
    warningTask.getWarnings = () => [
      {
        failureId: 'backup.overwrite-failed',
        message: 'Previous remote text may not be recoverable.',
      },
    ];
    const queueId = queue.add(warningTask);
    service.beforeTransfer(() => queue.start(queueId));
    service.afterTransfer((error, task) => queue.done(queueId, error || undefined));
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(warningTask);

    await expect(scheduler.run()).resolves.toMatchObject({
      completed: 1,
      failed: 0,
      cancelled: 0,
      warnings: 1,
      isPartial: true,
    });
    expect(queue.getChildren()).toEqual([
      expect.objectContaining({
        status: 'completed',
        warning: 'Previous remote text may not be recoverable.',
      }),
    ]);
  });
});

describe('FileService production error boundaries', () => {
  function classifyThrown(operation) {
    let error;
    try {
      operation();
    } catch (caught) {
      error = caught;
    }
    return classifyError(error);
  }

  test('configuration validation failure keeps Configuration and Open Config', () => {
    const service = new FileService('/tmp', '/tmp', createConfig());
    service.setConfigValidator(() => ({ message: 'port must be a number' }));

    let error;
    try {
      service.getConfig();
    } catch (caught) {
      error = caught;
    }
    const actionable = classifyError(error);

    expect(actionable.id).toBe('configuration.invalid');
    expect(actionable.actions).toContain('open-config');
  });

  test('unknown active profile keeps Configuration and Open Config', () => {
    const service = new FileService(
      '/tmp',
      '/tmp',
      createConfig({ profiles: { staging: { host: 'staging.example.com' } } })
    );

    let error;
    try {
      service.getConfig('missing');
    } catch (caught) {
      error = caught;
    }
    const actionable = classifyError(error);

    expect(actionable.id).toBe('configuration.invalid');
    expect(actionable.actions).toContain('open-config');
  });

  test('missing environment-backed agent keeps Configuration and Open Config', () => {
    const variable = 'SFTP_SYNC_AI_MISSING_AGENT_FOR_TEST';
    delete process.env[variable];
    const service = new FileService(
      '/tmp',
      '/tmp',
      createConfig({ agent: `$${variable}` })
    );

    const actionable = classifyThrown(() => service.getConfig());

    expect(actionable.id).toBe('configuration.invalid');
    expect(actionable.actions).toContain('open-config');
    expect(actionable.troubleshootingSection).toBe('configuration');
  });

  test('missing configured ignoreFile keeps Configuration and Open Config', () => {
    const service = new FileService(
      '/tmp',
      '/tmp',
      createConfig({ ignoreFile: 'missing-ignore-file-for-routing-test' })
    );

    const actionable = classifyThrown(() => service.getConfig());

    expect(actionable.id).toBe('configuration.invalid');
    expect(actionable.actions).toContain('open-config');
    expect(actionable.troubleshootingSection).toBe('configuration');
  });

  test('missing remote reference keeps Configuration and Open Config', () => {
    const service = new FileService(
      '/tmp',
      '/tmp',
      createConfig({ remote: 'missing-settings-reference' })
    );

    const actionable = classifyThrown(() => service.getConfig());

    expect(actionable.id).toBe('configuration.invalid');
    expect(actionable.actions).toContain('open-config');
    expect(actionable.troubleshootingSection).toBe('configuration');
  });
});

describe('FileService transfer path routing boundaries', () => {
  function missing(message) {
    return Object.assign(new Error(message), { code: 'ENOENT' });
  }

  function readableSource(overrides = {}) {
    return {
      get: jest.fn(async () => require('stream').Readable.from(['content'])),
      ...overrides,
    };
  }

  function writableTarget(overrides = {}) {
    return {
      pathResolver: require('path').posix,
      open: jest.fn(async () => 1),
      put: jest.fn(async () => undefined),
      close: jest.fn(async () => undefined),
      unlink: jest.fn(async () => undefined),
      renameAtomic: jest.fn(async () => undefined),
      ...overrides,
    };
  }

  async function scheduledFailure(direction, sourceFs, targetFs) {
    const service = new FileService('/tmp', '/tmp', createConfig());
    const task = new TransferTask(
      { fsPath: '/source/missing.txt', fileSystem: sourceFs },
      { fsPath: '/target/missing.txt', fileSystem: targetFs },
      {
        fileType: FileType.File,
        transferDirection: direction,
        transferOption: {
          atime: 0,
          mtime: 0,
          perserveTargetMode: false,
        },
      }
    );
    const scheduler = service.createTransferScheduler(1);
    scheduler.add(task);
    try {
      await scheduler.run();
      throw new Error('Expected transfer failure');
    } catch (error) {
      return { error, actionable: classifyError(error) };
    }
  }

  test('missing local upload source retains local path and partial counts', async () => {
    const sourceFs = readableSource({
      get: jest.fn(async () => {
        throw missing('local source file not found');
      }),
    });
    const { error, actionable } = await scheduledFailure(
      TransferDirection.LOCAL_TO_REMOTE,
      sourceFs,
      writableTarget()
    );

    expect(error).toMatchObject({
      failureId: 'path.local-unavailable',
      result: { completed: 0, failed: 1 },
    });
    expect(actionable.id).toBe('path.local-unavailable');
    expect(actionable.troubleshootingSection).toBe('local-paths');
    expect(actionable.partialResult).toMatchObject({ failed: 1 });
  });

  test('missing local staged-download target retains local path and partial counts', async () => {
    const targetFs = writableTarget({
      open: jest.fn(async () => {
        throw missing('local staged target not found');
      }),
    });
    const { error, actionable } = await scheduledFailure(
      TransferDirection.REMOTE_TO_LOCAL,
      readableSource(),
      targetFs
    );

    expect(error).toMatchObject({
      failureId: 'path.local-unavailable',
      result: { completed: 0, failed: 1 },
    });
    expect(actionable.id).toBe('path.local-unavailable');
    expect(actionable.troubleshootingSection).toBe('local-paths');
    expect(actionable.partialResult).toMatchObject({ failed: 1 });
  });

  test('missing remote upload target retains remote path and partial counts', async () => {
    const targetFs = writableTarget({
      open: jest.fn(async () => {
        throw missing('remote upload target not found');
      }),
    });
    const { error, actionable } = await scheduledFailure(
      TransferDirection.LOCAL_TO_REMOTE,
      readableSource(),
      targetFs
    );

    expect(error).toMatchObject({
      failureId: 'path.remote-unavailable',
      result: { completed: 0, failed: 1 },
    });
    expect(actionable.id).toBe('path.remote-unavailable');
    expect(actionable.troubleshootingSection).toBe('remote-paths');
    expect(actionable.partialResult).toMatchObject({ failed: 1 });
  });

  test('missing remote directory list retains remote path before scheduling', async () => {
    const remoteFs = {
      pathResolver: require('path').posix,
      lstat: jest.fn(async () => ({
        type: FileType.Directory,
        mode: 0o755,
        size: 0,
        mtime: 0,
        atime: 0,
      })),
      list: jest.fn(async () => {
        throw missing('remote directory not found');
      }),
    };
    const localFs = {
      pathResolver: require('path').win32,
      ensureDir: jest.fn(async () => undefined),
    };

    await expect(
      transfer(
        {
          srcFsPath: '/remote/missing',
          srcFs: remoteFs,
          targetFsPath: 'C:\\workspace\\missing',
          targetFs: localFs,
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
          transferOption: {
            perserveTargetMode: false,
          },
        },
        jest.fn()
      )
    ).rejects.toMatchObject({
      failureId: 'path.remote-unavailable',
      context: { pathKind: 'remote' },
    });
  });
});
