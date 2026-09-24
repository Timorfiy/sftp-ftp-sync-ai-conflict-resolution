# Frequently asked questions

## Where is the configuration?

The workspace configuration is `.vscode/sftp.json`. Run **SFTP: Config** to
create the safe 0.1.0 template. Existing files are opened without migration.

## Why am I asked for a password?

The examples deliberately contain no credentials. Enter the password when
prompted and choose the Secret Storage option if you want the editor to retain
it securely. Saved values are scoped to the workspace and endpoint. Remove one
with **SFTP: Delete Saved Password**.

## Is FTP secure?

Plain FTP is not encrypted; credentials and content can be observed in transit.
Use only a trusted network/server. SFTP is the qualified encrypted protocol.
FTPS settings exist but are experimental in version 0.1.0.

## Why did Test Connection pass but an upload fail?

Test Connection is read-only. It proves configuration, authentication,
connectivity, `remotePath`, and list/read access without writing. Upload also
needs write permission and may be stopped by conflict checks, hooks, backups,
or a changed connection.

## Why was an upload blocked as a conflict?

With `conflictCheck: true`, the extension refuses to assume that an existing
remote file is safe to overwrite when its metadata changed, no baseline exists,
or an FTP timestamp is unavailable. Open the diff, merge if needed, and make a
new revision-checked decision. See [Conflict recovery](docs/troubleshooting.md#conflicts).

## Does AI resolve conflicts automatically?

The extension exposes tools to an already-running supported VS Code or Cursor
agent. It does not include a model or own an AI API key. The agent must inspect
context/diff, prepare or acknowledge the local merge, resolve the newest
revision, and wait for a terminal upload result. Manual resolution is always
available.

## Can sync delete files?

Only when `syncOption.delete` is explicitly `true`. The warning names the
destination side before sync starts. `backup.onDelete` does not cover these
sync deletions, so there is no promised undo.

## What do backups cover?

Enabled overwrite backups cover text/source files. Binary content is skipped,
and overwrite backup failure does not block the upload. Explicit Delete Remote
can be fail-closed when `backup.onDelete` is enabled. Remote-to-Local
replacement and `syncOption.delete` have no extension recovery version.

## How do I upload a folder's contents without the folder itself?

Set `context` to that local folder and `remotePath` to the desired destination:

```json
{
  "name": "Built site",
  "context": "build",
  "host": "sftp.example.com",
  "protocol": "sftp",
  "port": 22,
  "username": "deploy",
  "remotePath": "/var/www/site",
  "conflictCheck": true
}
```

Then upload or sync paths inside `build`.

## Why are remote dotfiles missing?

The server controls directory listings. Verify its FTP/SFTP listing policy,
then check `remoteExplorer.filesExclude` and your ignore rules. The extension
does not provide a portable switch that forces every server to show dotfiles.

## Where do I get help?

Read [Troubleshooting](docs/troubleshooting.md), copy redacted diagnostics when
offered, then open a [product issue](https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/issues).
Do not post credentials, keys, tokens, or confidential content.
