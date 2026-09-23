jest.mock('../../src/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const TransferTask = require('../../src/core/transferTask').default;
const { TransferDirection } = require('../../src/core/transferTask');
const { FileType } = require('../../src/core/fs');
const logger = require('../../src/logger').default;

function createTask(direction, put) {
  const srcFs = {
    get: jest.fn(async () => ({})),
  };
  const targetFs = {
    open: jest.fn(async () => ({ path: '/target/index.php' })),
    put,
    close: jest.fn(async () => {}),
    unlink: jest.fn(async () => {}),
    renameAtomic: jest.fn(async () => {}),
  };
  const task = new TransferTask(
    { fsPath: '/source/index.php', fileSystem: srcFs },
    { fsPath: '/target/index.php', fileSystem: targetFs },
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

  return { task, srcFs, targetFs };
}

describe('TransferTask transient download recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('retries a remote-to-local file once after ETIMEDOUT', async () => {
    const timeout = Object.assign(new Error('connect ETIMEDOUT 192.0.2.1:45937'), {
      code: 'ETIMEDOUT',
    });
    const put = jest.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce(undefined);
    const { task, srcFs, targetFs } = createTask(TransferDirection.REMOTE_TO_LOCAL, put);

    await task.run();

    expect(srcFs.get).toHaveBeenCalledTimes(2);
    expect(targetFs.open).toHaveBeenCalledTimes(2);
    expect(targetFs.put).toHaveBeenCalledTimes(2);
    expect(targetFs.close).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Retrying remote download'));
  });

  test('does not retry a non-network download failure', async () => {
    const put = jest.fn().mockRejectedValue(Object.assign(new Error('Permission denied'), {
      code: 'EACCES',
    }));
    const { task, targetFs } = createTask(TransferDirection.REMOTE_TO_LOCAL, put);

    await expect(task.run()).rejects.toThrow('Permission denied');

    expect(targetFs.put).toHaveBeenCalledTimes(1);
  });

  test('does not automatically replay an upload after ETIMEDOUT', async () => {
    const put = jest.fn().mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    }));
    const { task, targetFs } = createTask(TransferDirection.LOCAL_TO_REMOTE, put);

    await expect(task.run()).rejects.toThrow('ETIMEDOUT');

    expect(targetFs.put).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('leaves reconnecting a real remote filesystem to the handler-level retry', async () => {
    const timeout = Object.assign(new Error('connection closed during download'), {
      code: 'ECONNRESET',
    });
    const put = jest.fn().mockRejectedValue(timeout);
    const { task, srcFs, targetFs } = createTask(TransferDirection.REMOTE_TO_LOCAL, put);
    srcFs.getClient = jest.fn(() => ({ isClosed: () => true }));

    await expect(task.run()).rejects.toThrow('connection closed');

    expect(targetFs.put).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
