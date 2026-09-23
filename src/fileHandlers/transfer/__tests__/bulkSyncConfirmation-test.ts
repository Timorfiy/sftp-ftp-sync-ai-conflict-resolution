const showWarningMessage = jest.fn();

jest.mock('vscode', () => ({
  window: { showWarningMessage },
}));

import {
  buildBulkSyncConfirmationCopy,
  confirmBulkSync,
  BulkSyncConfirmationRequest,
} from '../bulkSyncConfirmation';

const disabledBackup = {
  enabled: false,
  folder: '.sftp-backups',
  versions: 0,
  onDelete: false,
} as const;

function request(
  overrides: Partial<BulkSyncConfirmationRequest> = {}
): BulkSyncConfirmationRequest {
  return {
    direction: 'localToRemote',
    connectionLabel: 'Profile "production"',
    localPath: 'C:\\workspace\\site',
    remotePath: '/var/www/site',
    deleteDestination: false,
    backup: disabledBackup,
    ...overrides,
  };
}

describe('bulk sync confirmation copy', () => {
  beforeEach(() => {
    showWarningMessage.mockReset();
  });

  test('names the direction, stable profile, and exact Local → Remote paths', () => {
    const copy = buildBulkSyncConfirmationCopy(request());

    expect(copy.message).toBe('Confirm Local → Remote (upload) sync');
    expect(copy.confirmLabel).toBe('Sync Local → Remote');
    expect(copy.detail).toContain('Connection/profile: Profile "production"');
    expect(copy.detail).toContain('Local path: C:\\workspace\\site');
    expect(copy.detail).toContain('Remote path: /var/www/site');
    expect(copy.detail).toContain('can create or overwrite remote files');
    expect(copy.detail).toContain('Remote overwrite backups are not enabled');
    expect(copy.detail).toContain('no guaranteed undo');
  });

  test('identifies remote deletion and truthful text-only fail-open recovery', () => {
    const copy = buildBulkSyncConfirmationCopy(request({
      deleteDestination: true,
      backup: {
        enabled: true,
        location: 'local',
        folder: '.sftp-backups',
        versions: 100,
        onDelete: true,
      },
    }));

    expect(copy.detail).toContain(
      'Remote files and folders absent locally will be deleted remotely.'
    );
    expect(copy.detail).toContain('Sync deletions are outside backup.onDelete');
    expect(copy.detail).toContain('cover text files only');
    expect(copy.detail).toContain('backup failure does not block the overwrite');
    expect(copy.detail).toContain('not a guaranteed undo');
  });

  test('identifies local deletion and the lack of retained download recovery', () => {
    const copy = buildBulkSyncConfirmationCopy(request({
      direction: 'remoteToLocal',
      deleteDestination: true,
    }));

    expect(copy.message).toBe('Confirm Remote → Local sync');
    expect(copy.detail).toContain(
      'Local files and folders absent remotely will be deleted locally.'
    );
    expect(copy.detail).toContain('Sync deletions are outside backup.onDelete');
    expect(copy.detail).toContain(
      'Successful Remote → Local replacements do not retain an extension recovery version.'
    );
  });

  test('Both Directions warns about writes and remote overwrite without delete claims', () => {
    const copy = buildBulkSyncConfirmationCopy(request({
      direction: 'bothDirections',
      deleteDestination: false,
    }));

    expect(copy.message).toBe('Confirm Both Directions sync');
    expect(copy.detail).toContain('can write local and remote files');
    expect(copy.detail).toContain('can overwrite remote files');
    expect(copy.detail).not.toMatch(/will be deleted/i);
  });

  test('only the exact affirmative action authorizes the operation', async () => {
    showWarningMessage
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('Cancel')
      .mockResolvedValueOnce('Sync Local → Remote');

    await expect(confirmBulkSync(request())).resolves.toBe(false);
    await expect(confirmBulkSync(request())).resolves.toBe(false);
    await expect(confirmBulkSync(request())).resolves.toBe(true);
    expect(showWarningMessage).toHaveBeenNthCalledWith(
      1,
      'Confirm Local → Remote (upload) sync',
      expect.objectContaining({ modal: true }),
      'Sync Local → Remote'
    );
  });
});
