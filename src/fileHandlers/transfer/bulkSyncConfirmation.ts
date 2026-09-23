import * as vscode from 'vscode';
import type { BackupConfig } from '../../core';

export type BulkSyncDirection =
  | 'localToRemote'
  | 'remoteToLocal'
  | 'bothDirections';

export interface BulkSyncConfirmationRequest {
  direction: BulkSyncDirection;
  connectionLabel: string;
  localPath: string;
  remotePath: string;
  deleteDestination: boolean;
  backup: BackupConfig;
}

export interface BulkSyncConfirmationCopy {
  message: string;
  detail: string;
  confirmLabel: string;
}

function uploadRecoveryCopy(backup: BackupConfig): string {
  if (backup.enabled && backup.versions > 0) {
    return (
      'Remote overwrite backups are enabled, but they cover text files only. ' +
      'A backup failure does not block the overwrite, so this is not a guaranteed undo.'
    );
  }

  return (
    'Remote overwrite backups are not enabled. ' +
    'This operation has no guaranteed undo.'
  );
}

export function buildBulkSyncConfirmationCopy(
  request: BulkSyncConfirmationRequest
): BulkSyncConfirmationCopy {
  const identityAndPaths = [
    `Connection/profile: ${request.connectionLabel}`,
    `Local path: ${request.localPath}`,
    `Remote path: ${request.remotePath}`,
  ].join('\n');

  if (request.direction === 'bothDirections') {
    return {
      message: 'Confirm Both Directions sync',
      confirmLabel: 'Sync Both Directions',
      detail: [
        identityAndPaths,
        '',
        'Both Directions can write local and remote files and can overwrite remote files.',
        uploadRecoveryCopy(request.backup),
        'Successful Remote → Local replacements do not retain an extension recovery version.',
      ].join('\n'),
    };
  }

  if (request.direction === 'remoteToLocal') {
    const deletionCopy = request.deleteDestination
      ? [
          'Local files and folders absent remotely will be deleted locally.',
          'Sync deletions are outside backup.onDelete and have no guaranteed undo.',
        ]
      : [];
    return {
      message: 'Confirm Remote → Local sync',
      confirmLabel: 'Sync Remote → Local',
      detail: [
        identityAndPaths,
        '',
        'Remote → Local can create or overwrite local files.',
        ...deletionCopy,
        'Successful Remote → Local replacements do not retain an extension recovery version.',
      ].join('\n'),
    };
  }

  const deletionCopy = request.deleteDestination
    ? [
        'Remote files and folders absent locally will be deleted remotely.',
        'Sync deletions are outside backup.onDelete and have no guaranteed undo.',
      ]
    : [];
  return {
    message: 'Confirm Local → Remote (upload) sync',
    confirmLabel: 'Sync Local → Remote',
    detail: [
      identityAndPaths,
      '',
      'Local → Remote (upload) can create or overwrite remote files.',
      ...deletionCopy,
      uploadRecoveryCopy(request.backup),
    ].join('\n'),
  };
}

export async function confirmBulkSync(
  request: BulkSyncConfirmationRequest
): Promise<boolean> {
  const copy = buildBulkSyncConfirmationCopy(request);
  const selected = await vscode.window.showWarningMessage(
    copy.message,
    {
      modal: true,
      detail: copy.detail,
    },
    copy.confirmLabel
  );
  return selected === copy.confirmLabel;
}
