import * as path from 'path';
import { FileType as BasicFileType } from 'basic-ftp';
import FTPFileSystem from '../ftpFileSystem';

describe('FTPFileSystem modification times', () => {
  test('uses MDTM when LIST does not provide modifiedAt', async () => {
    const modifiedAt = new Date('2026-08-21T08:14:08.000Z');
    const ftp = {
      list: jest.fn(async () => [
        {
          name: 'modals.css',
          type: BasicFileType.File,
          size: 52153,
          rawModifiedAt: 'Aug 21 08:14',
        },
      ]),
      lastMod: jest.fn(async () => modifiedAt),
    };
    const remoteClient = {
      getFsClient: () => ftp,
    };
    const fileSystem = new FTPFileSystem(path.posix, {
      client: remoteClient as any,
      remoteTimeOffsetInHours: 0,
    });

    const stat = await fileSystem.lstat('/assets/css/modals.css');

    expect(ftp.lastMod).toHaveBeenCalledWith('/assets/css/modals.css');
    expect(stat.mtime).toBe(modifiedAt.getTime());
    expect(stat.size).toBe(52153);
  });

  test('does not issue MDTM when LIST already has an exact timestamp', async () => {
    const modifiedAt = new Date('2026-08-21T08:14:08.000Z');
    const ftp = {
      list: jest.fn(async () => [
        {
          name: 'modals.css',
          type: BasicFileType.File,
          size: 52153,
          modifiedAt,
        },
      ]),
      lastMod: jest.fn(),
    };
    const remoteClient = {
      getFsClient: () => ftp,
    };
    const fileSystem = new FTPFileSystem(path.posix, {
      client: remoteClient as any,
      remoteTimeOffsetInHours: 0,
    });

    const stat = await fileSystem.lstat('/assets/css/modals.css');

    expect(ftp.lastMod).not.toHaveBeenCalled();
    expect(stat.mtime).toBe(modifiedAt.getTime());
  });
});
