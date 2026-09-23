import * as path from 'path';
import * as vscode from 'vscode';
import { getConflictMcpConfiguration } from '../fileHandlers/transfer/conflictBridge';
import {
  MCP_CONFIG_ENV,
  MCP_PROVIDER_ID,
  MCP_SERVER_NAME,
} from './conflictContract';

interface CursorMcpApi {
  registerServer(config: {
    name: string;
    server: {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
  }): void;
  unregisterServer(name: string): void;
}

type VscodeWithCursor = typeof vscode & {
  cursor?: {
    mcp?: CursorMcpApi;
  };
};

function pathKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

export function registerConflictMcpProvider(
  context: vscode.ExtensionContext,
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): vscode.Disposable {
  const extensionVersion = String(context.extension.packageJSON.version || '0.1.0');
  const workspaceNames = new Map(
    workspaceFolders.map(folder => [pathKey(folder.uri.fsPath), folder.name])
  );
  const configuration = getConflictMcpConfiguration(
    extensionVersion,
    workspaceNames
  );
  const command = process.execPath;
  const args = [context.asAbsolutePath('dist/mcp-server.js')];
  const env = {
    ELECTRON_RUN_AS_NODE: '1',
    [MCP_CONFIG_ENV]: JSON.stringify(configuration),
  };
  const cursorMcp = (vscode as VscodeWithCursor).cursor?.mcp;
  if (cursorMcp) {
    cursorMcp.registerServer({
      name: MCP_SERVER_NAME,
      server: { command, args, env },
    });
    return {
      dispose() {
        cursorMcp.unregisterServer(MCP_SERVER_NAME);
      },
    };
  }

  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    provideMcpServerDefinitions() {
      const definition = new vscode.McpStdioServerDefinition(
        'SFTP/FTP Sync Conflict Resolution',
        command,
        args,
        env,
        extensionVersion
      );
      definition.cwd = context.extensionUri;
      return [definition];
    },
  };
  return vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider);
}
