<p align="center">
  <img src="resources/icon.png" width="112" height="112" alt="SFTP/FTP Sync logo">
</p>

# SFTP/FTP Sync + AI Conflict Resolution

Upload, download, and sync your project over **SFTP or FTP** from VS Code and
Cursor. Browse remote files, review changes before overwriting, and resolve
upload conflicts yourself or with your editor's AI agent.

[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Marketplace-install-007ACC)](https://marketplace.visualstudio.com/items?itemName=Timorfiy.sftp-sync-ai)
[![Open VSX](https://img.shields.io/open-vsx/v/Timorfiy/sftp-sync-ai?label=Open%20VSX)](https://open-vsx.org/extension/Timorfiy/sftp-sync-ai)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**[Install](#install-or-update)** · **[Quick start](#quick-start)** ·
**[Configuration](#configuration-examples)** · **[Daily use](#everyday-workflows)** ·
**[Conflicts](#resolve-upload-conflicts)** · **[Help](#troubleshooting)**

## What you can do

- **Transfer files and folders.** Upload a single change, download an existing
  site, or sync a whole project in either direction.
- **Work from the sidebar.** Browse remote files, compare them with local
  copies, and follow progress in the Transfer Queue.
- **Catch remote changes.** With conflict checking enabled, uploads pause when
  the server copy has changed or cannot be verified against a known version.
- **Use your existing AI agent.** Give it the conflict's local and remote
  versions through the extension's MCP tools, then let it merge and upload.
- **Choose what gets transferred.** Use 15 ignore templates for common stacks,
  switch connection profiles, or upload only Git changes.
- **Keep previous remote text versions.** New configurations enable local
  overwrite backups with up to 100 versions per file. See [recovery limits](#recovery).

Regular transfers and manual conflict resolution work without AI.

## Install or update

| Editor | Install |
| --- | --- |
| VS Code | [Open in Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Timorfiy.sftp-sync-ai) |
| Cursor | [Open VSX listing](https://open-vsx.org/extension/Timorfiy/sftp-sync-ai), or search Extensions for `Timorfiy.sftp-sync-ai` |
| Either editor, using a file | Download the `.vsix` from [GitHub Releases](https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/releases/latest), then use **Extensions → … → Install from VSIX…** |

Check the publisher is **Timorfiy** and the extension ID is `Timorfiy.sftp-sync-ai`.
Registry installations use the editor's update controls. For a manual update,
install the newer VSIX the same way; your workspace configuration and saved
credentials are retained. Release versions can differ between channels.

**Supported:** Windows 10/11 · VS Code Desktop 1.104.0+ · Cursor Desktop 3.17.8+.
SFTP and plain FTP are supported; FTPS is experimental. See [limitations](#limitations).

## Quick start

### 1. Open a folder and create the configuration

Open your local project folder in the editor. If the project is already on the
server, start with an empty local folder.

Press **Ctrl+Shift+P**, run **SFTP: Config**, and choose your stack's ignore
template, or **Basic**. Edit the generated `.vscode/sftp.json`:

| Field | SFTP example | FTP example |
| --- | --- | --- |
| `host` | `sftp.example.com` | `ftp.example.com` |
| `protocol` | `"sftp"` | `"ftp"` |
| `port` | `22` | `21` |
| `username` | `deploy` | `deploy` |
| `remotePath` | `/var/www/site` | `/public_html` |

Use the remote directory exposed by your hosting account. It may differ from
the path you see in an SSH shell. The workspace folder maps to `remotePath`;
[`context`](docs/options.md#common-connection-fields) lets you map a subfolder instead.

Leave the password out: the extension prompts when needed and can save it in
the editor's Secret Storage. For SSH keys, see [SFTP options](docs/options.md#sftp).
Copyable [complete SFTP and FTP examples](#configuration-examples) are below.

New configurations enable conflict checks and local text backups. Upload on
save, automatic watcher actions, and sync deletion start **off**. Review the
chosen ignore rules: excluded paths are skipped in both transfer directions.

### 2. Test the connection

Save the configuration and run **SFTP: Test Connection**. It checks credentials,
the connection, `remotePath`, and list/read access without changing remote files.
For the first SFTP connection, verify the host-key fingerprint with your server
provider before accepting it.

Commands use the **SFTP:** prefix for **both SFTP and FTP**.

### 3. Make your first transfer

**The project is already on the server:** run **SFTP: Sync Remote → Local** to
download it into your local folder. Start here before editing an existing site.

> **Downloads can overwrite local work.** Commit or copy anything you need
> before downloading into a non-empty folder. A successful local replacement
> does not retain an extension recovery version.

**You want to upload local work:** start with one disposable text file.
Right-click it in the local Explorer and choose **SFTP: Upload File**. Check it
in the **SFTP/FTP** sidebar before uploading a whole project.

Keep the sidebar's **Transfer Queue** open until the operation finishes. A saved
file is not proof of a completed upload. Cancelling does not undo completed transfers.

## Configuration examples

Each example is a complete `.vscode/sftp.json` for one connection, with the
full **Basic** ignore list. Replace the example connection details with yours.
Use **SFTP: Config** to generate a configuration with a stack-specific template.

### SFTP

<details>
<summary><strong>SFTP — complete configuration</strong></summary>

```json
{
  "name": "My SFTP Server",
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
    ".idea",
    ".DS_Store",
    "Thumbs.db",
    ".env",
    ".env.*",
    "AGENTS.md",
    "CLAUDE.md",
    ".claude",
    ".cursor",
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

</details>

### Plain FTP

<details>
<summary><strong>FTP — complete configuration</strong></summary>

```json
{
  "name": "My FTP Server",
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
    ".idea",
    ".DS_Store",
    "Thumbs.db",
    ".env",
    ".env.*",
    "AGENTS.md",
    "CLAUDE.md",
    ".claude",
    ".cursor",
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

</details>

**Plain FTP sends credentials and file content without encryption.** Prefer
SFTP when your host supports it. FTPS modes are [experimental](docs/options.md#ftp-and-experimental-ftps).

**Already have a configuration?** It is not rewritten automatically. In an
existing file, omitting `conflictCheck` leaves it `false`, and omitting
`backup.enabled` leaves backups disabled. The examples set these explicitly.
See the [generated values and omission defaults](docs/options.md#generated-values-and-omission-behavior).

## Everyday workflows

Open the Command Palette with **Ctrl+Shift+P**. File and folder actions are also
available from Explorer context menus.

| I want to… | Use |
| --- | --- |
| Upload the file I am editing | **SFTP: Upload Active File** |
| Download the server copy of a file | **SFTP: Download File** — replaces the local copy |
| Compare before uploading | **SFTP: Diff Active File with Remote** |
| Upload Git working-tree/index changes | **SFTP: Upload Changed Files** · **Ctrl+Alt+U** |
| Browse the server and track transfers | **SFTP/FTP** sidebar → **Explorer** / **Transfer Queue** |
| Switch a configured environment | **SFTP: Set Profile** |
| Add exclusions for my stack | **SFTP: Apply Ignore Template** |
| Stop queued or active transfers | **SFTP: Cancel All Transfers** |

### Upload automatically

After checking a manual transfer, set `uploadOnSave` to `true` if you want
editor saves to upload. Keep `conflictCheck: true` to detect remote changes.

For files written by build tools or other applications, configure the
[file watcher](docs/options.md#ignore-and-watcher). Watcher uploads, deletions,
and renames are separate opt-in settings.

### Ignore files for your stack

**SFTP: Apply Ignore Template** adds exclusions to an existing connection or
profile while preserving your current rules and other settings. Save pending
configuration edits before running it.

Templates cover Basic, Bitrix, WordPress, PHP/Composer, Laravel, Yii2, Node.js,
React/Vue/Vite, Next.js, Nuxt, Python, Go, Java, .NET, and Ruby/Rails.
See [all templates and exact rules](docs/ignore-templates.md).

Transfer exclusions differ from Git exclusions: built files and dependencies
may be needed on your server. Templates keep deployable output where appropriate.
The Bitrix template is for an **existing site**: it excludes the root `/bitrix`
and `/upload` directories while keeping custom code under `local`.

### Sync a folder or project

| Command | What changes |
| --- | --- |
| **SFTP: Sync Remote → Local** | Creates or overwrites local files from the server. |
| **SFTP: Sync Local → Remote** | Creates or overwrites remote files from your local folder. |
| **SFTP: Sync Both Directions** | Writes both sides based on modification times. It does not merge file contents. |

> **Bulk upload:** **Sync Local → Remote** may overwrite many remote files.
> The command always asks for confirmation before connecting or running hooks.
> Check the profile and both paths in the dialog. **Cancel** changes nothing.

Keep `syncOption.delete: false` unless you intend to delete destination-only
files. When enabled, Remote → Local deletes them **locally**; Local → Remote
deletes them **on the server**. These deletions have no backup guarantee.
Local → Remote deletion cannot be combined with `conflictCheck: true`.
Both Directions does not apply `syncOption.delete`.

There is no sync preview or dry-run mode. See [sync options](docs/options.md#sync-options).

## Resolve upload conflicts

With `conflictCheck: true`, an upload pauses if the remote file changed since
the last known version, no baseline exists, or an FTP server cannot provide
an exact timestamp. Choose how to handle that file:

### Resolve manually

| Action | Result |
| --- | --- |
| **Open Diff** | Compare the captured remote version with your local file. |
| **Overwrite** | Replace this remote file with the local version. |
| **Overwrite All** | Apply overwrite to the remaining conflicts in this transfer batch. |
| **Cancel upload** | Leave the remote file unchanged. |
| **Troubleshoot** | Open the bundled recovery guide. |

Review the diff before overwriting. If either side changes during review, the
extension refreshes the conflict instead of applying an outdated decision.

### Resolve with your editor's agent

The extension automatically registers conflict tools through **MCP (Model
Context Protocol)** in supported VS Code and Cursor versions. Use an agent
in that editor with access to those tools; your agent's normal account and
model setup still apply. The extension itself needs no AI-provider API key.

With a conflict pending, ask your agent:

> Resolve the pending SFTP/FTP upload conflict. Read both versions and the
> diff, preserve the remote changes and my intended local edits, upload the
> merged result, and wait for `uploaded` before continuing.

The tools let the agent inspect both versions, submit or acknowledge a local
merge, and resume the upload against the latest revision. **Only `uploaded`
confirms success**; a failed upload or stale revision still needs attention.

Agent merging is text-only. If the file is binary, snapshots are unavailable,
or the editor buffer is dirty, use the manual path. See the
[full agent instructions](resources/mcp/conflict-resolution-instructions.md)
for tool names, revision handling, and terminal statuses.

## Recovery

New configurations store previous remote text/source versions in
`.vscode/sftp-backup`, keeping up to 100 versions per file. The **Backups** view
provides **Open Backup** and **Restore Backup**. Inspect the current remote file
before restoring: restore can overwrite it.

| Operation | Recovery coverage |
| --- | --- |
| Overwrite a remote text/source file | Backed up when enabled. A backup failure warns but **does not block the upload**. |
| Overwrite binary content | Not covered by text backups. |
| Explicit **Delete Remote** | With backups enabled, `backup.onDelete: true`, and a positive version count, promised text backups must succeed before deletion. |
| Delete through `syncOption.delete` | No backup guarantee. |
| Successfully replace a local file by downloading | No extension recovery version retained. |
| Cancel a transfer operation | Completed transfers are not rolled back. |

Conflict snapshots are stored privately outside the project and are never
synchronized. They have [separate retention limits](docs/troubleshooting.md#conflicts).
To clear inactive records, run
**SFTP/FTP Sync + AI Conflict Resolution: Clear Conflict State**; active decisions
are preserved.

## Security and privacy

### Secure password storage

Keep passwords and passphrases out of `.vscode/sftp.json`. The extension can
save them in the editor's Secret Storage with Windows credential protection,
scoped to the workspace and connection. Use **SFTP: Delete Saved Password** to
remove a saved credential. Secret Storage does not encrypt plain FTP traffic.

- **Server identity:** changed SFTP host keys are rejected. Verify the new
  fingerprint with the server owner before changing a saved key.
- **Transfer exclusions:** `.vscode` and private conflict state are always
  excluded, including from force transfers.
- **Diagnostics:** the extension sends no telemetry. Its local diagnostics
  redact secrets and exclude file contents.
- **AI tools:** when an agent reads conflict content, that content is available
  to the agent and its configured model provider.
- **Hooks:** configured hooks run shell commands. Review them before using
  someone else's configuration.

## Troubleshooting

Start with **SFTP: Test Connection**, or run **SFTP: Open Troubleshooting** to
open the bundled guide.

| Problem | Check |
| --- | --- |
| Cannot connect or authenticate | [Credentials](docs/troubleshooting.md#authentication), host/port, [VPN, firewall, and network](docs/troubleshooting.md#network) |
| Connected, but files are missing | [`remotePath`](docs/troubleshooting.md#remote-paths), selected profile, and [ignore rules](docs/ignore-templates.md) |
| Save does not upload | `uploadOnSave`, ignore rules, and pending conflicts in the editor |
| FTP reports a conflict without a visible change | [Exact FTP timestamps](docs/troubleshooting.md#ftp-timestamps) may be unavailable; compare the captured content |
| Transfer failed or was cancelled halfway | Inspect the Transfer Queue and [partial results](docs/troubleshooting.md#partial-results) before retrying |
| Agent cannot resolve a conflict | Confirm tool access in the same editor, save local edits, and inspect [conflict status](docs/troubleshooting.md#conflicts) |

Need help? [Open an issue](https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/issues)
with extension/editor/Windows versions, protocol, reproduction steps, and
redacted diagnostics. Leave out credentials, private keys, tokens, and
confidential file content.

## Limitations

- Windows 10/11 desktop editors are the supported target. macOS, Linux,
  browser editors, remote-only editor variants, and older editor versions are
  outside the current support scope.
- FTPS is experimental; SFTP and plain FTP are supported.
- Bulk sync has no preview/dry-run and does not merge file contents.
- AI conflict resolution requires an available editor agent with tool access
  and supports text files only.
- Backups have the operation-specific boundaries listed in [Recovery](#recovery).

## Documentation and project

| Reference | Covers |
| --- | --- |
| [Configuration options](docs/options.md) | Connection fields, defaults, SSH keys, profiles, hooks, watcher, and sync behavior |
| [Ignore templates](docs/ignore-templates.md) | Stack-specific exclusions, inheritance, and the complete Bitrix list |
| [Command reference](docs/commands.md) | All setup, transfer, remote file, backup, and conflict commands |
| [Editor settings](docs/setting.md) | Extension settings outside `sftp.json` |
| [FTP network interface](docs/network-interface.md) | Bind FTP to a named network adapter |
| [Troubleshooting](docs/troubleshooting.md) · [FAQ](FAQ.md) | Connection failures, recovery, and common questions |
| [Changelog](CHANGELOG.md) · [Releases](https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/releases) | Changes and downloadable VSIX packages |

## License and attribution

[MIT](LICENSE). Independently maintained by Timorfiy, with code contributions
inherited from SFTP Neo and earlier vscode-sftp projects. See [LICENSE](LICENSE)
and the historical [changelog](CHANGELOG.md) for attribution.
