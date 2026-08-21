jest.mock('fs');

const { vol } = require('memfs');
const path = require('path');
const {
  getBackupFolder,
  getBackupDirForTarget,
  getBackupPath,
  parseBackupPath,
  classifyBackupPath,
  isBinaryContentSample,
  createBackup,
  pruneBackups,
} = require('../../src/core/backup');
const LocalRemoteFileSystem = require('../../test/helper/localRemoteFs').default;
const localfs = require('../../src/core/localFs').default;

function createRemoteFs() {
  return new LocalRemoteFileSystem(path, {
    clientOption: {},
    remoteTimeOffsetInHours: 0,
  });
}

describe('backup path utilities', () => {
  test('getBackupFolder joins remote path and backup folder', () => {
    expect(getBackupFolder('/var/www', '.vscode/sftp-backup')).toBe('/var/www/.vscode/sftp-backup');
  });

  test('getBackupDirForTarget preserves relative directory structure', () => {
    expect(getBackupDirForTarget('/var/www/css/main.css', '.vscode/sftp-backup', '/var/www')).toBe(
      '/var/www/.vscode/sftp-backup/css'
    );
    expect(getBackupDirForTarget('/var/www/index.php', '.vscode/sftp-backup', '/var/www')).toBe(
      '/var/www/.vscode/sftp-backup'
    );
  });

  test('getBackupPath generates timestamped backup path', () => {
    const date = new Date(Date.UTC(2026, 5, 12, 19, 42, 2, 123));
    const path = getBackupPath('/var/www/index.php', '.vscode/sftp-backup', '/var/www', date);
    expect(path).toBe('/var/www/.vscode/sftp-backup/index.php.20260612194202123.bak');
  });

  test('parseBackupPath reconstructs original path and timestamp', () => {
    const backupPath = '/var/www/.vscode/sftp-backup/css/main.css.20260612194202123.bak';
    const info = parseBackupPath(backupPath, '.vscode/sftp-backup', '/var/www');
    expect(info).not.toBeNull();
    expect(info.originalPath).toBe('/var/www/css/main.css');
    expect(info.timestamp.toISOString()).toBe('2026-06-12T19:42:02.123Z');
    expect(info.priority).toBe('normal');
  });

  test('parseBackupPath recognizes conflict-priority backups', () => {
    const backupPath = '/var/www/.vscode/sftp-backup/css/main.css.20260612194202123.conflict.bak';
    const info = parseBackupPath(backupPath, '.vscode/sftp-backup', '/var/www');
    expect(info).not.toBeNull();
    expect(info.originalPath).toBe('/var/www/css/main.css');
    expect(info.priority).toBe('conflict');
  });

  test('parseBackupPath returns null for non-backup paths', () => {
    expect(parseBackupPath('/var/www/index.php', '.vscode/sftp-backup', '/var/www')).toBeNull();
    expect(parseBackupPath('/var/www/.vscode/sftp-backup/index.php', '.vscode/sftp-backup', '/var/www')).toBeNull();
  });

  test('getBackupPath uses local storage root and path resolver', () => {
    const date = new Date(Date.UTC(2026, 5, 12, 19, 42, 2, 123));
    const backupRoot = path.join('/workspace', '.vscode/sftp-backup');
    const backupPath = getBackupPath('/var/www/index.php', '.vscode/sftp-backup', '/var/www', date, backupRoot, path);
    expect(backupPath).toBe(path.join('/workspace', '.vscode/sftp-backup', 'index.php.20260612194202123.bak'));
  });

  test('getBackupPath preserves remote directory layout under local storage root', () => {
    const date = new Date(Date.UTC(2026, 5, 12, 19, 42, 2, 123));
    const backupRoot = path.join('/workspace', '.vscode/sftp-backup');
    const backupPath = getBackupPath('/var/www/css/main.css', '.vscode/sftp-backup', '/var/www', date, backupRoot, path);
    expect(backupPath).toBe(path.join('/workspace', '.vscode/sftp-backup', 'css', 'main.css.20260612194202123.bak'));
  });

  test('parseBackupPath reconstructs original path from local backup path', () => {
    const backupRoot = path.join('/workspace', '.vscode/sftp-backup');
    const backupPath = path.join('/workspace', '.vscode/sftp-backup', 'css', 'main.css.20260612194202123.bak');
    const info = parseBackupPath(backupPath, '.vscode/sftp-backup', '/var/www', backupRoot, path);
    expect(info).not.toBeNull();
    expect(info.originalPath).toBe('/var/www/css/main.css');
    expect(info.timestamp.toISOString()).toBe('2026-06-12T19:42:02.123Z');
  });
});

describe('backup file classification', () => {
  test.each([
    '/var/www/index.php',
    '/var/www/site.css',
    '/var/www/app.js',
    '/var/www/app.ts',
    '/var/www/data.json',
    '/var/www/page.html',
    '/var/www/data.xml',
    '/var/www/icon.svg',
    '/var/www/.env.local',
    '/var/www/.htaccess',
  ])('classifies %s as text', targetPath => {
    expect(classifyBackupPath(targetPath)).toBe('text');
  });

  test.each([
    '/var/www/image.png',
    '/var/www/image.jpg',
    '/var/www/image.webp',
    '/var/www/video.mp4',
    '/var/www/audio.mp3',
    '/var/www/font.woff2',
    '/var/www/document.pdf',
    '/var/www/archive.zip',
  ])('classifies %s as binary', targetPath => {
    expect(classifyBackupPath(targetPath)).toBe('binary');
  });

  test('detects binary content for an unknown extension', () => {
    expect(isBinaryContentSample(Buffer.from([0x41, 0x00, 0x42, 0x01]))).toBe(true);
    expect(isBinaryContentSample(Buffer.from('plain text\nwith unicode: Привет'))).toBe(false);
  });
});

describe('backup lifecycle', () => {
  afterEach(() => {
    vol.reset();
  });

  test('createBackup copies remote file to backup folder', async () => {
    vol.fromJSON({ '/var/www/index.php': 'original content' }, '/');
    const fs = createRemoteFs();

    const backupPath = await createBackup('/var/www/index.php', fs, {
      enabled: true,
      folder: '.vscode/sftp-backup',
      versions: 5,
    }, '/var/www');

    expect(backupPath).not.toBeNull();
    expect(backupPath.startsWith('/var/www/.vscode/sftp-backup/index.php.')).toBe(true);
    expect(backupPath.endsWith('.bak')).toBe(true);
    expect(vol.existsSync(backupPath)).toBe(true);
    expect(vol.readFileSync(backupPath, 'utf8')).toBe('original content');
  });

  test.each([
    ['index.php', '<? echo "ok";'],
    ['styles.css', '.button { color: red; }'],
    ['icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'],
  ])('createBackup stores text file %s', async (filename, content) => {
    const targetPath = `/var/www/${filename}`;
    vol.fromJSON({ [targetPath]: content }, '/');
    const fs = createRemoteFs();

    const backupPath = await createBackup(targetPath, fs, {
      enabled: true,
      folder: '.vscode/sftp-backup',
      versions: 100,
    }, '/var/www');

    expect(backupPath).not.toBeNull();
    expect(vol.readFileSync(backupPath, 'utf8')).toBe(content);
  });

  test.each(['image.png', 'image.jpg', 'image.webp', 'video.mp4', 'font.woff2', 'file.pdf']) (
    'createBackup skips known binary file %s',
    async filename => {
      const targetPath = `/var/www/${filename}`;
      vol.fromJSON({ [targetPath]: Buffer.from([0x00, 0x01, 0x02, 0x03]) }, '/');
      const fs = createRemoteFs();

      const backupPath = await createBackup(targetPath, fs, {
        enabled: true,
        folder: '.vscode/sftp-backup',
        versions: 100,
      }, '/var/www');

      expect(backupPath).toBeNull();
      expect(vol.existsSync('/var/www/.vscode/sftp-backup')).toBe(false);
    }
  );

  test('createBackup sniffs unknown extensions and skips binary content', async () => {
    vol.fromJSON({ '/var/www/payload.asset': Buffer.from([0x41, 0x00, 0x42, 0x01]) }, '/');
    const fs = createRemoteFs();

    const backupPath = await createBackup('/var/www/payload.asset', fs, {
      enabled: true,
      folder: '.vscode/sftp-backup',
      versions: 100,
    }, '/var/www');

    expect(backupPath).toBeNull();
  });

  test('createBackup stores unknown extensions when sampled content is text', async () => {
    vol.fromJSON({ '/var/www/template.custom': 'custom text template' }, '/');
    const fs = createRemoteFs();

    const backupPath = await createBackup('/var/www/template.custom', fs, {
      enabled: true,
      folder: '.vscode/sftp-backup',
      versions: 100,
    }, '/var/www');

    expect(backupPath).not.toBeNull();
    expect(vol.readFileSync(backupPath, 'utf8')).toBe('custom text template');
  });

  test('createBackup keeps only the configured number of versions', async () => {
    vol.fromJSON({ '/var/www/index.php': 'v1' }, '/');
    const fs = createRemoteFs();
    const backupConfig = {
      enabled: true,
      folder: '.vscode/sftp-backup',
      versions: 3,
    };

    for (let i = 0; i < 5; i++) {
      vol.writeFileSync('/var/www/index.php', `v${i + 1}`);
      await createBackup('/var/www/index.php', fs, backupConfig, '/var/www');
    }

    const remaining = vol.toJSON('/var/www/.vscode/sftp-backup');
    const backupFiles = Object.keys(remaining).filter(p => p.endsWith('.bak'));
    expect(backupFiles.length).toBe(3);

    // Small limits still preserve the historical anchor, then newest versions.
    expect(Object.values(remaining)).toEqual(expect.arrayContaining(['v1', 'v4', 'v5']));
    expect(Object.values(remaining)).not.toContain('v3');
  });

  test('createBackup copies remote file to local backup folder', async () => {
    vol.fromJSON({ '/var/www/index.php': 'original content' }, '/');
    const remoteFs = createRemoteFs();
    const storage = {
      fs: localfs,
      root: path.join('/workspace', '.vscode/sftp-backup'),
      pathResolver: path,
    };

    const backupPath = await createBackup('/var/www/index.php', remoteFs, {
      enabled: true,
      location: 'local',
      folder: '.vscode/sftp-backup',
      versions: 5,
    }, '/var/www', storage);

    expect(backupPath).not.toBeNull();
    expect(backupPath.startsWith(path.join('/workspace', '.vscode/sftp-backup', 'index.php.'))).toBe(true);
    expect(backupPath.endsWith('.bak')).toBe(true);
    expect(vol.existsSync(backupPath)).toBe(true);
    expect(vol.readFileSync(backupPath, 'utf8')).toBe('original content');
  });

  test('createBackup keeps only the configured number of local versions', async () => {
    vol.fromJSON({ '/var/www/index.php': 'v1' }, '/');
    const remoteFs = createRemoteFs();
    const storage = {
      fs: localfs,
      root: path.join('/workspace', '.vscode/sftp-backup'),
      pathResolver: path,
    };
    const backupConfig = {
      enabled: true,
      location: 'local',
      folder: '.vscode/sftp-backup',
      versions: 3,
    };

    for (let i = 0; i < 5; i++) {
      vol.writeFileSync('/var/www/index.php', `v${i + 1}`);
      await createBackup('/var/www/index.php', remoteFs, backupConfig, '/var/www', storage);
    }

    const remaining = vol.toJSON(path.join('/workspace', '.vscode/sftp-backup'));
    const backupFiles = Object.keys(remaining).filter(p => p.endsWith('.bak'));
    expect(backupFiles.length).toBe(3);

    expect(Object.values(remaining)).toEqual(expect.arrayContaining(['v1', 'v4', 'v5']));
    expect(Object.values(remaining)).not.toContain('v3');
  });

  test('pruneBackups deletes local files beyond the version limit', async () => {
    vol.fromJSON({
      [path.join('/workspace', '.vscode/sftp-backup', 'index.php.20260601000000.bak')]: 'old1',
      [path.join('/workspace', '.vscode/sftp-backup', 'index.php.20260602000000.bak')]: 'old2',
      [path.join('/workspace', '.vscode/sftp-backup', 'index.php.20260603000000.bak')]: 'old3',
      [path.join('/workspace', '.vscode/sftp-backup', 'index.php.20260604000000.bak')]: 'recent1',
      [path.join('/workspace', '.vscode/sftp-backup', 'index.php.20260605000000.bak')]: 'recent2',
    }, '/');
    const remoteFs = createRemoteFs();
    const storage = {
      fs: localfs,
      root: path.join('/workspace', '.vscode/sftp-backup'),
      pathResolver: path,
    };

    await pruneBackups('/var/www/index.php', remoteFs, {
      enabled: true,
      location: 'local',
      folder: '.vscode/sftp-backup',
      versions: 2,
    }, '/var/www', storage);

    const remaining = vol.toJSON(path.join('/workspace', '.vscode/sftp-backup'));
    const backupFiles = Object.keys(remaining).filter(p => p.endsWith('.bak'));
    expect(backupFiles.length).toBe(2);
    expect(vol.existsSync(path.join('/workspace', '.vscode/sftp-backup', 'index.php.20260601000000.bak'))).toBe(true);
    expect(vol.existsSync(path.join('/workspace', '.vscode/sftp-backup', 'index.php.20260604000000.bak'))).toBe(false);
    expect(vol.existsSync(path.join('/workspace', '.vscode/sftp-backup', 'index.php.20260605000000.bak'))).toBe(true);
    expect(vol.existsSync(path.join('/workspace', '.vscode/sftp-backup', 'index.php.20260603000000.bak'))).toBe(false);
  });

  test('pruneBackups keeps oldest anchor, latest 50, newest conflict backups, and limit 100', async () => {
    const backupRoot = path.join('/workspace', '.vscode/sftp-backup');
    const files = {};
    const allPaths = [];
    const conflictIndexes = new Set([10, 20, 30, 40, 50, 60]);
    const conflictPaths = new Map();

    for (let index = 0; index < 120; index++) {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index));
      const priority = conflictIndexes.has(index) ? 'conflict' : 'normal';
      const backupPath = getBackupPath(
        '/var/www/index.php',
        '.vscode/sftp-backup',
        '/var/www',
        timestamp,
        backupRoot,
        path,
        priority
      );
      files[backupPath] = `backup ${index}`;
      allPaths.push(backupPath);
      if (priority === 'conflict') {
        conflictPaths.set(index, backupPath);
      }
    }
    vol.fromJSON(files, '/');

    const remoteFs = createRemoteFs();
    const storage = {
      fs: localfs,
      root: backupRoot,
      pathResolver: path,
    };
    await pruneBackups('/var/www/index.php', remoteFs, {
      enabled: true,
      location: 'local',
      folder: '.vscode/sftp-backup',
      versions: 100,
    }, '/var/www', storage);

    const remaining = Object.keys(vol.toJSON(backupRoot)).filter(p => p.endsWith('.bak'));
    expect(remaining).toHaveLength(100);
    expect(vol.existsSync(allPaths[0])).toBe(true);
    allPaths.slice(-50).forEach(backupPath => expect(vol.existsSync(backupPath)).toBe(true));
    [20, 30, 40, 50, 60].forEach(index =>
      expect(vol.existsSync(conflictPaths.get(index))).toBe(true)
    );
  });
});

describe('backupBeforeDelete', () => {
  const { backupBeforeDelete } = require('../../src/core/backup');

  const baseConfig = {
    enabled: true,
    folder: '.vscode/sftp-backup',
    versions: 5,
    onDelete: true,
  };

  function backupFiles(root) {
    return Object.keys(vol.toJSON(root) || {}).filter(p => p.endsWith('.bak'));
  }

  // FileSystem methods are defined as non-writable prototype properties, so an
  // override has to be installed with defineProperty rather than assignment.
  function withFailingGet(fs, shouldFail) {
    const wrapper = Object.create(fs);
    Object.defineProperty(wrapper, 'get', {
      configurable: true,
      writable: true,
      value: (p, option) =>
        shouldFail(p) ? Promise.reject(new Error('read failed')) : fs.get(p, option),
    });
    return wrapper;
  }

  afterEach(() => {
    vol.reset();
  });

  test('is a no-op unless onDelete is on', async () => {
    vol.fromJSON({ '/var/www/index.php': 'content' }, '/');
    const fs = createRemoteFs();

    const count = await backupBeforeDelete(
      '/var/www/index.php',
      fs,
      { ...baseConfig, onDelete: false },
      '/var/www'
    );

    expect(count).toBe(0);
    expect(vol.existsSync('/var/www/.vscode/sftp-backup')).toBe(false);
  });

  test('is a no-op when backups are disabled entirely', async () => {
    vol.fromJSON({ '/var/www/index.php': 'content' }, '/');
    const fs = createRemoteFs();

    const count = await backupBeforeDelete(
      '/var/www/index.php',
      fs,
      { ...baseConfig, enabled: false },
      '/var/www'
    );

    expect(count).toBe(0);
  });

  test('backs up a single file', async () => {
    vol.fromJSON({ '/var/www/index.php': 'content' }, '/');
    const fs = createRemoteFs();

    const count = await backupBeforeDelete('/var/www/index.php', fs, baseConfig, '/var/www');

    expect(count).toBe(1);
    const backups = backupFiles('/var/www/.vscode/sftp-backup');
    expect(backups.length).toBe(1);
    expect(vol.readFileSync(backups[0], 'utf8')).toBe('content');
  });

  test('backs up every file in a folder, preserving layout', async () => {
    vol.fromJSON(
      {
        '/var/www/site/index.php': 'index',
        '/var/www/site/css/main.css': 'css',
        '/var/www/site/js/deep/app.js': 'js',
        '/var/www/untouched.txt': 'keep',
      },
      '/'
    );
    const fs = createRemoteFs();

    const count = await backupBeforeDelete('/var/www/site', fs, baseConfig, '/var/www');

    expect(count).toBe(3);

    const backupRoot = '/var/www/.vscode/sftp-backup';
    const backups = backupFiles(backupRoot);
    expect(backups.length).toBe(3);

    // Relative directory layout is preserved under the backup root.
    expect(backups.some(p => p.startsWith(`${backupRoot}/site/index.php.`))).toBe(true);
    expect(backups.some(p => p.startsWith(`${backupRoot}/site/css/main.css.`))).toBe(true);
    expect(backups.some(p => p.startsWith(`${backupRoot}/site/js/deep/app.js.`))).toBe(true);

    // Files outside the delete target are not touched.
    expect(backups.some(p => p.includes('untouched'))).toBe(false);
  });

  test('does not descend into the remote backup folder itself', async () => {
    vol.fromJSON(
      {
        '/var/www/index.php': 'index',
        '/var/www/.vscode/sftp-backup/index.php.20260603000000.bak': 'old backup',
      },
      '/'
    );
    const fs = createRemoteFs();

    const count = await backupBeforeDelete('/var/www', fs, baseConfig, '/var/www');

    // Only index.php, never the pre-existing .bak.
    expect(count).toBe(1);
  });

  test('skips symlinks rather than copying what they point at', async () => {
    vol.fromJSON({ '/var/www/real.txt': 'real' }, '/');
    vol.symlinkSync('/var/www/real.txt', '/var/www/link.txt');
    const fs = createRemoteFs();

    const count = await backupBeforeDelete('/var/www/link.txt', fs, baseConfig, '/var/www');

    expect(count).toBe(0);
  });

  test('throws instead of returning when a backup cannot be made', async () => {
    vol.fromJSON(
      {
        '/var/www/site/a.txt': 'a',
        '/var/www/site/b.txt': 'b',
      },
      '/'
    );
    const fs = createRemoteFs();

    // Delegate to the real fs, but fail reading one of the two files.
    // The fs methods are non-writable prototype properties, so plain
    // assignment on a derived object silently does nothing.
    const flaky = withFailingGet(fs, p => p.endsWith('b.txt'));

    await expect(
      backupBeforeDelete('/var/www/site', flaky, baseConfig, '/var/www')
    ).rejects.toThrow(/could not back up/);
  });

  test('a failed backup leaves the delete to the caller, which never runs', async () => {
    // Guards the contract removeRemote relies on: backupBeforeDelete throws
    // before any removal happens, so nothing is deleted on a partial backup.
    vol.fromJSON({ '/var/www/site/a.txt': 'a' }, '/');
    const fs = createRemoteFs();

    const flaky = withFailingGet(fs, () => true);

    await expect(
      backupBeforeDelete('/var/www/site', flaky, baseConfig, '/var/www')
    ).rejects.toThrow();

    expect(vol.existsSync('/var/www/site/a.txt')).toBe(true);
  });
});
