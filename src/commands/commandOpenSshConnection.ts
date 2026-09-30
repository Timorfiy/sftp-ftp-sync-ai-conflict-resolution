import * as vscode from 'vscode';
import { COMMAND_OPEN_CONNECTION_IN_TERMINAL } from '../constants';
import { getAllFileService } from '../modules/serviceManager';
import { ExplorerRoot } from '../modules/remoteExplorer';
import { interpolate } from '../utils';
import { checkCommand } from './abstract/createCommand';
import { replaceHomePath } from '../helper/paths';

const isWindows = process.platform === 'win32';

function shouldUseAgent(config) {
  return typeof config.agent === 'string' && config.agent.length > 0;
}

function shouldUseKey(config) {
  return typeof config.privateKeyPath === 'string' && config.privateKeyPath.length > 0;
}

export function quotePosixArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildSshCommand(config, windows = isWindows): string {
  let command = windows
    ? getSshCommand(config)
    : `ssh -t ${quotePosixArgument(`${config.username}@${config.host}`)} -p ${quotePosixArgument(String(config.port))}`;
  if (!shouldUseAgent(config) && shouldUseKey(config)) {
    const key = windows ? config.privateKeyPath.replace(/\\\\/g, '\\') : replaceHomePath(config.privateKeyPath);
    command += ` -i ${windows ? `"${key}"` : quotePosixArgument(key)}`;
  }
  if (config.sshCustomParams) command += ' ' + interpolate(config.sshCustomParams, { remotePath: config.remotePath });
  return command;
}

function getSshCommand(
  config: { host: string; port: number; username: string },
  extraOption?: string
) {
  let sshStr = `ssh -t ${config.username}@${config.host} -p ${config.port}`;
  if (extraOption) {
    sshStr += ` ${extraOption}`;
  }
  // sshStr += ` "cd \\"${config.workingDir}\\"; exec \\$SHELL -l"`;
  return sshStr;
}

export default checkCommand({
  id: COMMAND_OPEN_CONNECTION_IN_TERMINAL,

  async handleCommand(exploreItem?: ExplorerRoot) {
    let remoteConfig;
    if (exploreItem && exploreItem.explorerContext) {
      remoteConfig = exploreItem.explorerContext.config;
      if (remoteConfig.protocol !== 'sftp') {
        return;
      }
    } else {
      const remoteItems = getAllFileService().reduce<
        { label: string; description: string; config: any }[]
      >((result, fileService) => {
        const config = fileService.getConfig();
        if (config.protocol === 'sftp') {
          result.push({
            label: config.name || config.remotePath,
            description: config.host,
            config,
          });
        }
        return result;
      }, []);
      if (remoteItems.length <= 0) {
        return;
      }

      const item = await vscode.window.showQuickPick(remoteItems, {
        placeHolder: 'Select a folder...',
      });
      if (item === undefined) {
        return;
      }

      remoteConfig = item.config;
    }

    const terminal = vscode.window.createTerminal(remoteConfig.name);
    terminal.sendText(buildSshCommand(remoteConfig));
    terminal.show();
  },
});
