import * as vscode from 'vscode';
import { CONFIG_PATH, COMMAND_APPLY_IGNORE_PRESET } from '../constants';
import { IGNORE_PRESETS, getIgnoreConfigTargets, applyIgnorePreset, IgnoreConfigTarget } from '../modules/ignorePresets';
import { checkCommand } from './abstract/createCommand';

export default checkCommand({
  id: COMMAND_APPLY_IGNORE_PRESET,

  async handleCommand() {
    const candidates: { document: vscode.TextDocument; target: IgnoreConfigTarget; version: number;
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
      for (const target of getIgnoreConfigTargets(document.getText())) {
        candidates.push({
          document, target, version: document.version,
          label: `${folder.name}: ${target.label}`, description: target.host,
          detail: target.path.includes('profiles') ? 'Adds rules to this profile only' : 'Adds rules inherited by all profiles',
        });
      }
    }
    if (!candidates.length) {
      await vscode.window.showInformationMessage('No sftp.json found. Run SFTP: Config to create one.');
      return;
    }
    const selected = candidates.length === 1 ? candidates[0] :
      await vscode.window.showQuickPick(candidates, { placeHolder: 'Select a configuration or profile for the ignore template' });
    if (!selected) return;
    if (selected.document.isDirty) {
      await vscode.window.showWarningMessage('Save sftp.json before applying an ignore template.');
      return;
    }
    const preset = await vscode.window.showQuickPick(IGNORE_PRESETS.map(item => ({
      ...item, detail: item.patterns.join(', '),
    })), {
      placeHolder: 'Add an ignore template — existing rules are kept', matchOnDescription: true,
    });
    if (!preset) return;
    const { document, target, version } = selected;
    if (document.version !== version || document.isDirty) {
      await vscode.window.showWarningMessage('sftp.json changed while selecting a template. Run the command again.');
      return;
    }
    const text = document.getText();
    const updated = applyIgnorePreset(text, target, preset.patterns);
    if (updated === text) {
      await vscode.window.showInformationMessage(`Ignore template ${preset.label}: all rules are already present.`);
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), updated);
    if (!await vscode.workspace.applyEdit(edit) || !await document.save()) {
      throw new Error('Could not save the ignore template to sftp.json.');
    }
    await vscode.window.showTextDocument(document);
    await vscode.window.showInformationMessage(`Added ${preset.label} ignore rules to ${target.label}.`);
  },
});
