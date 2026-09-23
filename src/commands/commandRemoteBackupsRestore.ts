import * as vscode from 'vscode';
import * as path from 'path';
import { COMMAND_REMOTE_BACKUPS_RESTORE } from '../constants';
import { BackupVersion } from '../modules/remoteBackups';
import { checkCommand } from './abstract/createCommand';
import localFs from '../core/localFs';
import { createBackup, BackupStorage } from '../core/backup';
import * as fileOperations from '../core/fileBaseOperations';
import { showInformationMessage } from '../host';
import { reportError } from '../helper';

export default checkCommand({
  id: COMMAND_REMOTE_BACKUPS_RESTORE,

  async handleCommand(item: BackupVersion) {
    if (!item || !item.backupPath) {
      return;
    }

    const confirm = await vscode.window.showWarningMessage(
      `Restore backup from ${item.timestamp.toLocaleString()} to ${item.originalPath}?`,
      { modal: true },
      'Restore'
    );
    if (confirm !== 'Restore') {
      return;
    }

    try {
      const config = item.fileService.getConfig();
      const remoteFs = await item.fileService.getRemoteFileSystem(config);
      const backupLocation = config.backup?.location || 'remote';

      // Backup the current live file before restoring, if backups are enabled.
      if (config.backup && config.backup.enabled && config.backup.versions > 0) {
        let storage: BackupStorage | undefined;
        if (backupLocation === 'local') {
          storage = {
            fs: localFs,
            root: path.join(item.fileService.baseDir, config.backup.folder),
            pathResolver: path,
          };
        }
        const backupResult = await createBackup(
          item.originalPath,
          remoteFs,
          config.backup,
          config.remotePath,
          storage
        );
        if (backupResult.status === 'failed') {
          throw new Error(
            'The current remote file could not be backed up, so restore was not started.'
          );
        }
      }

      const backupFs = item.location === 'local' ? localFs : remoteFs;
      await fileOperations.transferFile(item.backupPath, item.originalPath, backupFs, remoteFs);
      showInformationMessage(`Restored backup to ${item.originalPath}`);
    } catch (error) {
      void reportError(error, {
        operation: 'restore backup',
        retrySafety: 'unsafe',
      });
    }
  },
});
