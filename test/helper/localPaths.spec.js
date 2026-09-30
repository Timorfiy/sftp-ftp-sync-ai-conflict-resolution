const fs = require('fs');
const os = require('os');
const path = require('path');
const { LocalPathPolicies, detectCaseSensitivity } = require('../../src/helper/localPaths');
const { requireSafeLocalPath } = require('../../src/helper/safeLocalPath');

function macProbe(sensitive, mount = false) {
  const stat = jest.fn(file => {
    if (file === '/Volume/Project/File' || (!sensitive && file === '/Volume/Project/file')) return { dev: 2, ino: 3 };
    if (file === '/Volume/Project') return { dev: 2, ino: 2 };
    if (file === '/Volume') return { dev: mount ? 1 : 2, ino: 1 };
    if (file === '/Volume/project' && !sensitive && !mount) return { dev: 2, ino: 2 };
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  return { stat, names: jest.fn(dir => dir === '/Volume/Project' ? ['File'] : ['Project']) };
}

describe('local path policies', () => {
  test('Windows drive/UNC paths are case-insensitive and respect boundaries', () => {
    const policy = new LocalPathPolicies('win32', path.win32);
    expect(policy.contains('C:\\Work\\', 'c:/WORK/file')).toBe(true);
    expect(policy.contains('C:\\Work', 'C:\\Workshop\\file')).toBe(false);
    expect(policy.contains('C:\\', 'C:\\Work')).toBe(true);
    expect(policy.contains('C:\\', 'D:\\Work')).toBe(false);
    expect(policy.contains('\\\\server\\share\\', '\\\\SERVER\\SHARE\\file')).toBe(true);
  });

  test('POSIX roots, case, dot components and .. prefixed child names', () => {
    const policy = new LocalPathPolicies('linux', path.posix);
    expect(policy.contains('/', '/project/file')).toBe(true);
    expect(policy.contains('/Project/', '/Project/a/../..notes')).toBe(true);
    expect(policy.contains('/Project', '/project/file')).toBe(false);
    expect(policy.contains('/Project', '/Project-other/file')).toBe(false);
    expect(policy.contains('/Project', '/Project/../outside')).toBe(false);
    expect(policy.key('/Проект с пробелами/"file"')).toBe('/Проект с пробелами/"file"');
    expect(policy.key('/Project/back\\slash')).toBe('/Project/back\\slash');
  });

  test.each([true, false])('macOS reads existing entries: sensitive=%s', sensitive => {
    const probe = macProbe(sensitive);
    const policy = new LocalPathPolicies('darwin', path.posix, probe);
    const release = policy.register('/Volume/Project');
    const calls = probe.stat.mock.calls.length;
    expect(policy.contains('/Volume/Project', '/Volume/project/file')).toBe(!sensitive);
    expect(policy.key('/Volume/Project/File') === policy.key('/Volume/Project/file')).toBe(!sensitive);
    expect(probe.stat).toHaveBeenCalledTimes(calls);
    release();
  });

  test('empty mount root never borrows the containing filesystem policy', () => {
    const probe = { stat: jest.fn(file => ({ dev: file === '/Volumes' ? 1 : 2, ino: 5 })), names: jest.fn(() => []) };
    expect(detectCaseSensitivity('/Volumes/Empty', 'darwin', path.posix, probe)).toBe(true);
  });

  test('unreadable roots and names without case stay strict', () => {
    expect(detectCaseSensitivity('/123', 'darwin', path.posix, { stat: () => { throw new Error('denied'); }, names: () => [] })).toBe(true);
    expect(detectCaseSensitivity('/123', 'darwin', path.posix, { stat: () => ({ dev: 1, ino: 2 }), names: () => ['123'] })).toBe(true);
  });

  test('two differently cased directory entries stay distinct even when hard linked', () => {
    const probe = macProbe(false);
    probe.names.mockReturnValue(['File', 'file']);
    expect(detectCaseSensitivity('/Volume/Project', 'darwin', path.posix, probe)).toBe(true);
  });

  test('nested volumes use their own policy and reference counting releases caches', () => {
    const probe = macProbe(false);
    const policy = new LocalPathPolicies('darwin', path.posix, probe);
    const release1 = policy.register('/Volume/Project');
    const release2 = policy.register('/Volume/Project');
    probe.stat.mockImplementation(file => {
      if (file === '/Volume/Project/Mount') return { dev: 9, ino: 10 };
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    probe.names.mockReturnValue([]);
    const releaseNested = policy.register('/Volume/Project/Mount');
    expect(policy.key('/Volume/Project/Mount/Case')).toBe('/Volume/Project/Mount/Case');
    expect(policy.key('/Volume/Project/File')).toBe('/volume/project/file');
    releaseNested(); release1(); release1();
    expect(policy.key('/Volume/Project/File')).toBe('/volume/project/file');
    release2();
    expect(policy.key('/Volume/Project/File')).toBe('/Volume/Project/File');
  });
});

describe('native filesystem path guards', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-path-policy-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('existing files, missing leaves and symlinks keep their safety boundaries', async () => {
    const file = path.join(root, 'Файл с пробелами.txt');
    fs.writeFileSync(file, 'safe');
    await expect(requireSafeLocalPath(root, file, { type: 'file' })).resolves.toBeDefined();
    await expect(requireSafeLocalPath(root, path.join(root, 'missing'), { allowMissingLeaf: true })).resolves.toBeUndefined();
    await expect(requireSafeLocalPath(root, `${root}-sibling`)).rejects.toMatchObject({ reason: 'outside_root' });
    const link = path.join(root, 'link');
    fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(requireSafeLocalPath(root, path.join(link, path.basename(file)))).rejects.toMatchObject({ reason: 'symbolic_component' });
  });

  test('native macOS detection agrees with the volume hosting the fixtures', () => {
    if (process.platform !== 'darwin') return;
    const original = path.join(root, 'NativeCase');
    fs.writeFileSync(original, 'case');
    const sensitive = !fs.existsSync(path.join(root, 'nativeCase'));
    expect(detectCaseSensitivity(root)).toBe(sensitive);
    const policy = new LocalPathPolicies();
    const release = policy.register(root);
    expect(policy.key(original) === policy.key(path.join(root, 'nativeCase'))).toBe(!sensitive);
    release();
  });
});
