jest.mock('fs');

import { vol } from 'memfs';
import * as fs from 'fs';
import * as path from 'path';
import { sync, transfer, TransferDirection } from '../transfer';
import localFs from '../../../core/localFs';
import TransferTask from '../../../core/transferTask';
import RemoteFs from '../../../../test/helper/localRemoteFs';
import {
  clearConflictStateIsolation,
  configureConflictStateIsolation,
} from '../conflictStateIsolation';

declare global {
  interface Array<T> {
    formatSep(): Array<T>;
  }
}

Array.prototype.formatSep = function() {
  return this.map(str => str.replace(/\//g, path.sep))
}

function createRemoteFs({ remoteTimeOffsetInHours = 0 } = {}) {
  return new RemoteFs(path, {
    clientOption: {} as any,
    remoteTimeOffsetInHours,
  });
}

async function runTasks(tasks: TransferTask[]) {
  return Promise.all(
    tasks.map(async task => {
      try {
        await task.run();
      } catch (error) {
        console.log('run task fail', error);
      }
    })
  );
}

const file = (c, time = 0) => ({
  $$type: 'file',
  content: c,
  mtime: new Date(new Date().getTime() + time * 1000),
});

const fillFs = obj => {
  const files: { [x: string]: string } = {};
  const dirs: string[] = [];
  const stats: {
    [x: string]: {
      mtime: Date;
    };
  } = {};
  const processDirTree = (obj1, filepath = '/') => {
    const keys = Object.keys(obj1);
    if (keys.length <= 0) {
      dirs.push(filepath);
      return;
    }

    keys.forEach(key => {
      const fullpath = path.join(filepath, key);
      if (obj1[key].$$type === 'file') {
        files[fullpath] = obj1[key].content;
        stats[fullpath] = obj1[key];
      } else {
        processDirTree(obj1[key], fullpath);
      }
    });
  };
  processDirTree(obj);
  vol.fromJSON(files, '/');
  dirs.forEach(dir => fs.mkdirSync(dir));
  Object.keys(stats).forEach(filepath => {
    fs.utimesSync(filepath, stats[filepath].mtime, stats[filepath].mtime);
  });
};
const mapList = (list: any[], key: string) => list.map(t => t[key]);

describe('transfer algorithm', () => {
  describe.each(['ftp', 'sftp'])('%s conflict-state isolation', protocol => {
    afterEach(() => {
      clearConflictStateIsolation();
    });

    test('explicit upload and download never inspect or schedule private state', async () => {
      const workspace = path.join('/workspace', protocol);
      const stateRoot = path.join('/global', protocol, 'conflict-state-v2');
      configureConflictStateIsolation(stateRoot, [workspace]);
      const localStateFile = path.join(
        workspace,
        '.kent-tmp',
        'sftp-conflicts',
        'record',
        'conflict.json'
      );
      const globalStateFile = path.join(stateRoot, 'workspaces', 'bucket', 'conflict.json');
      const localFsMock = {
        lstat: jest.fn(),
        pathResolver: path,
      } as any;
      const remoteFsMock = {
        lstat: jest.fn(),
        ensureDir: jest.fn(),
        pathResolver: path.posix,
      } as any;
      const collect = jest.fn();

      await transfer(
        {
          srcFsPath: localStateFile,
          srcFs: localFsMock,
          targetFsPath: '/remote/conflict.json',
          targetFs: remoteFsMock,
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: { perserveTargetMode: false, ignore: null },
        },
        collect
      );
      await transfer(
        {
          srcFsPath: '/remote/conflict.json',
          srcFs: remoteFsMock,
          targetFsPath: globalStateFile,
          targetFs: localFsMock,
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
          transferOption: { perserveTargetMode: false, ignore: null },
        },
        collect
      );

      expect(localFsMock.lstat).not.toHaveBeenCalled();
      expect(remoteFsMock.lstat).not.toHaveBeenCalled();
      expect(remoteFsMock.ensureDir).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
    });
  });

  describe('sync', () => {
    afterEach(() => {
      clearConflictStateIsolation();
      vol.reset();
    });

    test('delete-enabled remote-to-local sync preserves legacy conflict state', async () => {
      fillFs({
        local: {
          '.kent-tmp': {
            'sftp-conflicts': {
              record: {
                'conflict.json': file('private state'),
              },
            },
          },
        },
        remote: {},
      });
      configureConflictStateIsolation('/global/conflict-state-v2', ['/local']);

      const tasks: TransferTask[] = [];
      const deleted = await sync(
        {
          srcFsPath: '/remote',
          srcFs: localFs,
          targetFsPath: '/local',
          targetFs: localFs,
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
          transferOption: {
            delete: true,
            perserveTargetMode: false,
          },
        },
        task => tasks.push(task)
      );

      expect(tasks).toHaveLength(0);
      expect(deleted).toHaveLength(0);
      expect(
        fs.readFileSync(
          path.join('/local', '.kent-tmp', 'sftp-conflicts', 'record', 'conflict.json'),
          'utf8'
        )
      ).toBe('private state');
    });

    test('broad folder upload schedules ordinary files but skips conflict state', async () => {
      fillFs({
        local: {
          'index.txt': file('public'),
          '.kent-tmp': {
            'sftp-conflicts': {
              record: {
                'conflict.json': file('private'),
              },
            },
          },
        },
        remote: {},
      });
      configureConflictStateIsolation('/global/conflict-state-v2', ['/local']);
      const tasks: TransferTask[] = [];

      await transfer(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFsPath: '/remote',
          targetFs: localFs,
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            perserveTargetMode: false,
            ignore: null,
          },
        },
        task => tasks.push(task)
      );

      expect(tasks.map(task => task.targetFsPath)).toEqual([
        path.join('/remote', 'index.txt'),
      ]);
      expect(fs.existsSync(path.join('/remote', '.kent-tmp', 'sftp-conflicts'))).toBe(
        false
      );
    });

    test('sync', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          $da: file('$da'),
          $db: {},
          c: {
            'c-a': file('$c-a'),
            $dc: file('$dc'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/remote/b',
          '/remote/c/c-a',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
      // Regression check: nested shared directories must keep the original sync direction.
      expect(task.every(t => t.transferType === TransferDirection.LOCAL_TO_REMOTE)).toBe(true);
    });

    test('sync --delete', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          $da: file('$da'),
          $db: {},
          c: {
            'c-a': file('$c-a'),
            $dc: file('$dc'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            delete: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(3);
      expect(mapList(deleted, 'fspath').sort()).toEqual(
        ['/remote/$da', '/remote/$db', '/remote/c/$dc'].formatSep().sort()
      );
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/remote/b',
          '/remote/c/c-a',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
    });

    test('sync --update', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          $da: file('$da'),
          $db: {},
          c: {
            'c-a': file('$c-a'),
            $dc: file('$dc'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            delete: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(3);
      expect(mapList(deleted, 'fspath').sort()).toEqual(
        ['/remote/$da', '/remote/$db', '/remote/c/$dc'].formatSep().sort()
      );
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/remote/b',
          '/remote/c/c-a',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
    });

    test.skip('sync --update with time offset', async () => {
      const remoteFs = createRemoteFs({ remoteTimeOffsetInHours: 6 });
      fillFs({
        local: {
          a: file('a', 1),
        },
        remote: {
          a: file('$a'),
        },
      });
      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      let deleted;
      const runSync = async () => {
        deleted = await sync(
          {
            srcFsPath: '/local',
            srcFs: localFs,
            targetFs: remoteFs,
            targetFsPath: '/remote',
            transferDirection: TransferDirection.LOCAL_TO_REMOTE,
            transferOption: {
              skipCreate: true,
              delete: false,
              perserveTargetMode: false,
            },
          },
          collect
        );
        await runTasks(task);
      };
      await runSync();
      expect(task.length).toEqual(1);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        ['/remote/a'].formatSep().sort()
      );
      task.length = 0;
      deleted.length = 0;
      await runSync();
      expect(task.length).toEqual(0);
      expect(deleted.length).toEqual(0);
    });

    test('sync --skipDelete', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          c: {
            'c-a': file('$c-a'),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            skipCreate: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(3);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        ['/remote/a', '/remote/c/c-a', '/remote/c/d/d-a'].formatSep().sort()
      );
    });

    test('sync --update', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a', 2),
          c: {
            'c-a': file('$c-a', 1),
            d: {
              'd-a': file('$d-a'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            update: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(4);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/b',
          '/remote/c/c-b',
          '/remote/c/d/d-a',
          '/remote/c/d/d-b',
        ].formatSep().sort()
      );
    });

    test('sync remote to local resolves an exact source mtime before update comparison', async () => {
      fillFs({
        local: {
          a: file('old', 0),
        },
        remote: {
          a: file('new', 2),
        },
      });

      const list = localFs.list.bind(localFs);
      const remoteFs = Object.create(localFs);
      remoteFs.pathResolver = path;
      remoteFs.list = jest.fn(async dir =>
        (await list(dir)).map(entry => ({
          ...entry,
          mtime: 0,
          atime: 0,
        }))
      );
      remoteFs.ensureAccurateMtime = jest.fn(async entry => {
        const stat = await localFs.lstat(entry.fspath);
        return {
          ...entry,
          mtime: stat.mtime,
          atime: stat.atime,
        };
      });

      const tasks: TransferTask[] = [];
      await sync(
        {
          srcFsPath: '/remote',
          srcFs: remoteFs,
          targetFs: localFs,
          targetFsPath: '/local',
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
          transferOption: {
            update: true,
            perserveTargetMode: false,
          },
        },
        task => tasks.push(task)
      );

      expect(remoteFs.ensureAccurateMtime).toHaveBeenCalled();
      expect(mapList(tasks, 'targetFsPath')).toEqual(['/local/a'].formatSep());
    });

    test('sync update falls back to size when an exact source mtime is unavailable', async () => {
      fillFs({
        local: {
          a: file('old', 0),
        },
        remote: {
          a: file('new content', 2),
        },
      });

      const list = localFs.list.bind(localFs);
      const remoteFs = Object.create(localFs);
      remoteFs.pathResolver = path;
      remoteFs.list = jest.fn(async dir =>
        (await list(dir)).map(entry => ({
          ...entry,
          mtime: 0,
          atime: 0,
        }))
      );
      remoteFs.ensureAccurateMtime = jest.fn(async entry => entry);

      const tasks: TransferTask[] = [];
      await sync(
        {
          srcFsPath: '/remote',
          srcFs: remoteFs,
          targetFs: localFs,
          targetFsPath: '/local',
          transferDirection: TransferDirection.REMOTE_TO_LOCAL,
          transferOption: {
            update: true,
            perserveTargetMode: false,
          },
        },
        task => tasks.push(task)
      );

      expect(mapList(tasks, 'targetFsPath')).toEqual(['/local/a'].formatSep());
    });

    test('sync both direction"', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            'c-c': file('c-c', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          b: file('$b', 2),
          c: {
            'c-a': file('$c-a'),
            'c-b': file('$c-b', 2),
            d: {
              'd-a': file('$d-a'),
              'd-b': file('$d-b', 2),
              'd-c': file('$d-c'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            bothDiretions: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(8);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/local/b',
          '/remote/c/c-a',
          '/local/c/c-b',
          '/remote/c/c-c',
          '/remote/c/d/d-a',
          '/local/c/d/d-b',
          '/local/c/d/d-c',
        ].formatSep().sort()
      );
    });

    test('sync both direction --skipCreate"', async () => {
      fillFs({
        local: {
          a: file('a', 1),
          b: file('b', 1),
          c: {
            'c-a': file('c-a', 1),
            'c-b': file('c-b', 1),
            'c-c': file('c-c', 1),
            d: {
              'd-a': file('d-a', 1),
              'd-b': file('d-b', 1),
            },
          },
        },
        remote: {
          a: file('$a'),
          b: file('$b', 2),
          c: {
            'c-a': file('$c-a'),
            'c-b': file('$c-b', 2),
            d: {
              'd-a': file('$d-a'),
              'd-b': file('$d-b', 2),
              'd-c': file('$d-c'),
            },
          },
        },
      });

      const task: TransferTask[] = [];
      const collect = (a: TransferTask) => task.push(a);
      const deleted = await sync(
        {
          srcFsPath: '/local',
          srcFs: localFs,
          targetFs: localFs,
          targetFsPath: '/remote',
          transferDirection: TransferDirection.LOCAL_TO_REMOTE,
          transferOption: {
            skipCreate: true,
            bothDiretions: true,
            perserveTargetMode: false,
          },
        },
        collect
      );
      expect(task.length).toEqual(6);
      expect(deleted.length).toEqual(0);
      expect(mapList(task, 'targetFsPath').sort()).toEqual(
        [
          '/remote/a',
          '/local/b',
          '/remote/c/c-a',
          '/local/c/c-b',
          '/remote/c/d/d-a',
          '/local/c/d/d-b',
        ].formatSep().sort()
      );
    });
  });
});
