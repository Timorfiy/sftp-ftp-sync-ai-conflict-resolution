# Troubleshooting

This bundled guide applies equally to plain FTP and SFTP unless a section says
otherwise. FTPS support is experimental: TLS negotiation and certificate
behavior can vary by server.

The extension does not send telemetry or diagnostics. **Copy Diagnostics** copies a small, redacted allowlist containing the failure ID, operation/protocol, retry safety, troubleshooting section, low-level error code/message, and partial-result counts. It never includes connection/config objects, credentials, interactive answers, file contents, or stacks.

## Overview

Keep the Transfer Queue visible after a failed or cancelled operation. Completed, failed, and cancelled entries remain until **Clear Completed** is used.

Only retry operations that the error action explicitly marks safe. Connection, read, list, and staged download operations can be replayed after failure. Upload, delete, restore, and other operations that may already have changed remote data must be inspected before they are started again.

## Configuration

Open `.vscode/sftp.json` and fix the named setting. Check `protocol`, `host`, `port`, `username`, `remotePath`, profiles, and JSON syntax. Plain FTP uses `protocol: "ftp"`; SFTP uses `protocol: "sftp"`. FTPS is selected through FTP secure options and remains experimental.

Existing configurations are not silently migrated. Generated values apply only
when **SFTP: Config** creates a new file. See the tested
[defaults matrix](options.md#generated-values-and-omission-behavior).

## Authentication

Verify the username and the configured credential source. Re-enter prompted passwords, private-key passphrases, or keyboard-interactive answers. Saved credentials are scoped to the endpoint and workspace; deleting one saved credential does not delete unrelated credentials.

Repeated authentication failures are not fixed by transfer retry. Correct the credential or server-side account policy first.

## Network

Check the host, port, DNS, VPN, proxy, Windows Firewall, and server availability. FTP requires both control and data connections; passive-mode data ports can be blocked even when login succeeds. SFTP uses the SSH connection, normally on port 22.

Retry is safe only when no write could have been committed, such as connect, list, read, or staged download. Do not blindly replay an upload after a connection loss.

## Remote paths

Verify `remotePath`, slash direction, letter case, chroot/home-directory behavior, and that the requested item still exists. FTP and SFTP servers can expose a different root than an interactive shell.

## Local paths

Verify the workspace folder, Windows path, free disk space, and antivirus/Controlled Folder Access rules. Downloads are staged before replacing the local destination, so a failed staged download should leave the previous local file intact.

## Permissions

Confirm server ownership and file/directory modes for FTP or SFTP. On Windows, confirm that the editor process can read and write the local path. A permission failure during a write is not automatically retryable because the server may have accepted part of the operation.

## Host keys

SFTP host keys protect server identity. If a saved key changes, stop and verify the new SHA-256 fingerprint through a trusted channel with the server owner. Then remove or update the matching known-host entry manually and reconnect.

The extension never automatically accepts a changed key. Rejecting an unknown
key is treated as cancellation, not a generic transfer failure.

## FTP timestamps

Some FTP servers do not provide an exact `MDTM` modification time. When an exact timestamp is unavailable, the extension cannot safely infer that a remote file is unchanged. Review the conflict and compare captured content before overwriting.

This limitation is specific to FTP metadata. SFTP normally supplies exact timestamps through its file attributes.

## Conflicts

Open the diff, inspect the captured remote snapshot, and choose an explicit
action. Cancelling keeps the remote item unchanged. For the agent path, fetch
context/diff, submit or acknowledge the local merge, resolve the newest
revision, and wait for `uploaded`, `failed`, `cancelled`, or `stale`. On
`stale`, fetch the refreshed revision and review again. Manual fallback remains
available.

Conflict snapshots have separate bounded forensic retention: 90 days, at most
250 inactive/terminal or restart-orphaned records per workspace, 500 MiB total,
and 100 MiB per snapshot. Active decisions are preserved. If a snapshot cannot
fit, it is reported unavailable rather than silently replacing a workspace
file. **SFTP/FTP Sync + AI Conflict Resolution: Clear Conflict State** clears inactive records after
confirmation.

## Overwrite backups

Overwrite backups cover ordinary text files when backups are enabled. Binary or unsupported content is skipped as not applicable, not reported as a failed copy.

Overwrite backup creation is **fail-open**: if a configured backup fails, the upload continues and its transfer result remains truthful. The result includes a warning that the previous remote text content may not be recoverable. Fix backup storage permissions before another overwrite.

## Delete backups

The explicit **Delete Remote** flow with `backup.enabled`, `backup.onDelete`, and positive `backup.versions` is **fail-closed**. Every promised copy is attempted before deletion. If any copy fails, the result reports how many copies were already created and states that nothing was deleted.

This protection is not promised for `syncOption.delete`. Do not infer that bulk sync deletion has the same backup preflight.

## Packaging

Packaging inspection is local and does not publish the extension. A failure reports `packaging.inspection-failed`, a redacted reason, and this section. Rebuild the VSIX after removing forbidden development files or secret canaries. Missing/corrupt VSIX files must also be fixed before inspection can pass.

## Transfers

Inspect the retained queue item and copied diagnostics. Confirm which side contains the desired file before rerunning a write. Upload, delete, backup restore, and remote rename can have changed remote state even if the final response was interrupted.

Safe automatic recovery is limited to connection/read/list operations and staged downloads. FTP and SFTP follow the same no-blind-write-retry rule.

## Partial results

An operation summary reports deterministic completed, failed, cancelled, not-started, and warning counts. Earlier attempts remain part of the same operation result when a safe retry is made.

Cancelling marks queued work as cancelled instead of dropping it. Review completed items before starting again: cancellation does not roll back transfers that already finished.
