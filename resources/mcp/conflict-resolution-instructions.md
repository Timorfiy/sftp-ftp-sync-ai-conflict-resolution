# SFTP/FTP uploads and conflict resolution for editor agents

This server is registered automatically by
`Timorfiy.sftp-sync-ai` in supported VS Code and Cursor versions. Use the
editor's already-running agent and model. The extension does not provide a
model, AI-provider account, or API key.

Upload saved files with `upload_files`, passing the selected workspace and an
explicit list of relative or absolute file paths. This uses the live extension;
watcher and auto-upload can stay disabled. Active-profile configuration,
exclusions, hooks, backups and conflict checks remain in effect. Save dirty
editor buffers first. Directories, symbolic links and private state are refused.

Only `uploaded` counts confirm successful file transfers. `terminal: false`
means work is unfinished; call `uploads_wait` with the returned `operationId`
instead of resubmitting the batch. A timeout or cancelled wait does not cancel
an accepted transfer. Use Activity to cancel transfers. Operations belong to
one editor session; after a reload, inspect Activity/remote state before retrying.
Successful files without warnings are omitted from the `files` result to save
context. Failed, excluded and cancelled files remain visible. When a conflict
appears, follow the conflict steps below, then resume `uploads_wait` for the batch.

First call `conflicts_workspaces` and select the absolute root matching the
project in your current task. Pass its `bucket` as `workspace` to every upload or conflict
tool, including `conflicts_list`. Never select a different project just because
it has a pending conflict. External MCP discovers all opted-in editor windows
on each call; multiple projects require an explicit selection. If the intended
project is missing, enable `sftp.externalMcp.enable` there and reload that editor
window. A project can be available even when its conflict list is empty.

1. Call `conflicts_list`, then `conflicts_get` for the selected conflict. If its status is `capturing`, wait and check again until snapshot preparation reaches `pending` or `reviewing` before reading or editing.
2. Read both sides with `conflicts_read` and inspect `conflicts_diff`.
3. Prepare text-only merged content. Either call `conflicts_submit_local`, or save the file in the editor and call `conflicts_acknowledge_local`.
4. Use the newest returned revision with `conflicts_resolve` and action `upload`. Use action `cancel` to keep the remote file unchanged.
5. Call `conflicts_wait` until it reports `uploaded`, `failed`, `cancelled`, or `stale`. `failed` is not success.

Every mutation is revision checked. If a tool reports `stale`, inspect the refreshed conflict and repeat from the newest revision. Upload is refused until local content has been submitted or acknowledged. Remote content is never changed by submit or acknowledge.

Only workspace-relative conflict files are exposed. Binary content, unavailable
snapshots, dirty editor buffers, symbolic links, oversized input, exhausted
conflict-state storage, terminal records, and records orphaned by an editor
restart cannot be mutated through these tools. Manual conflict resolution
remains available through the conflict picker.

FTP and SFTP are supported equally. FTPS remains experimental.
