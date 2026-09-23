# SFTP/FTP conflict resolution

Use these tools only for conflicts reported by this extension.

1. Call `conflicts_list`, then `conflicts_get` for the selected conflict. If its status is `capturing`, wait and check again until snapshot preparation reaches `pending` or `reviewing` before reading or editing.
2. Read both sides with `conflicts_read` and inspect `conflicts_diff`.
3. Prepare text-only merged content. Either call `conflicts_submit_local`, or save the file in the editor and call `conflicts_acknowledge_local`.
4. Use the newest returned revision with `conflicts_resolve` and action `upload`. Use action `cancel` to keep the remote file unchanged.
5. Call `conflicts_wait` until it reports `uploaded`, `failed`, `cancelled`, or `stale`. `failed` is not success.

Every mutation is revision checked. If a tool reports `stale`, inspect the refreshed conflict and repeat from the newest revision. Upload is refused until local content has been submitted or acknowledged. Remote content is never changed by submit or acknowledge.

Only workspace-relative conflict files are exposed. Binary content, unavailable snapshots, dirty editor buffers, symbolic links, oversized input, exhausted conflict-state storage, terminal records, and records orphaned by an editor restart cannot be mutated through these tools. Manual conflict resolution remains available.

FTP and SFTP are supported equally. FTPS remains experimental.
