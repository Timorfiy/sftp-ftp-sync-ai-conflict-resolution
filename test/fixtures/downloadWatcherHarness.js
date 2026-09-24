const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

// The production watcher and transfer code run unchanged. Only the VS Code
// event source, upload sink and unrelated UI/services are replaced.
const events = new Map();
const running = [];
const conflicts = new Set();
const upload = jest.fn(async () => {});
const removeRemote = jest.fn(async () => {});
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), trace: jest.fn(), debug: jest.fn() };
jest.doMock('vscode', () => ({
  Uri: { file: fsPath => ({ scheme: 'file', fsPath }) },
  RelativePattern: class { constructor(base) { this.base = base; } },
  workspace: {
    createFileSystemWatcher: pattern => {
      const handlers = {};
      events.set(pattern.base, handlers);
      return {
        onDidCreate: fn => { handlers.create = fn; },
        onDidChange: fn => { handlers.change = fn; },
        onDidDelete: fn => { handlers.delete = fn; },
        dispose: () => events.delete(pattern.base),
      };
    },
  },
}));
jest.doMock('../../src/fileHandlers', () => ({ upload, removeRemote }));
jest.doMock('../../src/modules/serviceManager', () => ({ getRunningTransformTasks: () => running }));
jest.doMock('../../src/fileHandlers/transfer/conflictBridge', () => ({
  isConflictPathActive: file => conflicts.has(file),
}));
jest.doMock('../../src/logger', () => ({ __esModule: true, default: logger }));
jest.doMock('../../src/app', () => ({
  __esModule: true, default: { sftpBarItem: { updateStatus: jest.fn() } },
}));
jest.doMock('../../src/host', () => ({ getOpenTextDocuments: () => [] }));
jest.doMock('../../src/helper', () => ({
  isValidFile: uri => uri.scheme === 'file',
  fileDepth: file => file.split(path.sep).length,
}));

const watcherModule = require('../../src/modules/fileWatcher');
const watcher = watcherModule.default;
const suppression = require('../../src/modules/watcherSuppression');
const localFs = require('../../src/core/localFs').default;
const TransferTask = require('../../src/core/transferTask').default;
const { TransferDirection } = require('../../src/core/transferTask');
const { FileType } = require('../../src/core/fs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sandbox() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'download-watcher-'));
  const roots = [];
  const nativeWatchers = [];
  const observed = new Set();
  const nativeErrors = [];
  function watch(base = root, native = false, ignore) {
    watcher.create(base, { files: '**/*', autoUpload: true, autoDelete: true }, ignore);
    roots.push(base);
    if (native) {
      const handle = fs.watch(base, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const file = path.join(base, filename.toString());
        observed.add(file);
        // fs.watch has rename/change, while VS Code exposes create/change/delete.
        // Deliberately send duplicate create + change for existing entries.
        if (fs.existsSync(file)) {
          emit('create', file, base);
          emit('change', file, base);
        } else {
          emit('delete', file, base);
        }
      });
      handle.on('error', error => nativeErrors.push(error));
      nativeWatchers.push(handle);
    }
  }
  function emit(kind, file, base = root) {
    events.get(base)?.[kind]?.({ scheme: 'file', fsPath: file });
  }
  function task(file, content = 'remote bytes', targetFs = localFs, options = {}) {
    return new TransferTask(
      { fsPath: '/fixture/file', fileSystem: { get: async () => Readable.from([content]) } },
      { fsPath: file, fileSystem: targetFs },
      {
        fileType: FileType.File,
        transferDirection: TransferDirection.REMOTE_TO_LOCAL,
        transferOption: { atime: 0, mtime: 0, perserveTargetMode: false, ...options },
      }
    );
  }
  const flush = async () => {
    if (watcherModule._flushWatcherQueues) {
      await watcherModule._flushWatcherQueues();
    } else {
      // Allows the regression to be run against the pre-fix watcher too.
      await pause(650);
    }
  };
  return {
    root, watch, emit, task, flush, observed, nativeErrors,
    async close() {
      nativeWatchers.forEach(handle => handle.close());
      await flush();
      roots.forEach(base => watcher.dispose(base));
      suppression._reset();
      // root comes only from mkdtemp above, never from workspace configuration.
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

function reset() {
  upload.mockClear();
  removeRemote.mockClear();
  Object.values(logger).forEach(fn => fn.mockClear());
  running.length = 0;
  conflicts.clear();
  suppression._reset();
}

module.exports = {
  sandbox, reset, upload, removeRemote, running, conflicts, logger,
  suppression, localFs, pause, watcher,
};
