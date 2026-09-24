# Editor settings

Open **File → Preferences → Settings** on Windows and search for `SFTP`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `sftp.printDebugLog` | `false` | Write protocol debug output to the SFTP output channel after reload. |
| `sftp.debug` | `false` | Compatibility alias for debug output; requires reload. |
| `sftp.downloadWhenOpenInRemoteExplorer` | `false` | Download for local editing instead of opening read-only remote content. |
| `sftp.suppressPlaintextPasswordWarning` | `false` | Hide the local plaintext-config warning. It does not make plaintext credentials safe. |

Prefer Secret Storage over a plaintext `password` or `passphrase` in
`.vscode/sftp.json`. Plain FTP remains unencrypted in transit regardless of
this setting.
