const fs = require('fs');
const os = require('os');
const path = require('path');

const showTextDocument = jest.fn(async () => undefined);
const reportError = jest.fn();

jest.mock('vscode', () => ({
  Uri: { file: value => ({ fsPath: value }) },
}));
jest.mock('../src/host', () => ({ showTextDocument }));
jest.mock('../src/helper', () => ({ reportError }));

const {
  ConfigDocumentError,
  createNewConfigTemplate,
  getConfigPath,
  loadConfigDocument,
  newConfig,
} = require('../src/modules/config');

describe('safe generated configuration', () => {
  let workspace;

  beforeEach(async () => {
    jest.clearAllMocks();
    workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sftp-config-'));
  });

  afterEach(async () => {
    await fs.promises.rm(workspace, { recursive: true, force: true });
  });

  test('uses explicit safe defaults only in the new-config template', () => {
    expect(createNewConfigTemplate()).toMatchObject({
      conflictCheck: true,
      backup: {
        enabled: true,
        location: 'local',
        folder: '.vscode/sftp-backup',
        versions: 100,
        onDelete: false,
      },
      watcher: {
        files: false,
        autoUpload: false,
        autoDelete: false,
        autoRename: false,
      },
      syncOption: {
        delete: false,
        skipCreate: false,
        ignoreExisting: false,
        update: false,
      },
    });
  });

  test('writes the safe template for a new workspace', async () => {
    await newConfig(workspace);
    const configPath = getConfigPath(workspace);
    expect(JSON.parse(await fs.promises.readFile(configPath, 'utf8')))
      .toEqual(createNewConfigTemplate());
    expect(showTextDocument).toHaveBeenCalledWith({ fsPath: configPath });
    expect(reportError).not.toHaveBeenCalled();
  });

  test('opens an existing config byte-for-byte without migration', async () => {
    const configPath = getConfigPath(workspace);
    const original = '{\r\n  "host": "example",\r\n  "username": "user",\r\n  "remotePath": "/"\r\n}\r\n';
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, original);

    await newConfig(workspace);

    expect(await fs.promises.readFile(configPath, 'utf8')).toBe(original);
    expect(showTextDocument).toHaveBeenCalledWith({ fsPath: configPath });
  });

  test('keeps existing omission behavior while validating through one loader', async () => {
    const configPath = getConfigPath(workspace);
    const original = JSON.stringify({
      host: 'example',
      username: 'user',
      remotePath: '/',
    });
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, original);

    const document = await loadConfigDocument(configPath);

    expect(document.configs[0]).toMatchObject({
      conflictCheck: false,
      backup: {
        enabled: false,
        location: 'remote',
        versions: 100,
        onDelete: false,
      },
    });
    expect(await fs.promises.readFile(configPath, 'utf8')).toBe(original);
  });

  test('reports malformed JSON as a configuration diagnostic', async () => {
    const configPath = getConfigPath(workspace);
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, '{ "host": ');

    await expect(loadConfigDocument(configPath)).rejects.toEqual(
      expect.objectContaining({
        name: 'ConfigDocumentError',
        configPath,
        message: expect.stringContaining('Invalid JSON'),
      })
    );
    await expect(loadConfigDocument(configPath)).rejects.toBeInstanceOf(ConfigDocumentError);
  });
});
