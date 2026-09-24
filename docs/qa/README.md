# Windows release-candidate qualification

This is maintainer QA, not an extension command or a publication step.
The executable matrix is `test/rc/matrix.js`; its required scenario IDs are the
single source of truth for completeness. Reports live beside this runbook.
Do not sign a row from unit tests, a prior package, or a hidden/mocked UI.

## Requirements and boundaries

- Windows x64 with installed VS Code and Cursor Desktop, Node and `npm ci`.
  Use the documented support floors, and record the actual tested builds.
- A coordinator-issued, non-publishing Release bundle and its exact source,
  run/artifact IDs, size and SHA-256 in `test/rc/candidate.json`.
- A local interactive desktop. Do not run two GUI drivers concurrently.
- Loopback FTP and SFTP only. No real endpoint, AI provider or publication.
  The deterministic agent uses the shipped MCP tools, not a model.
- Defender stays on. No account storage, personal home/settings or unrelated
  editor processes may be changed. All profiles and raw evidence are disposable,
  under ignored `_debug/`.

The runner installs the exact candidate and a **separate local QA extension**
through each editor's installed CLI. The actual product runs as an ordinary
installed extension, not a development-host copy. The probe only invokes real
editor commands/APIs; it never substitutes product logic, SecretStorage,
confirmation dialogs, host-key decisions or MCP registration.

Process HOME/USERPROFILE/HOMEDRIVE/HOMEPATH, APPDATA, LOCALAPPDATA, user-data,
extensions and workspace are isolated. Each home contains an empty Cursor MCP
configuration. Auto-updates are disabled only in these test profiles. Cursor's
own `--skip-onboarding` launch option skips its external-account onboarding
overlay; **Cursor account onboarding and model-backed AI are not qualified**.
No account credentials or copied personal profile are used.

## Run or resume

From PowerShell in the task worktree:

```powershell
npm.cmd ci --no-audit --no-fund
node scripts/release.js verify --output-dir $Bundle --tag v0.1.0 --source-sha $SourceSha
node scripts/inspect-vsix.js "$Bundle/sftp-sync-ai-0.1.0.vsix"
node test/rc/matrix.js $Bundle $NewOutputDirectory $CodeExe $CursorExe
```

Use an absolute, new output directory whose parent exists. The runner refuses a
candidate/source/hash mismatch and an accidentally reused profile. It verifies
the release notes/provenance/checksum bundle and every installed extension file
(editor-added manifest installation metadata is the sole exception).

`matrix.json` is updated before and after each row. Each row gets a fresh home,
profile, extension directory and workspace. The eight rows are two editors × two
protocols × clean install / local update. A failed attempt is retained and stops
the matrix. Fix the cause, then resume without repeating passed rows:

```powershell
node test/rc/matrix.js $Bundle $OutputDirectory $CodeExe $CursorExe --resume
```

Resume verifies the same pin and synthetic predecessor. It creates a **new**
profile for a failed row and preserves its old attempt. A failure in shipped
behavior requires a narrow fix/regression and coordinator-issued new canonical
bundle, followed by a new matrix; do not substitute locally compiled bytes.

For bounded interactive diagnosis, launch one row:

```powershell
node test/rc/runner.js $Bundle $NewCellRoot vscode ftp $CodeExe
node test/rc/journey.js $NewCellRoot configure,connect,transfers,manual,agent,backups,errors,partialSync
```

Close it through the authenticated local controller (`control.js` exports the
request function with `{ op: 'close' }`). The controller has a two-hour safety
lifetime. Matrix mode always closes owned editors, protocol fixtures and SDK
transports in cleanup; it never terminates processes by editor name.

## What is observed

- Native plaintext-FTP and bulk warnings; explicit approve, Cancel and window
  dismissal; protocol counters, exact bytes and a pre-sync hook marker prove
  inert cancellation. Bulk overwrite preserves unrelated content.
- Strict generated JSON, safe defaults, unchanged existing config, actual
  password prompt/save, SFTP fingerprint decision and changed-key rejection.
- Upload/download, primary Remote-to-Local sync, terminal queue icons, and
  representative partial results and actionable errors/recovery.
- Actual Remote Explorer folder reads: successful browse, denied refresh,
  persistent **Read failed** status and categorized actions/Copy Diagnostics,
  explicit corrected recovery, hidden first upload and hidden-view config
  replacement without detached root errors. Clipboard content is held only
  in memory and restored after the diagnostic-copy check.
- Real diff/manual fallback; automatic editor MCP registration/startup; all
  eight shipped stdio tools; stale/reinspection, submitted and saved/acknowledged
  candidates, terminal uploaded/cancelled/failed and no blind write retry.
- Local text backup selection/open, Restore Cancel, exact restore and protection
  of the pre-restore remote text. Failed overwrite backup warns but does not
  block upload; failed promised delete backup blocks deletion.
- No claim of binary backup coverage, sync-delete undo or retained download
  recovery. Existing automated tests cover the full conflict-state retention and
  active-preservation budgets; editor QA does not allocate giant snapshots.

The scripted agent uses the official MCP SDK on the exact installed server
bundle and the live editor bridge. `mcp-launch.ps1` verifies the editor PID,
descendant ownership, executable and installed entrypoint of the editor-started
MCP process. A Windows-x64 helper reads **only** its injected capability into a
private pipe; it never outputs an environment or SecretStorage dump to evidence.
The capability is never persisted by the harness. This is a version-pinned QA
adapter, not shipped functionality. VS Code's generic `lm.invokeTool` outside a
chat request prompts for write approval, so it is not used to simulate the
autonomous agent. Cursor private/proposed tool APIs are not enabled.

## Real local update

The matrix creates **one deterministic synthetic 0.0.0 predecessor** from the
candidate. Only version metadata in `extension/package.json` and
`extension.vsixmanifest` differ; every runtime/resource byte is identical.
The predecessor is separately checksummed and checked against that recipe in
every row. It is neither a historical release nor upstream migration evidence.

The predecessor profile creates custom config, saves credentials through the
real prompt and creates/restores a backup. The running editor then opens its
actual **Extensions: Install from VSIX** native file chooser. The runner selects
the unchanged candidate and performs a full restart without uninstalling,
moving storage, changing the endpoint port or re-entering credentials.
Configuration hashes, functional authentication/transfer, old backup hashes and
restore, and SFTP known-host persistence are checked afterward.

## Evidence and sign-off

Private `observations.jsonl` records contain expected/observed results, UTC
timestamps, candidate/source hashes, operator identity, sanitized UI text,
queue icons, byte hashes and protocol assertions. `matrix.json` retains failed
attempt history. `driver.log`, controller logs, profiles and any raw screenshots
stay ignored; **do not upload profile directories**.

After all eight rows pass, generate evidence into a new or empty directory:

```powershell
node test/rc/export-evidence.js $OutputDirectory $EvidenceDirectory
node test/rc/collect-warnings.js $OutputDirectory $EvidenceDirectory
```

The second command adds selected, sanitized warning samples and their checksum.
The collector keeps origin stacks with error records: editor Git ENOTCONN is
not attributed to a protocol fixture, root lookup failures are not all called
config-replacement failures, and unattributed errors remain unattributed.
Review both outputs before signing the human-readable report. Evidence files
use LF by repository attribute so Windows checkouts preserve their checksums.

Publish only reviewed, sanitized observation records and their SHA-256 checksums.
The report must name exact editor/OS builds and the named agent/operator; it
must not impersonate a human tester. Distinguish:

1. unit/helper and loopback acceptance gates;
2. real installed-editor, native UI, actual SecretStorage and scripted-MCP QA;
3. source-matched remote CI and immutable artifact verification; and
4. deferred independent **human** README usability.

Before signing, use the executable matrix validator: every required scenario
must appear exactly once with PASS, on the same candidate/source, and no failed
record may occur in the selected successful attempt. Review all historical
failures and tooling warnings separately. Record untested supported OS/editor
floors explicitly. A Windows 11 result does not claim Windows 10 execution.

After tooling changes run the standard test/lint/typecheck/compile gate, both
protocol acceptance scripts, helper failure-path tests, package allowlist checks
and `git diff --check`. Local green does not certify unrun remote CI.
