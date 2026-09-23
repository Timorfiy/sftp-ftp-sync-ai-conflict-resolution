const fs = require('fs');
const os = require('os');
const path = require('path');

const showWarningMessage = jest.fn();
const showInformationMessage = jest.fn();
const showErrorMessage = jest.fn();
const withProgress = jest.fn((_options, task) => task());
const showQuickPick = jest.fn();
const prepareRemoteConnectionOption = jest.fn(async config => ({
  ...config,
  remoteTimeOffsetInHours: 0,
}));
const probeConnection = jest.fn();
const executeCommand = jest.fn();
const showTextDocument = jest.fn();
const getWorkspaceFolders = jest.fn();
const loadConfigDocument = jest.fn();
const activeProfile = { value: undefined };

jest.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  Uri: { file: value => ({ fsPath: value }) },
  window: {
    showWarningMessage,
    showInformationMessage,
    showErrorMessage,
    withProgress,
    showQuickPick,
  },
}));
jest.mock('../src/core/fileService', () => ({
  __esModule: true,
  default: class FileService {
    constructor(_baseDir, _workspace, config) {
      this.config = config;
    }
    setConfigValidator() {}
    getConfig(profile = activeProfile.value) {
      if (profile === null || profile === undefined) return this.config;
      return { ...this.config, ...this.config.profiles[profile], profiles: undefined };
    }
  },
  prepareRemoteConnectionOption,
}));
jest.mock('../src/core/connectionProbe', () => ({ probeConnection }));
jest.mock('../src/modules/serviceManager', () => ({ getBasePath: value => value }));
jest.mock('../src/modules/config', () => ({
  ConfigDocumentError: class ConfigDocumentError extends Error {
    constructor(configPath, message, field) {
      super(message);
      this.configPath = configPath;
      this.field = field;
    }
  },
  getConfigPath: workspace => path.join(workspace, '.vscode', 'sftp.json'),
  loadConfigDocument,
  validateConfig: jest.fn(),
}));
jest.mock('../src/host', () => ({
  executeCommand,
  getWorkspaceFolders,
  showTextDocument,
}));
jest.mock('../src/commands/abstract/createCommand', () => ({
  checkCommand: value => value,
}));

const { runTestConnection } = require('../src/commands/commandTestConnection');

function explorerItem(config) {
  return {
    explorerContext: {
      config,
      fileService: {
        workspace: 'C:\\workspace',
        name: 'Fixture',
      },
    },
  };
}

describe('Test Connection command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    activeProfile.value = undefined;
    showWarningMessage.mockResolvedValue(undefined);
    probeConnection.mockResolvedValue({
      ok: true,
      protocol: 'sftp',
      profile: 'Fixture',
      remotePath: '/site',
      message: 'Connected with SFTP and read /site. No remote data was changed.',
    });
  });

  test('requires an explicit non-suppressible plain-FTP continuation', async () => {
    showWarningMessage.mockResolvedValue('Cancel');
    await runTestConnection(explorerItem({
      name: 'FTP site',
      protocol: 'ftp',
      secure: false,
      host: '127.0.0.1',
      username: 'user',
      remotePath: '/site',
    }));

    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('credentials and file contents'),
      { modal: true },
      'Continue'
    );
    expect(prepareRemoteConnectionOption).not.toHaveBeenCalled();
    expect(probeConnection).not.toHaveBeenCalled();
  });

  test('runs the FTP probe only after Continue and reports read-only success', async () => {
    showWarningMessage.mockResolvedValue('Continue');
    probeConnection.mockResolvedValue({
      ok: true,
      protocol: 'ftp',
      profile: 'FTP site',
      remotePath: '/site',
      message: 'Connected with FTP and read /site. No remote data was changed.',
    });

    await runTestConnection(explorerItem({
      name: 'FTP site',
      protocol: 'ftp',
      secure: false,
      host: '127.0.0.1',
      username: 'user',
      remotePath: '/site',
    }));

    expect(prepareRemoteConnectionOption).toHaveBeenCalledTimes(1);
    expect(probeConnection).toHaveBeenCalledTimes(1);
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('No remote data was changed')
    );
  });

  test('does not show the plain-FTP warning for SFTP', async () => {
    await runTestConnection(explorerItem({
      name: 'SFTP site',
      protocol: 'sftp',
      host: '127.0.0.1',
      username: 'user',
      remotePath: '/site',
    }));

    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(probeConnection).toHaveBeenCalledTimes(1);
  });

  test('offers Open Config for categorized failure without exposing raw credentials', async () => {
    probeConnection.mockResolvedValue({
      ok: false,
      category: 'Authentication',
      message: 'The server rejected the credentials.',
      nextStep: 'Check the username and authentication method.',
    });
    showErrorMessage.mockResolvedValue(undefined);

    await runTestConnection(explorerItem({
      name: 'SFTP site',
      protocol: 'sftp',
      host: '127.0.0.1',
      username: 'user',
      password: 'do-not-display',
      remotePath: '/site',
    }));

    const displayed = showErrorMessage.mock.calls[0][0];
    expect(displayed).toContain('Authentication');
    expect(displayed).not.toContain('do-not-display');
    expect(showErrorMessage).toHaveBeenCalledWith(displayed, 'Open Config');
  });

  test('handles no workspace as Configuration before networking', async () => {
    getWorkspaceFolders.mockReturnValue(undefined);
    await runTestConnection();

    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Configuration'),
      'Open Config'
    );
    expect(prepareRemoteConnectionOption).not.toHaveBeenCalled();
    expect(probeConnection).not.toHaveBeenCalled();
  });

  test('skips target selection for one connection and prompts for multiple profiles', async () => {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sftp-command-'));
    const configPath = path.join(workspace, '.vscode', 'sftp.json');
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, '{}');
    getWorkspaceFolders.mockReturnValue([
      { name: 'site', uri: { fsPath: workspace } },
    ]);
    const base = {
      name: 'Site',
      protocol: 'sftp',
      host: '127.0.0.1',
      username: 'user',
      remotePath: '/site',
    };

    loadConfigDocument.mockResolvedValueOnce({ path: configPath, configs: [base] });
    await runTestConnection();
    expect(showQuickPick).not.toHaveBeenCalled();

    loadConfigDocument.mockResolvedValueOnce({
      path: configPath,
      configs: [{ ...base, profiles: { staging: {}, production: {} } }],
    });
    showQuickPick.mockImplementationOnce(async choices => choices[1]);
    await runTestConnection();
    expect(showQuickPick).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ label: expect.stringContaining('staging') }),
        expect.objectContaining({ label: expect.stringContaining('production') }),
      ]),
      expect.any(Object)
    );
    await fs.promises.rm(workspace, { recursive: true, force: true });
  });

  test('base and profile targets resolve the selected endpoint, not the active profile', async () => {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sftp-command-profile-'));
    const configPath = path.join(workspace, '.vscode', 'sftp.json');
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, '{}');
    getWorkspaceFolders.mockReturnValue([
      { name: 'site', uri: { fsPath: workspace } },
    ]);
    activeProfile.value = 'production';
    const config = {
      name: 'Site',
      protocol: 'sftp',
      host: 'base.example',
      port: 22,
      username: 'user',
      remotePath: '/base',
      profiles: {
        staging: {
          protocol: 'ftp',
          host: 'staging.example',
          port: 2121,
          remotePath: '/staging',
          secure: true,
        },
        production: {
          host: 'production.example',
          remotePath: '/production',
        },
      },
    };

    loadConfigDocument.mockResolvedValueOnce({ path: configPath, configs: [config] });
    showQuickPick.mockImplementationOnce(async choices => {
      expect(choices).toEqual(expect.arrayContaining([
        expect.objectContaining({
          profile: null,
          label: expect.stringContaining('base connection'),
          description: 'sftp://base.example:22/base',
        }),
        expect.objectContaining({
          profile: 'staging',
          description: 'ftp://staging.example:2121/staging',
        }),
        expect.objectContaining({
          profile: 'production',
          description: 'sftp://production.example:22/production',
        }),
      ]));
      return choices.find(choice => choice.profile === null);
    });
    await runTestConnection();
    expect(prepareRemoteConnectionOption).toHaveBeenLastCalledWith(
      expect.objectContaining({
        protocol: 'sftp',
        host: 'base.example',
        remotePath: '/base',
      }),
      workspace
    );
    expect(probeConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: 'base.example' }),
      '/base',
      'Site (base)'
    );

    loadConfigDocument.mockResolvedValueOnce({ path: configPath, configs: [config] });
    showQuickPick.mockImplementationOnce(async choices =>
      choices.find(choice => choice.profile === 'staging')
    );
    await runTestConnection();
    expect(prepareRemoteConnectionOption).toHaveBeenLastCalledWith(
      expect.objectContaining({
        protocol: 'ftp',
        host: 'staging.example',
        remotePath: '/staging',
      }),
      workspace
    );
    expect(probeConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: 'staging.example' }),
      '/staging',
      'staging'
    );
    await fs.promises.rm(workspace, { recursive: true, force: true });
  });

  test('reports malformed configuration without opening a connection', async () => {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sftp-command-bad-'));
    const configPath = path.join(workspace, '.vscode', 'sftp.json');
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, '{');
    getWorkspaceFolders.mockReturnValue([
      { name: 'site', uri: { fsPath: workspace } },
    ]);
    const ConfigDocumentError =
      require('../src/modules/config').ConfigDocumentError;
    loadConfigDocument.mockRejectedValueOnce(
      new ConfigDocumentError(configPath, 'Invalid JSON at line 1')
    );

    await runTestConnection();

    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Invalid JSON'),
      'Open Config'
    );
    expect(prepareRemoteConnectionOption).not.toHaveBeenCalled();
    expect(probeConnection).not.toHaveBeenCalled();
    await fs.promises.rm(workspace, { recursive: true, force: true });
  });
});
