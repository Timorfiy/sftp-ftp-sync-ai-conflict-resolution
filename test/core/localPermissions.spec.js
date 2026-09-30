const fs = require('fs');
const fse = require('fs-extra');
const path = require('path');
const { Readable } = require('stream');
const { sandbox, reset, localFs } = require('../fixtures/downloadWatcherHarness');

describe('staged local download permissions', () => {
  let box;
  beforeEach(async () => { reset(); box = await sandbox(); });
  afterEach(async () => { jest.restoreAllMocks(); await box.close(); });

  test('missing destination uses fallback without closing an invalid handle', async () => {
    const file = path.join(box.root, 'new-script');
    await box.task(file, 'new bytes', localFs, { perserveTargetMode: true, fallbackMode: 0o750 }).run();
    expect(fs.readFileSync(file, 'utf8')).toBe('new bytes');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o750);
  });

  const posixTest = process.platform === 'win32' ? test.skip : test;
  posixTest.each([
    ['preserved', { perserveTargetMode: true, fallbackMode: 0o644 }, 0o755],
    ['explicit', { perserveTargetMode: true, filePerm: 640, fallbackMode: 0o755 }, 0o640],
    ['transfer mode', { mode: 0o700, fallbackMode: 0o644 }, 0o700],
    ['zero mode', { mode: 0 }, 0],
  ])('%s applies mode to the existing staging descriptor', async (_label, options, expected) => {
    const file = path.join(box.root, 'existing-script');
    fs.writeFileSync(file, 'previous');
    fs.chmodSync(file, 0o755);
    await box.task(file, 'replacement', localFs, options).run();
    expect(fs.statSync(file).mode & 0o777).toBe(expected);
    fs.chmodSync(file, 0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
  });

  posixTest('chmod failure preserves destination and cleans up the staged file', async () => {
    const file = path.join(box.root, 'existing-script');
    fs.writeFileSync(file, 'previous'); fs.chmodSync(file, 0o755);
    jest.spyOn(fse, 'fchmod').mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    await expect(box.task(file, 'replacement', localFs, { mode: 0o644 }).run()).rejects.toBeDefined();
    expect(fs.readFileSync(file, 'utf8')).toBe('previous');
    expect(fs.statSync(file).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(box.root)).toEqual(['existing-script']);
  });

  posixTest('source errors during chmod are caught before the writer starts', async () => {
    const file = path.join(box.root, 'staged');
    const fd = await localFs.open(file, 'w');
    const source = new Readable({ read() {} });
    const error = new Error('source closed');
    jest.spyOn(fse, 'fchmod').mockImplementation(async () => { source.emit('error', error); });
    try {
      await expect(localFs.put(source, file, { fd, mode: 0o755, autoClose: false })).rejects.toBe(error);
      expect(source.destroyed).toBe(true);
    } finally { await localFs.close(fd); }
  });

  test('Windows keeps mode handling unchanged', async () => {
    if (process.platform !== 'win32') return;
    const chmod = jest.spyOn(fse, 'fchmod');
    const file = path.join(box.root, 'file');
    await box.task(file, 'bytes', localFs, { mode: 0o755 }).run();
    expect(chmod).not.toHaveBeenCalled();
  });
});
