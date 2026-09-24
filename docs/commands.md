# Commands

Command IDs use the private `sftpSyncAI` namespace. Commands currently appear
under the **SFTP** Command Palette category for compatibility, but operate on
either protocol unless explicitly SFTP-only.

## Setup and connection

- **Config** — Create the safe `.vscode/sftp.json` template, or open an
  existing file without changing it.
- **Test Connection** — Read-only validation of configuration, credentials,
  connection, `remotePath`, and list/read permission. Plain FTP requires a
  transport warning confirmation.
- **Set Profile** — Select a configured profile.
- **Delete Saved Password** — Remove an endpoint-scoped password/passphrase or
  a selectable legacy value.
- **Select Network Interface** — Select a named IPv4 adapter for FTP only.
- **Open SSH in Terminal** — SFTP-only interactive SSH terminal command.

## Transfer

- **Upload File/Folder/Active File/Active Folder/Project** — Copy local content
  to the remote side. Existing files may invoke conflict handling and backups.
- **Download File/Folder/Active File/Active Folder/Project** — Copy remote
  content to the local side. A successful replacement has no extension
  recovery version.
- **Upload Changed Files** — Upload Git working-tree/index changes. The default
  shortcut is `Ctrl+Alt+U`.
- **Force Upload / Force Download** — Ignore user ignore rules. Internal
  configuration and conflict-state exclusions still apply.
- **Cancel All Transfers** — Cancel queued/active work. Completed transfers are
  not rolled back.

## Sync

### Sync Remote → Local

The primary bulk path. It can overwrite local content. If
`syncOption.delete` is enabled, a modal warns that destination-only local
content will be deleted. Successful local replacements have no extension
recovery version.

### Sync Local → Remote

Always requires modal confirmation before hooks, connection, listing, or
mutation. The dialog names the connection/profile, local source, remote
destination, overwrite risk, text-only/fail-open backup boundary, and any
remote deletion enabled by `syncOption.delete`. Cancel changes nothing.

### Sync Both Directions

Writes both sides according to modification times. It can overwrite local and
remote content, is not a merge, and does not apply `syncOption.delete`.

See [sync options](options.md#sync-options).

## Compare and browse

- **Diff with Remote / Diff Active File with Remote** — Compare local and
  remote content.
- **List / List Active Folder / List All** — List remote paths.
- **Filter Remote Explorer** — Filter only items already loaded in the tree.
- **Clear Remote Explorer Filter** — Restore the loaded tree.
- **Reveal in Explorer / Reveal in Remote Explorer** — Locate the matching
  local or remote item.
- **View Content / Edit in Local** — Open remote content read-only or download
  it for local editing.

## Remote mutation

- **Rename Remote** — Server-side rename/move. It refuses overwrite.
- **Delete Remote** — Recursive remote delete after confirmation. With enabled
  `backup.onDelete`, promised text-file copies are fail-closed before deletion.
- **Create File / Create Folder** — Create remote content.

## Backups

- **Refresh Backups**, **Open Backup**, **Restore Backup**, **Delete Backup** —
  Manage configured text/source backups. Restore itself can overwrite remote
  content; inspect the current version first.

## Conflict state

**Clear Conflict State** removes completed, cancelled, failed, and
restart-orphaned records after modal confirmation. Active decisions are
preserved. Inactive state is bounded to 90 days, 250 records per workspace,
500 MiB total, and 100 MiB per snapshot.

## Troubleshooting

**Open Troubleshooting** opens the bundled [recovery guide](troubleshooting.md)
at the relevant section.
