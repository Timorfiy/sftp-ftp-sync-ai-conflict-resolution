import * as vscode from 'vscode';
import { CONFIG_PATH, COMMAND_SELECT_NETWORK_INTERFACE } from '../constants';
import { listNetworkInterfaces } from '../core/networkInterface';
import { getFTPConfigTargets, setNetworkInterface, FTPConfigTarget } from '../modules/networkInterfaceConfig';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_SELECT_NETWORK_INTERFACE,

  async handleCommand() {
    const candidates: { document: vscode.TextDocument; target: FTPConfigTarget; version: number;
      label: string; description: string; detail: string }[] = [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const uri = vscode.Uri.joinPath(folder.uri, CONFIG_PATH);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch (error) {
        if ((error as { code?: string }).code === 'FileNotFound') continue;
        throw error;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      for (const target of getFTPConfigTargets(document.getText())) {
        candidates.push({
          document, target, version: document.version,
          label: `${folder.name}: ${target.label}`, description: target.host,
          detail: `Current: ${target.networkInterface || 'system routing'}` +
            (target.isProfile ? '' : ' (inherited by profiles without an override)'),
        });
      }
    }
    if (!candidates.length) {
      await vscode.window.showInformationMessage('No FTP profiles found in .vscode/sftp.json.');
      return;
    }
    const selected = candidates.length === 1 ? candidates[0] :
      await vscode.window.showQuickPick(candidates, { placeHolder: 'Select an FTP configuration or profile' });
    if (!selected) return;
    if (selected.document.isDirty) {
      await vscode.window.showWarningMessage('Save sftp.json before selecting a network interface.');
      return;
    }
    const choices = [
      { label: 'Use system routing', description: 'Use the operating system routing table', value: undefined as string | undefined },
      ...listNetworkInterfaces().map(adapter => ({
        label: adapter.name, description: adapter.addresses.join(', '), value: adapter.name,
      })),
    ];
    const choice = await vscode.window.showQuickPick(choices, {
      placeHolder: 'Select the adapter for all FTP connections (control and file transfers)',
    });
    if (!choice) return;
    const { document, target, version } = selected;
    if (document.version !== version || document.isDirty) {
      await vscode.window.showWarningMessage('sftp.json changed while selecting an interface. Run the command again.');
      return;
    }
    const text = document.getText();
    const updated = setNetworkInterface(text, target, choice.value);
    if (updated === text) return;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), updated);
    if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
      throw new Error('Could not save the network interface selection to sftp.json.');
    }
    await vscode.window.showInformationMessage(
      `FTP network interface: ${choice.value || 'system routing'}.`,
    );
  },
});
