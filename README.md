# SFTP/FTP Sync + AI Conflict Resolution

Standalone Windows file transfer and synchronization for VS Code and Cursor,
with manual and editor-agent conflict resolution.

- **Extension ID:** `Timorfiy.sftp-sync-ai`
- **Version:** `0.1.0`
- **Supported:** Windows 10/11, VS Code Desktop 1.104.0+, Cursor Desktop 3.17.8+
- **Protocols:** SFTP and plain FTP; FTPS is experimental

This is a new Timorfiy extension. It is not an update or migration path for
`PhilipDaoud.sftp-neo`, although it continues to read `.vscode/sftp.json`.

## Install or update

Version 0.1.0 is documented for VSIX installation before first publication.
Do not assume that a Marketplace or Open VSX listing exists.

1. Obtain `sftp-sync-ai-0.1.0.vsix` from the matching product GitHub Release or
   from your release/test coordinator.
2. In VS Code or Cursor, open **Extensions**.
3. Select **… → Install from VSIX…** and choose that file.
4. Open a workspace folder and reload the editor if requested.

To update before registry publication, repeat these steps with the newer VSIX.
The editor replaces the installed extension while leaving your workspace
configuration and Secret Storage values in place. After a registry listing is
actually published, normal editor install/update controls may be used for that
same extension ID.

## Quick start

### 1. Create `.vscode/sftp.json`

Run **SFTP: Config** from the Command Palette. New generated configurations
explicitly enable conflict checking and local text backups, while leaving
watcher deletion, sync deletion, upload-on-save, and other automation off.

Use one of these strict-JSON examples. They intentionally contain no password,
passphrase, private key, or other secret. The extension prompts when a
credential is needed and can save it through the editor's Secret Storage.

#### SFTP

```json
{
  "name": "Production SFTP",
  "host": "sftp.example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "deploy",
  "remotePath": "/var/www/site",
  "uploadOnSave": false,
  "conflictCheck": true,
  "useTempFile": false,
  "openSsh": false,
  "concurrency": 4,
  "watcher": {
    "files": false,
    "autoUpload": false,
    "autoDelete": false,
    "autoRename": false
  },
  "syncOption": {
    "delete": false,
    "skipCreate": false,
    "ignoreExisting": false,
    "update": false
  },
  "ignore": [
    ".vscode",
    ".git",
    ".github",
    ".env",
    ".env.*",
    "*.log",
    "*.tmp",
    "*.bak"
  ],
  "backup": {
    "enabled": true,
    "location": "local",
    "folder": ".vscode/sftp-backup",
    "versions": 100,
    "onDelete": false
  }
}
```

#### Plain FTP

```json
{
  "name": "Production FTP",
  "host": "ftp.example.com",
  "protocol": "ftp",
  "port": 21,
  "username": "deploy",
  "remotePath": "/public_html",
  "secure": false,
  "uploadOnSave": false,
  "conflictCheck": true,
  "useTempFile": false,
  "openSsh": false,
  "concurrency": 1,
  "watcher": {
    "files": false,
    "autoUpload": false,
    "autoDelete": false,
    "autoRename": false
  },
  "syncOption": {
    "delete": false,
    "skipCreate": false,
    "ignoreExisting": false,
    "update": false
  },
  "ignore": [
    ".vscode",
    ".git",
    ".github",
    ".env",
    ".env.*",
    "*.log",
    "*.tmp",
    "*.bak"
  ],
  "backup": {
    "enabled": true,
    "location": "local",
    "folder": ".vscode/sftp-backup",
    "versions": 100,
    "onDelete": false
  }
}
```

Plain FTP sends credentials and content without transport encryption. Use it
only on a network and server you trust. `secure: true`, `"control"`, and
`"implicit"` select FTPS modes, but FTPS is experimental in this release.

Existing configuration files are **not migrated**. Omitting a property retains
legacy runtime behavior: notably `conflictCheck` is `false`, backups are
disabled with remote storage selected, `downloadOnOpen` is `false`, and the
user `ignore` list is empty. The safe values above are explicit generated
template values, not changed omission defaults. See [Options](docs/options.md).

### 2. Test the connection

Run **SFTP: Test Connection**. Despite the command category, it supports both
FTP and SFTP.

The probe validates the configuration, credentials, connection, `remotePath`,
and list/read access. It does not upload, overwrite, rename, or delete remote
content. Fix the reported category before continuing. For SFTP, verify the
first host-key fingerprint through a trusted channel; a later host-key change
is rejected rather than silently accepted.

### 3. Make the first transfer

Use a disposable file first.

1. Create and save a local text file in the configured workspace.
2. Right-click it and choose **SFTP: Upload File**.
3. In **Remote Explorer**, find the uploaded file.
4. Change the remote test file, then choose **SFTP: Download File** only when
   you intend to replace the local copy.
5. Keep the **Transfer Queue** visible until the operation reaches a terminal
   result. Cancellation does not roll back files already completed.

### 4. Run the primary sync

Use **SFTP: Sync Remote → Local** for the primary first-release bulk-sync path.
It can overwrite local files. A successful replacement does not create an
extension recovery version, so commit or copy important local work first.

**SFTP: Sync Local → Remote** always shows a modal before hooks, connection,
listing, or mutation. It names the profile and both paths. **Cancel** changes
nothing; **Continue** may overwrite many remote files. If
`syncOption.delete` is enabled, the modal also names the side whose
destination-only files will be recursively deleted.

**SFTP: Sync Both Directions** writes both sides according to modification
times and can overwrite local and remote files. It is not a merge operation
and does not apply `syncOption.delete`.

Keep `syncOption.delete: false` unless you have independently verified both
trees. `backup.onDelete` does not protect sync deletions, so no recovery copy
is promised for `syncOption.delete`.

## Resolve upload conflicts

With `conflictCheck: true`, an upload is blocked when the remote file changed,
the previous baseline is missing, or an FTP server cannot provide a safe exact
timestamp.

### Manual path

The conflict picker offers:

- **Open Diff** to compare the captured remote version with the local file;
- **Overwrite** for this file;
- **Overwrite All** for remaining conflicts in this transfer batch;
- **Cancel upload** to leave the remote file unchanged; and
- **Troubleshoot** for the bundled recovery guide.

Review the diff before overwriting. Every decision is revision checked; if
either side changes during review, use the refreshed conflict instead of
forcing an old decision.

### Editor-agent path

The extension automatically registers its conflict MCP/tools in supported
VS Code and Cursor versions. It does not embed a model, manage an AI provider,
or require an extension-owned API key. Start or reuse an editor agent that is
already available in your editor, then ask it to resolve a conflict reported
by this extension.

The agent should:

1. list conflicts and fetch the selected conflict context;
2. wait for capture to reach `pending` or `reviewing`;
3. read the local and captured remote text and inspect the diff;
4. prepare merged local content, or save a merge and acknowledge that file;
5. resolve using the newest revision;
6. wait for `uploaded`, `failed`, `cancelled`, or `stale`; and
7. on `stale`, fetch the refreshed revision and review again.

`failed` is not success. If a snapshot is unavailable, a file is binary, the
editor buffer is dirty, storage limits prevent a recovery snapshot, or the
agent flow otherwise cannot proceed, return to the manual path. The bundled
[agent instructions](resources/mcp/conflict-resolution-instructions.md)
describe the exact tool sequence.

## Recovery

- **Remote overwrite backups:** New configurations keep up to 100 versions per
  file in `.vscode/sftp-backup`. Only recognized or sampled text/source
  content is covered. Binary content is skipped.
- **Overwrite failure:** Backup creation is fail-open. An upload can succeed
  with a warning even if its recovery copy failed.
- **Explicit Delete Remote:** With `backup.enabled`, `backup.onDelete`, and a
  positive version count, backup preflight is fail-closed. If any promised
  copy fails, nothing is deleted.
- **Sync deletion:** `syncOption.delete` has no backup promise.
- **Remote → Local replacement:** No extension recovery version is retained
  after a successful replacement.
- **Conflict recovery state:** Stored privately outside the project and never
  synchronized. Inactive state is retained for up to 90 days, up to 250
  inactive/terminal or restart-orphaned records per workspace, 500 MiB total,
  and 100 MiB per snapshot. Active decisions are preserved. If a snapshot
  cannot fit, it is explicitly unavailable.
- **Clear state:** Run **SFTP/FTP Sync + AI Conflict Resolution: Clear Conflict State**. The command requires
  confirmation and preserves active decisions.

See [Troubleshooting](docs/troubleshooting.md) for configuration,
authentication, network, path, permission, host-key, timestamp, backup, and
partial-result recovery.

## Security and privacy

### Secure password storage

- Keep credentials out of `.vscode/sftp.json`. Passwords and passphrases can be
  stored with the editor's Secret Storage, backed by Windows credential
  protection.
- Saved credentials are scoped by workspace, protocol, normalized host,
  effective port, username, and credential type. Use **SFTP: Delete Saved
  Password** to remove one.
- Plain FTP is not transport-encrypted. Secret Storage protects local storage,
  not network traffic.
- SFTP host-key changes are rejected. Verify a changed fingerprint with the
  server owner before removing the saved key.
- The extension sends no telemetry. Diagnostics are local, redacted, and
  intentionally exclude secrets and file contents.
- Hooks are shell commands from your workspace configuration. Review them
  before running a configuration you did not author.

## Limitations

- Only Windows 10/11 and the editor versions listed above are qualified for
  0.1.0. macOS, Linux, browser editors, remote-only editor variants, and older
  editor versions are outside the release promise.
- SFTP and plain FTP are supported. FTPS is experimental.
- Bulk sync has no preview/dry-run mode in 0.1.0.
- Conflict-agent mutation is text-only and requires an already-running editor
  agent. Manual resolution remains available.
- Backups are not a universal undo system; observe the exact boundaries in
  [Recovery](#recovery).

## Reference and support

- [Configuration options](docs/options.md)
- [Commands](docs/commands.md)
- [Troubleshooting](docs/troubleshooting.md)
- [FAQ](FAQ.md)
- [Product issues](https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/issues)
- [Product releases](https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/releases)

When opening an issue, include extension/editor/Windows versions, protocol,
operation, redacted diagnostics, and reproduction steps. Never include
passwords, passphrases, private keys, tokens, or confidential file content.

## Attribution

This standalone product contains work descended from SFTP Neo and earlier
vscode-sftp projects. Their historical links remain in the inherited changelog
for attribution; current documentation and support belong to this product.
