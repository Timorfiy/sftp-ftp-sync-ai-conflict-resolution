jest.mock('../../logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import { Readable } from 'stream';
import { FileType } from '../fs';
import TransferTask, { TransferDirection } from '../transferTask';

function taskWithCallbacks(onTransferSuccess: jest.Mock, onTransferError: jest.Mock) {
  const srcFs = {
    get: jest.fn(async () => Readable.from(['content'])),
  } as any;
  const targetFs = {
    open: jest.fn(async () => 1),
    put: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
  } as any;
  const task = new TransferTask(
    { fsPath: 'C:\\workspace\\local.txt', fileSystem: srcFs },
    { fsPath: '/remote/local.txt', fileSystem: targetFs },
    {
      fileType: FileType.File,
      transferDirection: TransferDirection.LOCAL_TO_REMOTE,
      transferOption: {
        atime: 0,
        mtime: 0,
        perserveTargetMode: false,
        onTransferSuccess,
        onTransferError,
      },
    }
  );
  return { task, targetFs };
}

describe('TransferTask completion callbacks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('calls success only after a completed transfer', async () => {
    const success = jest.fn(async () => undefined);
    const failure = jest.fn(async () => undefined);

    await taskWithCallbacks(success, failure).task.run();

    expect(success).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
  });

  test('calls failure and never success when transfer throws', async () => {
    const transferError = new Error('fake transfer failure');
    const success = jest.fn(async () => undefined);
    const failure = jest.fn(async () => undefined);
    const { task, targetFs } = taskWithCallbacks(success, failure);
    targetFs.put.mockRejectedValueOnce(transferError);

    await expect(task.run()).rejects.toThrow(
      'fake transfer failure'
    );

    expect(success).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith(transferError);
  });
});
