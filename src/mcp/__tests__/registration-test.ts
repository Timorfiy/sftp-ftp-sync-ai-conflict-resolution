const registerMcpServerDefinitionProvider = jest.fn();
const registerServer = jest.fn();
const unregisterServer = jest.fn();

const mockVscodeApi = {
  lm: { registerMcpServerDefinitionProvider },
  cursor: undefined,
  McpStdioServerDefinition: class {
    cwd: unknown;
    constructor(
      readonly label: string,
      readonly command: string,
      readonly args: string[],
      readonly env: Record<string, string | number | null>,
      readonly version: string
    ) {}
  },
};

jest.mock('vscode', () => mockVscodeApi);

jest.mock('../../fileHandlers/transfer/conflictBridge', () => ({
  getConflictMcpConfiguration: jest.fn(() => ({
    version: 1,
    extensionVersion: '0.1.0',
    stateRoot: 'private-state',
    capability: '01234567890123456789012345678901',
    workspaces: [
      {
        bucket: 'a'.repeat(64),
        root: 'C:\\workspace',
        name: 'workspace',
      },
    ],
  })),
}));

import { MCP_CONFIG_ENV, MCP_PROVIDER_ID } from '../conflictContract';
import { registerConflictMcpProvider } from '../registration';

describe('editor MCP registration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVscodeApi.cursor = undefined;
  });

  test('automatically provides the bundled stdio server through the supported API', () => {
    const disposable = { dispose: jest.fn() };
    registerMcpServerDefinitionProvider.mockReturnValue(disposable);
    const context = {
      extension: { packageJSON: { version: '0.1.0' } },
      extensionUri: { fsPath: 'C:\\extension' },
      asAbsolutePath: jest.fn(relative => `C:\\extension\\${relative.replace(/\//g, '\\')}`),
    } as any;
    const workspaces = [
      { name: 'workspace', uri: { fsPath: 'C:\\workspace' } },
    ] as any;

    expect(registerConflictMcpProvider(context, workspaces)).toBe(disposable);
    expect(registerMcpServerDefinitionProvider).toHaveBeenCalledWith(
      MCP_PROVIDER_ID,
      expect.objectContaining({
        provideMcpServerDefinitions: expect.any(Function),
      })
    );
    const provider = registerMcpServerDefinitionProvider.mock.calls[0][1];
    const [definition] = provider.provideMcpServerDefinitions();
    expect(definition).toMatchObject({
      label: 'SFTP/FTP Sync Conflict Resolution',
      command: process.execPath,
      args: ['C:\\extension\\dist\\mcp-server.js'],
      version: '0.1.0',
      cwd: context.extensionUri,
    });
    expect(definition.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(JSON.parse(definition.env[MCP_CONFIG_ENV])).toMatchObject({
      stateRoot: 'private-state',
      capability: '01234567890123456789012345678901',
    });
  });

  test('uses Cursor documented extension registration without writing mcp.json', () => {
    mockVscodeApi.cursor = {
      mcp: { registerServer, unregisterServer },
    } as any;
    const context = {
      extension: { packageJSON: { version: '0.1.0' } },
      extensionUri: { fsPath: 'C:\\extension' },
      asAbsolutePath: jest.fn(relative => `C:\\extension\\${relative.replace(/\//g, '\\')}`),
    } as any;
    const disposable = registerConflictMcpProvider(context, [
      { name: 'workspace', uri: { fsPath: 'C:\\workspace' } },
    ] as any);

    expect(registerMcpServerDefinitionProvider).not.toHaveBeenCalled();
    expect(registerServer).toHaveBeenCalledWith({
      name: 'sftp-sync-ai-conflicts',
      server: {
        command: process.execPath,
        args: ['C:\\extension\\dist\\mcp-server.js'],
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: '1',
          [MCP_CONFIG_ENV]: expect.any(String),
        }),
      },
    });
    disposable.dispose();
    expect(unregisterServer).toHaveBeenCalledWith('sftp-sync-ai-conflicts');
  });
});
