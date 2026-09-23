import * as path from 'path';

const VENDOR_FOLDER = '.vscode';

export const EXTENSION_NAME = 'sftp';
export const COMMAND_NAMESPACE = 'sftpSyncAI';
export const CONTEXT_NAMESPACE = COMMAND_NAMESPACE;
export const SETTING_KEY_REMOTE = 'remotefs.remote';

export const REMOTE_SCHEME = 'remote';

export const VIEW_REMOTE_EXPLORER = 'remoteExplorer';

export const CONGIF_FILENAME = 'sftp.json';
export const CONFIG_PATH = path.join(VENDOR_FOLDER, CONGIF_FILENAME);

const command = (name: string) => `${COMMAND_NAMESPACE}.${name}`;

// command not in package.json
export const COMMAND_TOGGLE_OUTPUT = command('toggleOutput');

// commands in package.json
export const COMMAND_CONFIG = command('config');
export const COMMAND_SET_PROFILE = command('setProfile');
export const COMMAND_SELECT_NETWORK_INTERFACE = command('selectNetworkInterface');
export const COMMAND_CANCEL_ALL_TRANSFER = command('cancelAllTransfer');
export const COMMAND_OPEN_CONNECTION_IN_TERMINAL = command('openConnectInTerminal');

export const COMMAND_FORCE_UPLOAD = command('forceUpload');
export const COMMAND_UPLOAD = command('upload');
export const COMMAND_UPLOAD_FILE = command('upload.file');
export const COMMAND_UPLOAD_CHANGEDFILES = command('upload.changedFiles');
export const COMMAND_UPLOAD_ACTIVEFILE = command('upload.activeFile');
export const COMMAND_UPLOAD_FOLDER = command('upload.folder');
export const COMMAND_UPLOAD_ACTIVEFOLDER = command('upload.activeFolder');
export const COMMAND_UPLOAD_PROJECT = command('upload.project');

export const COMMAND_FORCE_UPLOAD_TO_ALL_PROFILES = command('forceUpload.to.allProfiles');
export const COMMAND_UPLOAD_TO_ALL_PROFILES = command('upload.to.allProfiles');
export const COMMAND_UPLOAD_FILE_TO_ALL_PROFILES = command('upload.file.to.allProfiles');
export const COMMAND_UPLOAD_ACTIVEFILE_TO_ALL_PROFILES = command('upload.activeFile.to.allProfiles');
export const COMMAND_UPLOAD_FOLDER_TO_ALL_PROFILES = command('upload.folder.to.allProfiles');
export const COMMAND_UPLOAD_ACTIVEFOLDER_TO_ALL_PROFILES = command('upload.activeFolder.to.allProfiles');
export const COMMAND_UPLOAD_PROJECT_TO_ALL_PROFILES = command('upload.project.to.allProfiles');

export const COMMAND_FORCE_DOWNLOAD = command('forceDownload');
export const COMMAND_DOWNLOAD = command('download');
export const COMMAND_DOWNLOAD_FILE = command('download.file');
export const COMMAND_DOWNLOAD_ACTIVEFILE = command('download.activeFile');
export const COMMAND_DOWNLOAD_FOLDER = command('download.folder');
export const COMMAND_DOWNLOAD_ACTIVEFOLDER = command('download.activeFolder');
export const COMMAND_DOWNLOAD_PROJECT = command('download.project');

export const COMMAND_SYNC_LOCAL_TO_REMOTE = command('sync.localToRemote');
export const COMMAND_SYNC_REMOTE_TO_LOCAL = command('sync.remoteToLocal');
export const COMMAND_SYNC_BOTH_DIRECTIONS = command('sync.bothDirections');

export const COMMAND_DIFF = command('diff');
export const COMMAND_DIFF_ACTIVEFILE = command('diff.activeFile');
export const COMMAND_LIST = command('list');
export const COMMAND_LIST_ACTIVEFOLDER = command('listActiveFolder');
export const COMMAND_LIST_ALL = command('listAll');
export const COMMAND_DELETE_REMOTE = command('delete.remote');
export const COMMAND_RENAME_REMOTE = command('rename.remote');
export const COMMAND_REVEAL_IN_EXPLORER = command('revealInExplorer');
export const COMMAND_REVEAL_IN_REMOTE_EXPLORER = command('revealInRemoteExplorer');

export const COMMAND_REMOTEEXPLORER_REFRESH = command('remoteExplorer.refresh');
export const COMMAND_REMOTEEXPLORER_EDITINLOCAL = command('remoteExplorer.editInLocal');
export const COMMAND_REMOTEEXPLORER_VIEW_CONTENT = command('viewContent');
export const COMMAND_REMOTEEXPLORER_FILTER = command('remoteExplorer.filter');
export const COMMAND_REMOTEEXPLORER_CLEAR_FILTER = command('remoteExplorer.clearFilter');

export const COMMAND_CREATE_FOLDER = command('create.folder');
export const COMMAND_CREATE_FILE = command('create.file');

export const COMMAND_DELETE_SAVED_PASSWORD = command('deleteSavedPassword');

export const COMMAND_TRANSFER_QUEUE_CANCEL = command('transferQueue.cancel');
export const COMMAND_TRANSFER_QUEUE_CLEAR = command('transferQueue.clear');

export const COMMAND_REMOTE_BACKUPS_REFRESH = command('remoteBackups.refresh');
export const COMMAND_REMOTE_BACKUPS_OPEN = command('remoteBackups.open');
export const COMMAND_REMOTE_BACKUPS_RESTORE = command('remoteBackups.restore');
export const COMMAND_REMOTE_BACKUPS_DELETE = command('remoteBackups.delete');

export const COMMAND_CLEAR_CONFLICT_STATE = command('clearConflictState');
