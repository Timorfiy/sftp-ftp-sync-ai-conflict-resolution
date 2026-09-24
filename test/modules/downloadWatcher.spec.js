const fs = require('fs');
const path = require('path');
const {
  sandbox, reset, upload, removeRemote, running, conflicts, logger,
  suppression, localFs, pause, watcher,
} = require('../fixtures/downloadWatcherHarness');
const { transfer, sync } = require('../../src/fileHandlers/transfer/transfer');

describe('download watcher regression (simulated VS Code events, real local files)', () => {
  let box;
  beforeEach(async () => { reset(); box = await sandbox(); box.watch(); });
  afterEach(async () => { await box.close(); });

  test('does not reupload a repeated event dispatched after the pending task is removed', async () => {
    const file = path.join(box.root, 'file.txt');
    let renamed;
    const didRename = new Promise(resolve => { renamed = resolve; });
    let finish;
    const release = new Promise(resolve => { finish = resolve; });
    const target = Object.create(localFs);
    target.renameAtomic = async (...args) => {
      await localFs.renameAtomic(...args);
      box.emit('create', file); // leading event while the task is still present
      renamed();
      await release;
    };
    const task = box.task(file, 'remote bytes', target);
    running.push(task);
    const work = task.run();
    await didRename;
    box.emit('change', file); // trailing debounce event
    finish();
    await work;
    running.length = 0; // FileService.onTaskDone removes the task here
    await pause(650);
    await box.flush();
    expect(upload).not.toHaveBeenCalled();
    box.emit('change', file); // another OS event well after task completion
    await box.flush();
    expect(upload).not.toHaveBeenCalled();
  });

  test('ignores very late duplicates but uploads a same-size edit with restored mtime', async () => {
    const file = path.join(box.root, 'file.txt');
    await box.task(file, 'remote').run();
    const stat = await fs.promises.stat(file);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 24 * 3600_000);
    try {
      box.emit('create', file);
      box.emit('change', file);
      box.emit('delete', file); // replacement reported as delete+create
      await box.flush();
      expect(upload).not.toHaveBeenCalled();
      expect(removeRemote).not.toHaveBeenCalled();
      await fs.promises.writeFile(file, 'edited');
      await fs.promises.utimes(file, stat.atime, stat.mtime);
      box.emit('change', file);
      await box.flush();
      expect(upload.mock.calls.map(([uri]) => uri.fsPath)).toEqual([file]);
      expect(suppression._downloadSuppressionState().paths).toBe(0);
    } finally { clock.mockRestore(); }
  });

  test('does not adopt an edit made immediately after rename as the downloaded version', async () => {
    const file = path.join(box.root, 'file.txt');
    const target = Object.create(localFs);
    target.renameAtomic = async (...args) => {
      await localFs.renameAtomic(...args);
      await fs.promises.writeFile(file, 'local edit');
      box.emit('change', file);
    };
    await box.task(file, 'remote bytes', target).run();
    await box.flush();
    expect(upload.mock.calls.map(([uri]) => uri.fsPath)).toEqual([file]);
  });

  test('ignores staging create/change/delete after success, error and retry', async () => {
    const file = path.join(box.root, 'file.txt');
    const stages = [];
    const target = Object.create(localFs);
    target.open = async (name, ...args) => {
      const fd = await localFs.open(name, ...args);
      stages.push(name);
      box.emit('create', name);
      return fd;
    };
    let attempts = 0;
    target.put = async (...args) => {
      await localFs.put(...args);
      if (++attempts === 1) throw Object.assign(new Error('retry'), { code: 'ECONNRESET' });
    };
    await box.task(file, 'remote bytes', target).run();
    expect(attempts).toBe(2);
    for (const stage of stages) {
      box.emit('change', stage);
      box.emit('delete', stage);
      expect(fs.existsSync(stage)).toBe(false);
    }
    box.emit('create', file);
    await box.flush();
    expect(upload).not.toHaveBeenCalled();
    expect(removeRemote).not.toHaveBeenCalled();
    const ordinary = path.join(box.root, 'notes.sftp-sync-draft.tmp');
    await fs.promises.writeFile(ordinary, 'local');
    box.emit('create', ordinary);
    await box.flush();
    expect(upload.mock.calls.map(([uri]) => uri.fsPath)).toEqual([ordinary]);
  });

  test.each(['failure', 'cancel'])('%s leaves the destination editable and no active claim', async kind => {
    const file = path.join(box.root, 'file.txt');
    await fs.promises.writeFile(file, 'original');
    const target = Object.create(localFs);
    const task = box.task(file, 'remote bytes', target);
    target.put = async (...args) => {
      await localFs.put(...args);
      if (kind === 'cancel') task.cancel();
      else throw Object.assign(new Error('disk failure'), { code: 'EACCES' });
    };
    await expect(task.run()).rejects.toThrow();
    expect(await fs.promises.readFile(file, 'utf8')).toBe('original');
    expect((await fs.promises.readdir(box.root))).toEqual(['file.txt']);
    expect(suppression._downloadSuppressionState().paths).toBe(0);
    await fs.promises.writeFile(file, 'local edit');
    box.emit('change', file);
    await box.flush();
    expect(upload.mock.calls.map(([uri]) => uri.fsPath)).toEqual([file]);
  });

  test('failed replacement preserves a previous download claim; deletion releases it', async () => {
    const file = path.join(box.root, 'file.txt');
    await box.task(file).run();
    const target = Object.create(localFs);
    target.renameAtomic = async () => { throw Object.assign(new Error('rename failed'), { code: 'EACCES' }); };
    await expect(box.task(file, 'replacement', target).run()).rejects.toThrow('rename failed');
    box.emit('change', file);
    await box.flush();
    expect(upload).not.toHaveBeenCalled();
    await fs.promises.unlink(file);
    box.emit('delete', file);
    await box.flush();
    expect(removeRemote).toHaveBeenCalledTimes(1);
    expect(suppression._downloadSuppressionState().paths).toBe(0);
  });

  test('keeps save, rename, conflict and ignore suppression and rechecks queued events', async () => {
    const files = ['save', 'rename', 'conflict', 'queued'].map(name => path.join(box.root, name));
    await Promise.all(files.map(file => fs.promises.writeFile(file, 'local')));
    suppression.suppressWatcherFor(files[0], suppression.SAVE_SUPPRESSION_TTL);
    suppression.suppressWatcherFor(files[1]);
    conflicts.add(files[2]);
    for (const file of files) box.emit('change', file);
    suppression.suppressWatcherFor(files[3]);
    await box.flush();
    expect(upload).not.toHaveBeenCalled();
    suppression.releaseWatcherSuppression(files[1]);
    box.emit('change', files[1]);
    await box.flush();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  test.each(['file', 'folder', 'remote-sync', 'both-sync'])(
    '%s uses the shared claim and does not upload created directories recursively', async mode => {
      const source = path.join(box.root, 'source');
      const destination = path.join(box.root, 'destination', 'nested');
      await fs.promises.mkdir(source);
      await fs.promises.writeFile(path.join(source, 'file.txt'), 'remote bytes');
      const tasks = [];
      const config = {
        srcFsPath: mode === 'file' ? path.join(source, 'file.txt') : source,
        targetFsPath: mode === 'file' ? path.join(destination, 'file.txt') : destination,
        srcFs: localFs, targetFs: localFs, transferDirection: 'remote ➞ local',
        transferOption: { perserveTargetMode: false, bothDiretions: mode === 'both-sync' },
      };
      if (mode === 'both-sync') {
        // Exercise the reversed download branch of the normally local→remote sync.
        [config.srcFsPath, config.targetFsPath] = [destination, source];
        config.transferDirection = 'local ➞ remote';
        await fs.promises.mkdir(destination, { recursive: true });
      }
      await (mode.includes('sync') ? sync : transfer)(config, task => tasks.push(task));
      for (const task of tasks) await task.run();
      expect(await fs.promises.readFile(path.join(destination, 'file.txt'), 'utf8')).toBe('remote bytes');
      for (const file of [path.dirname(destination), destination, path.join(destination, 'file.txt')]) {
        // Existing dirs in both-sync were created by the test, not the download.
        if (mode === 'both-sync' && !file.endsWith('file.txt')) continue;
        box.emit('create', file);
        box.emit('change', file);
      }
      await box.flush();
      expect(upload).not.toHaveBeenCalled();
      const edit = path.join(destination, 'other.txt');
      await fs.promises.writeFile(edit, 'local');
      box.emit('create', edit);
      await box.flush();
      expect(upload.mock.calls.map(([uri]) => uri.fsPath)).toEqual([edit]);
      expect(logger.error).not.toHaveBeenCalled();
    }
  );

  test('disposal releases versions without affecting another project', async () => {
    const other = path.join(box.root, 'other-project');
    await fs.promises.mkdir(other);
    box.watch(other);
    await box.task(path.join(other, 'file')).run();
    await box.task(path.join(box.root, 'file')).run();
    watcher.dispose(box.root);
    expect(suppression._downloadSuppressionState()).toEqual({ paths: 1, watchers: 1 });
    const file = path.join(other, 'file');
    await fs.promises.writeFile(file, 'edited');
    box.emit('change', file, other);
    await box.flush();
    expect(upload.mock.calls.map(([uri]) => uri.fsPath)).toEqual([file]);
  });

  test('overlapping downloads retain only the last committed version', async () => {
    const file = path.join(box.root, 'file.txt');
    const target = Object.create(localFs);
    target.renameAtomic = async (...args) => {
      await localFs.renameAtomic(...args);
      box.emit('change', file);
      await pause(5);
    };
    await Promise.all([
      box.task(file, 'first', target).run(),
      box.task(file, 'second', target).run(),
    ]);
    box.emit('change', file);
    await box.flush();
    expect(upload).not.toHaveBeenCalled();
    expect(suppression._downloadSuppressionState().paths).toBe(1);
    await fs.promises.writeFile(file, 'local');
    box.emit('change', file);
    await box.flush();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  test('one shared sweep releases deleted paths even without delete events', async () => {
    const file = path.join(box.root, 'file.txt');
    await box.task(file).run();
    await fs.promises.unlink(file);
    const deadline = Date.now() + 3500;
    while (suppression._downloadSuppressionState().paths && Date.now() < deadline) {
      await pause(50);
    }
    expect(suppression._downloadSuppressionState().paths).toBe(0);
  });

  test('disabled watchers do not retain download state or hash files', async () => {
    watcher.dispose(box.root);
    await box.task(path.join(box.root, 'file.txt')).run();
    expect(suppression._downloadSuppressionState()).toEqual({ paths: 0, watchers: 0 });
  });

  test('ignored local edits stay ignored and a blocked upload does not block another file', async () => {
    const ignored = path.join(box.root, 'ignored');
    box.watch(box.root, false, file => file === ignored);
    const blocked = path.join(box.root, 'blocked');
    const other = path.join(box.root, 'other');
    await Promise.all([ignored, blocked, other].map(file => fs.promises.writeFile(file, 'local')));
    let finish;
    upload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    box.emit('change', ignored);
    box.emit('change', blocked);
    box.emit('change', other);
    await box.flush();
    expect(upload.mock.calls.map(([uri]) => uri.fsPath)).toEqual([blocked, other]);
    finish();
  });

  test('a watcher disposed during dispatch cannot upload its old batch', async () => {
    const file = path.join(box.root, 'file.txt');
    await fs.promises.writeFile(file, 'local');
    box.emit('change', file);
    watcher.dispose(box.root);
    await box.flush();
    expect(upload).not.toHaveBeenCalled();
  });

  test('a grouped directory event checks descendants, including genuine edits and ignores', async () => {
    const dir = path.join(box.root, 'downloaded');
    await suppression.createDownloadDirectory(dir, () => fs.promises.mkdir(dir));
    const downloaded = path.join(dir, 'remote.txt');
    const edited = path.join(dir, 'edited.txt');
    const ignored = path.join(dir, 'ignored.txt');
    box.watch(box.root, false, file => file === ignored);
    await box.task(downloaded).run();
    await box.task(edited).run();
    await fs.promises.writeFile(edited, 'local edit');
    await fs.promises.writeFile(ignored, 'ignored edit');
    box.emit('change', dir); // no individual child events at all
    await box.flush();
    expect(upload.mock.calls.map(([uri]) => uri.fsPath)).toEqual([edited]);
  });
});
