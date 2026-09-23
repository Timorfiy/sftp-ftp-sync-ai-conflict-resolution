import * as vscode from 'vscode';
import { COMMAND_CLEAR_CONFLICT_STATE } from '../constants';
import { clearConflictState } from '../fileHandlers/transfer/conflictBridge';
import { getWorkspaceFolders, showInformationMessage } from '../host';
import { checkCommand } from './abstract/createCommand';

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export default checkCommand({
  id: COMMAND_CLEAR_CONFLICT_STATE,

  async handleCommand() {
    const folders = getWorkspaceFolders();
    if (!folders || folders.length === 0) {
      showInformationMessage('Open a workspace to clear its conflict state.');
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      'Clear saved conflict state for the open workspace(s)?',
      {
        modal: true,
        detail:
          'Completed, cancelled, failed, and restart-orphaned records will be removed. Active conflict decisions in any editor window will be preserved.',
      },
      'Clear Conflict State'
    );
    if (confirmed !== 'Clear Conflict State') {
      return;
    }

    const result = await clearConflictState(
      folders.map(folder => folder.uri.fsPath)
    );
    showInformationMessage(
      `Cleared ${result.clearedRecords} conflict record(s) (${formatBytes(result.clearedBytes)}); ` +
        `preserved ${result.retainedActiveRecords} active decision(s).`
    );
  },
});
