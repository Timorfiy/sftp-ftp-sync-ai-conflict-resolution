import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import * as path from 'path';
import { COMMAND_CONFIG, COMMAND_TEST_CONNECTION } from '../constants';
import FileService, {
  FileServiceConfig,
  ServiceConfig,
  prepareRemoteConnectionOption,
} from '../core/fileService';
import { probeConnection } from '../core/connectionProbe';
import {
  ConfigDocumentError,
  getConfigPath,
  loadConfigDocument,
  validateConfig,
} from '../modules/config';
import { getBasePath } from '../modules/serviceManager';
import { executeCommand, getWorkspaceFolders, showTextDocument } from '../host';
import { checkCommand } from './abstract/createCommand';

interface ConnectionTarget {
  targetType: 'connection';
  workspace: string;
  workspaceName: string;
  configPath: string;
  config: FileServiceConfig;
  profile: string | null;
  resolvedConfig?: ServiceConfig;
  resolutionError?: string;
  label: string;
  description: string;
}

interface InvalidConfigTarget {
  targetType: 'configuration';
  workspace: string;
  workspaceName: string;
  configPath: string;
  error: ConfigDocumentError;
  label: string;
  description: string;
}

type TestTarget = ConnectionTarget | InvalidConfigTarget;

function targetLabel(
  workspaceName: string,
  config: any,
  index: number,
  profile: string | null,
  hasProfiles: boolean
): string {
  const connection = config.name || `Connection ${index + 1}`;
  const targetName = profile || (hasProfiles ? 'base connection' : undefined);
  return targetName
    ? `${workspaceName} - ${connection} / ${targetName}`
    : `${workspaceName} - ${connection}`;
}

function targetDescription(config: ServiceConfig): string {
  const port = config.port === undefined ? '' : `:${config.port}`;
  return `${config.protocol}://${config.host}${port}${config.remotePath}`;
}

export async function discoverConnectionTargets(
  workspaceFolders: readonly vscode.WorkspaceFolder[]
): Promise<TestTarget[]> {
  const targets: TestTarget[] = [];
  for (const folder of workspaceFolders) {
    const workspace = folder.uri.fsPath;
    const configPath = getConfigPath(workspace);
    if (!(await fse.pathExists(configPath))) {
      continue;
    }
    try {
      const document = await loadConfigDocument(configPath);
      document.configs.forEach((config, index) => {
        const profiles = Object.keys(config.profiles || {});
        const targetProfiles: Array<string | null> = [null, ...profiles];
        targetProfiles.forEach(profile => {
          const target: ConnectionTarget = {
            targetType: 'connection',
            workspace,
            workspaceName: folder.name,
            configPath,
            config,
            profile,
            label: targetLabel(folder.name, config, index, profile, profiles.length > 0),
            description: 'Invalid configuration',
          };
          try {
            target.resolvedConfig = resolveTargetConfig(target);
            target.description = targetDescription(target.resolvedConfig);
          } catch (error) {
            target.resolutionError = error instanceof Error
              ? error.message
              : 'The selected configuration is invalid.';
          }
          targets.push(target);
        });
      });
    } catch (error) {
      const configError = error instanceof ConfigDocumentError
        ? error
        : new ConfigDocumentError(configPath, 'Unable to load this configuration.');
      targets.push({
        targetType: 'configuration',
        workspace,
        workspaceName: folder.name,
        configPath,
        error: configError,
        label: `${folder.name} - invalid configuration`,
        description: configError.message,
      });
    }
  }
  return targets;
}

function resolveTargetConfig(target: ConnectionTarget): ServiceConfig {
  const copy = JSON.parse(JSON.stringify(target.config)) as FileServiceConfig;
  const service = new FileService(
    getBasePath(copy.context, target.workspace),
    target.workspace,
    copy
  );
  service.setConfigValidator(validateConfig);
  return service.getConfig(target.profile);
}

async function openConfig(configPath?: string): Promise<void> {
  if (configPath && await fse.pathExists(configPath)) {
    await showTextDocument(vscode.Uri.file(configPath));
    return;
  }
  await executeCommand(COMMAND_CONFIG);
}

async function showConfigurationFailure(
  configPath: string | undefined,
  message: string,
  field?: string
): Promise<void> {
  const location = field ? ` (${field})` : '';
  const action = await vscode.window.showErrorMessage(
    `Test Connection - Configuration${location}: ${message}`,
    'Open Config'
  );
  if (action === 'Open Config') {
    await openConfig(configPath);
  }
}

function targetFromExplorerItem(item: any): ConnectionTarget | undefined {
  const context = item && item.explorerContext;
  if (!context || !context.config || !context.fileService) {
    return undefined;
  }
  const service = context.fileService as FileService;
  const config = context.config as ServiceConfig;
  return {
    targetType: 'connection',
    workspace: service.workspace,
    workspaceName: path.basename(service.workspace),
    configPath: getConfigPath(service.workspace),
    config: config as unknown as FileServiceConfig,
    profile: null,
    resolvedConfig: config,
    label: config.name || service.name || config.host,
    description: targetDescription(config),
  };
}

async function pickTarget(targets: TestTarget[]): Promise<TestTarget | undefined> {
  if (targets.length === 1) {
    return targets[0];
  }
  return vscode.window.showQuickPick(targets, {
    placeHolder: 'Select the connection or profile to test',
  });
}

export async function runTestConnection(item?: any): Promise<void> {
  const explorerTarget = targetFromExplorerItem(item);
  let target: TestTarget | undefined = explorerTarget;
  if (!target) {
    const folders = getWorkspaceFolders();
    if (!folders || folders.length === 0) {
      await showConfigurationFailure(undefined, 'Open a workspace folder and create .vscode/sftp.json.');
      return;
    }
    const targets = await discoverConnectionTargets(folders);
    if (targets.length === 0) {
      await showConfigurationFailure(undefined, 'No .vscode/sftp.json was found.');
      return;
    }
    target = await pickTarget(targets);
  }
  if (!target) {
    return;
  }
  if (target.targetType === 'configuration') {
    await showConfigurationFailure(target.configPath, target.error.message, target.error.field);
    return;
  }

  if (target.resolutionError) {
    await showConfigurationFailure(target.configPath, target.resolutionError);
    return;
  }
  const config = target.resolvedConfig || resolveTargetConfig(target);
  if (config.protocol !== 'ftp' && config.protocol !== 'sftp') {
    await showConfigurationFailure(
      target.configPath,
      `Protocol "${config.protocol}" cannot be tested. Use ftp or sftp.`,
      'protocol'
    );
    return;
  }

  if (config.protocol === 'ftp' && !config.secure) {
    const choice = await vscode.window.showWarningMessage(
      'Plain FTP has no transport encryption: credentials and file contents can be read or changed in transit.',
      { modal: true },
      'Continue'
    );
    if (choice !== 'Continue') {
      return;
    }
  }

  let option;
  try {
    option = await prepareRemoteConnectionOption(config, target.workspace);
  } catch {
    await showConfigurationFailure(
      target.configPath,
      'Credentials or connection options could not be prepared. Check the selected profile and Secret Storage.'
    );
    return;
  }
  const hasProfiles = Object.keys(target.config.profiles || {}).length > 0;
  const profile = target.profile ||
    (hasProfiles ? `${config.name || 'connection'} (base)` : config.name) ||
    'default connection';
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Testing ${profile}...`,
      cancellable: false,
    },
    () => probeConnection(option, config.remotePath, profile)
  );

  if (result.ok) {
    await vscode.window.showInformationMessage(`Test Connection succeeded: ${result.message}`);
    return;
  }
  if (result.category === 'Cancelled') {
    await vscode.window.showInformationMessage(
      `Test Connection - ${result.category}: ${result.message} ${result.nextStep}`
    );
    return;
  }
  const action = await vscode.window.showErrorMessage(
    `Test Connection - ${result.category}: ${result.message} ${result.nextStep}`,
    'Open Config'
  );
  if (action === 'Open Config') {
    await openConfig(target.configPath);
  }
}

export default checkCommand({
  id: COMMAND_TEST_CONNECTION,
  handleCommand: runTestConnection,
});
