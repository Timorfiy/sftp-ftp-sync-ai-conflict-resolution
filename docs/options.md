# Configuration options

Version 0.8.3 reads one configuration object, an array of configuration
objects, and optional profiles from `.vscode/sftp.json`. SFTP and FTP are the
supported protocols. Runtime-only protocol values are not part of the
first-release contract.

Start with the strict-JSON examples in the [quick start](../README.md#quick-start).
Do not put passwords, passphrases, private keys, or tokens in examples or a
committed workspace file.

## Generated values and omission behavior

**SFTP: Config** writes explicit safety values only for a new file. It never
rewrites an existing configuration.

| Setting | New generated file | If omitted by an existing file | Schema default |
| --- | --- | --- | --- |
| `protocol` | `"sftp"` | `"sftp"` | `"sftp"` |
| `port` | `22` | SFTP `22`; FTP `21` | protocol-specific |
| `remotePath` | `"/"` | `"./"` | `"./"` |
| `uploadOnSave` | `false` | `false` | `false` |
| `conflictCheck` | `true` | `false` | `false` |
| `downloadOnOpen` | omitted | `false` | `false` |
| `ignore` | explicit safety list | `[]` plus internal exclusions | `[]` |
| `watcher.*` | all disabled | watcher absent/disabled | disabled |
| `syncOption.*` | all `false` | absent/`false` | `false` |
| `backup.enabled` | `true` | `false` | `false` |
| `backup.location` | `"local"` | `"remote"` | `"remote"` |
| `backup.folder` | `".vscode/sftp-backup"` | same | same |
| `backup.versions` | `100` | `100` | `100` |
| `backup.onDelete` | `false` | `false` | `false` |
| `concurrency` | `4` | `4`; FTP is forced to `1` | `4` |
| `connectTimeout` | omitted | `10000` ms | `10000` |
| `keepalive` | omitted | SFTP `30000` ms; FTP disabled | protocol-specific |
| `secure` | FTP example `false` | `false` | `false` |

The generated ignore list is a template choice, not the runtime default.
`.vscode` and private conflict state are excluded internally even when
`ignore` is empty.

New configurations let you choose a [stack-specific ignore template](ignore-templates.md).
Use **SFTP: Apply Ignore Template** to add rules to an existing configuration.

## Common connection fields

| Property | Type | Behavior |
| --- | --- | --- |
| `name` | string | Optional display name. |
| `context` | string | Local path relative to the workspace root. Defaults to the workspace root. |
| `protocol` | `"sftp"` or `"ftp"` | Defaults to SFTP. |
| `host` | string | Required server hostname or IP address. |
| `port` | integer 1–65535 | Omission resolves to 22 for SFTP or 21 for FTP. |
| `username` | string | Required username. |
| `password` | string or `null` | Prefer omission/`null`; Secret Storage and prompting are used. |
| `remotePath` | string | Remote root. Runtime omission is `"./"`. |
| `connectTimeout` | non-negative integer | Connection timeout in milliseconds; default 10000. |
| `remoteTimeOffsetInHours` | number | Remote time minus local time; default 0. |
| `concurrency` | positive integer | Default 4 for SFTP; FTP is serialized to 1. |
| `remote` | string | Optional reference to a `remotefs.remote` editor setting. |

`name` is not required by runtime validation. For an array of connections, the
configuration with the longest matching `context` handles a local path.

## SFTP

| Property | Type | Behavior |
| --- | --- | --- |
| `agent` | string or `null` | SSH agent socket or `"pageant"`. |
| `privateKeyPath` | string or `null` | Path to an SSH private key. |
| `passphrase` | string, `true`, or `null` | `true` forces a prompt. Prefer Secret Storage. |
| `interactiveAuth` | boolean or string array | Keyboard-interactive authentication. |
| `algorithms` | object | `ssh2` transport algorithm overrides. Omit unless required. |
| `sshConfigPath` | string | OpenSSH config path; the platform home-file path is used when omitted. |
| `sshCustomParams` | string | Extra command used only by **Open SSH in Terminal**. |
| `hop` | object or object array | SSH connection chain. Each hop needs explicit usable authentication. |
| `limitOpenFilesOnRemote` | boolean or number | `false`/omitted disables; `true` uses 222; a number is clamped to at least 127. |
| `keepalive` | non-negative integer | Milliseconds. Omission uses 30000 for SFTP; `0` disables. |

SFTP host keys are scoped to workspace, host, and port. A changed key is
rejected. Verify the new fingerprint through a trusted channel before changing
the stored record.

## FTP and experimental FTPS

| Property | Type | Behavior |
| --- | --- | --- |
| `secure` | boolean, `"control"`, or `"implicit"` | `false` is plain FTP. `true` is explicit TLS. `"control"` currently maps to full explicit TLS. `"implicit"` selects implicit TLS. FTPS is experimental. |
| `secureOptions` | object or `null` | Options passed to Node.js TLS. |
| `passive` | boolean | Accepted compatibility property; the current client manages passive transfers internally. |
| `networkInterface` | string or `null` | Bind FTP control/passive sockets to a named IPv4 adapter; see [network interface selection](network-interface.md). |
| `ftpKeepAliveInterval` | non-negative integer | FTP NOOP interval in milliseconds. Omission or `0` disables it. Overrides common `keepalive`. |
| `ftpReconnectAttempts` | non-negative integer | Retry count for safely restartable FTP transfers. Omission is `0`. |
| `keepalive` | non-negative integer | Used by FTP only when `ftpKeepAliveInterval` is omitted. Omission disables FTP keepalive. |

Plain FTP does not encrypt credentials or content. Secret Storage protects only
the locally retained credential.

## Transfer and conflict behavior

| Property | Type | Default |
| --- | --- | --- |
| `uploadOnSave` | boolean | `false` |
| `conflictCheck` | boolean | `false` when omitted; generated as `true` |
| `useTempFile` | boolean | `false` |
| `openSsh` | boolean | `false`; requires SFTP/OpenSSH and `useTempFile` |
| `downloadOnOpen` | boolean or `"confirm"` | `false` |
| `filePerm` | number | omitted |
| `dirPerm` | number | omitted |

`conflictCheck` compares exact remote modification time and byte size against
the last observed baseline. It blocks when the remote changed, the baseline is
missing, or FTP cannot provide a safe timestamp. It is intentionally
incompatible with Local-to-Remote `syncOption.delete`.

## Ignore and watcher

```json
{
  "ignore": [
    ".git",
    ".env",
    "*.log"
  ],
  "ignoreFile": ".gitignore",
  "watcher": {
    "files": "**/*",
    "autoUpload": false,
    "autoDelete": false,
    "autoRename": false
  }
}
```

`watcher.files` accepts a glob, `false`, or `null`. `autoDelete` is destructive:
local deletion can recursively delete remote content. `autoRename` covers
renames performed through the editor, not arbitrary terminal/Git filesystem
changes.

## Sync options

```json
{
  "syncOption": {
    "delete": false,
    "skipCreate": false,
    "ignoreExisting": false,
    "update": false
  }
}
```

- `delete` removes destination-only items. Its direction depends on the sync
  command and it is not protected by `backup.onDelete`.
- `skipCreate` does not create destination items.
- `ignoreExisting` skips items already present at the destination.
- `update` replaces an existing destination only from a newer source.

Local-to-Remote sync always requires modal confirmation. Both Directions writes
both sides, compares modification times, and does not use `delete`.

## Backups

```json
{
  "backup": {
    "enabled": true,
    "location": "local",
    "folder": ".vscode/sftp-backup",
    "versions": 100,
    "onDelete": false
  }
}
```

`versions` is a non-negative integer and is a hard per-file limit. Backup
coverage is text/source content only. Binary or unsupported content is skipped.

- Before remote overwrite, backup creation is **fail-open**: transfer may
  continue with a warning.
- Explicit remote deletion with `onDelete` is **fail-closed**: all promised
  copies must succeed before anything is deleted.
- `syncOption.delete` has no backup promise.
- Successful Remote-to-Local replacement retains no extension recovery
  version.

The backup folder is automatically excluded from transfer and Remote Explorer.

## Remote Explorer

```json
{
  "remoteExplorer": {
    "filesExclude": [],
    "order": 0,
    "enableDragAndDrop": false
  }
}
```

Drag-and-drop performs server-side rename and refuses overwrite or
cross-configuration moves.

## Hooks

```json
{
  "hooks": {
    "preUpload": "npm.cmd test",
    "postUpload": "",
    "preDownload": "",
    "postDownload": "",
    "preSync": "",
    "postSync": ""
  }
}
```

Each non-empty value is a shell command run from the workspace root with a
30-second timeout. A failing pre-hook stops the operation; a failing post-hook
cannot undo completed work. Review hooks before using configuration from
another person or repository.

## Profiles

`profiles` contains named override objects and `defaultProfile` selects one.
Profiles inherit the top-level connection, then override specified values.
`ignore` is appended; object options such as `watcher` are replaced as a whole.

```json
{
  "name": "Site",
  "host": "sftp.example.com",
  "protocol": "sftp",
  "username": "deploy",
  "remotePath": "/var/www/site",
  "defaultProfile": "staging",
  "profiles": {
    "staging": {
      "host": "staging.example.com",
      "remotePath": "/var/www/staging"
    }
  }
}
```

## Security notes

- Prefer Secret Storage; saved credentials are scoped by workspace, transport,
  normalized host, effective port, username, and credential type.
- Never commit plaintext credentials, private keys, or tokens.
- Keep destructive watcher and sync deletion disabled until tested.
- The extension sends no telemetry.
- Conflict state is private from transfer and bounded as documented in
  [Recovery](../README.md#recovery).
