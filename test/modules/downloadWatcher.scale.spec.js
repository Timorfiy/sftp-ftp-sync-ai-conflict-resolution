const fs = require('fs');
const path = require('path');
const {
  sandbox, reset, upload, removeRemote, suppression, localFs, pause, watcher, logger,
} = require('../fixtures/downloadWatcherHarness');

const COUNT = 10_000;
jest.setTimeout(240_000);

describe.each(['simulated events', 'native fs.watch'])('10,000 files: %s', mode => {
  let box;
  const native = mode === 'native fs.watch';
  beforeEach(async () => { reset(); box = await sandbox(); box.watch(box.root, native); });
  afterEach(async () => { await box.close(); });

  test.each([false, true])('download, parallel local edit, cancel halfway=%s, cleanup', async cancel => {
    const started = Date.now();
    const otherRoot = path.join(box.root, 'other-project');
    await fs.promises.mkdir(otherRoot);
    box.watch(otherRoot, native);
    // Avoid observing the setup itself; the second watcher is still genuinely
    // concurrent, and the root watcher intentionally overlaps it.
    await pause(native ? 150 : 0);
    await box.flush();
    upload.mockClear();
    removeRemote.mockClear();
    const other = path.join(otherRoot, 'local-edit.txt');
    const targetFs = Object.create(localFs);
    if (!native) {
      targetFs.open = async (name, ...args) => {
        const fd = await localFs.open(name, ...args);
        box.emit('create', name);
        return fd;
      };
      targetFs.renameAtomic = async (stage, target) => {
        await localFs.renameAtomic(stage, target);
        box.emit('delete', stage);
        box.emit('create', target);
        box.emit('change', target);
      };
    }
    // Real staging/rename and real bytes, 16 transfers at a time. No network.
    const tasks = Array.from({ length: COUNT }, (_, index) =>
      box.task(path.join(box.root, `file-${index}.txt`), `remote bytes ${index}`, targetFs)
    );
    let sawParallelEdit = false;
    for (let offset = 0; offset < COUNT; offset += 16) {
      if (offset >= 4992 && !sawParallelEdit) {
        await fs.promises.writeFile(other, 'independent local edit');
        if (!native) box.emit('change', other, otherRoot);
        if (native) await pause(100);
        await box.flush();
        expect(upload.mock.calls.some(([uri]) => uri.fsPath === other)).toBe(true);
        sawParallelEdit = true;
      }
      if (cancel && offset >= 5000) tasks.slice(offset).forEach(task => task.cancel());
      await Promise.all(tasks.slice(offset, offset + 16).map(task => task.run()));
    }
    const completed = cancel ? 5008 : COUNT;
    if (native) await pause(1000); // allow actual OS delivery before explicit drain
    else {
      // Replay the whole batch after task completion, with fresh Uri objects.
      for (let index = 0; index < completed; index++) {
        const file = path.join(box.root, `file-${index}.txt`);
        box.emit('change', file);
        box.emit('change', file);
      }
    }
    await box.flush();
    const reverseUploads = upload.mock.calls.filter(([uri]) => uri.fsPath !== other);
    expect(reverseUploads).toEqual([]);
    expect(removeRemote).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(box.nativeErrors).toEqual([]);
    expect(suppression._downloadSuppressionState().paths).toBe(completed);
    const files = await fs.promises.readdir(box.root);
    expect(files.filter(file => file.endsWith('.tmp'))).toEqual([]);
    expect(files.filter(file => file.startsWith('file-'))).toHaveLength(completed);
    const observedFiles = [...box.observed].filter(file => /file-\d+\.txt$/.test(file)).length;
    if (native) expect(observedFiles).toBe(completed); // zero uploads alone is not proof of delivery

    const edited = path.join(box.root, 'file-0.txt');
    await fs.promises.writeFile(edited, 'real local change after sync');
    if (native) await pause(650);
    else box.emit('change', edited);
    await box.flush();
    expect(upload.mock.calls.some(([uri]) => uri.fsPath === edited)).toBe(true);
    expect(suppression._downloadSuppressionState().paths).toBe(completed - 1);
    watcher.dispose(box.root);
    watcher.dispose(otherRoot);
    expect(suppression._downloadSuppressionState()).toEqual({ paths: 0, watchers: 0 });
    console.log(JSON.stringify({
      mode, scheduled: COUNT, completed, cancelled: COUNT - completed,
      reverseUploads: reverseUploads.length, observedFiles: native ? observedFiles : null,
      parallelEdit: sawParallelEdit, cleanupPaths: 0, elapsedMs: Date.now() - started,
    }));
  });
});
