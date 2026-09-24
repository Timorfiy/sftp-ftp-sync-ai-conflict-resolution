# RC 0.1.0 qualification report — corrected after independent review

**Functional result: PASS, eight fresh Windows 11 rows / 120 selected scenario
results on the corrected canonical artifact.** All eight passed on their first
attempt in an owner-authorized exclusive desktop window. F1 and F2 are corrected
with the evidence below; the independent reviewer must verify their closure.
This is a named **agent/operator** sign-off, not human usability validation or
publication authorization.

**Desktop is released and GUI testing is now locked.** Implementation and review
must remain non-GUI until the coordinator obtains another owner timing/isolation
agreement. Do not launch editor/native tests merely to inspect this report.

## Artifacts and source

| Item | Identity |
| --- | --- |
| Original task baseline | `ff7fafa45b5ea6066663b84e7bad8dd22424e192` |
| Qualified source | `a2ebe0cbfc2fb6625c8e82487373593cc4b3ddff` |
| Product | `Timorfiy.sftp-sync-ai`, version `0.1.0` |
| Canonical VSIX | `sftp-sync-ai-0.1.0.vsix`, 723857 bytes |
| VSIX SHA-256 | `f861ecd4c3b3dad9310fbca9fe98ce64dac70bf4d74c37fc46e233769b3d3da7` |
| Release / artifact | `36008363622` / `10812015294` |
| Bundle | `release-bundle-36008363622-1` |
| GitHub artifact archive SHA-256 | `6d1e9674156bf038ddf1b39a8bb0e8974e4d28f6e1d90b47d12019c7d7ede334` |
| Synthetic predecessor | `sftp-sync-ai-0.0.0.vsix`, 723391 bytes |
| Predecessor SHA-256 | `75d8661f65f650e67a5a8c6323bdf46a81355ca4878b5e8cfc54a4d43df04162` |

The coordinator committed the focused F1 source/docs/regression correction and
issued the immutable new bundle. Independent verification of source/tag,
checksum, provenance/notes and the 33-entry package inspector passed. Compared
with the previous `1256ba...` candidate, only `extension/dist/extension.js` and
`extension/docs/troubleshooting.md` changed. MCP bytes and release identity stayed
unchanged. Local compilation was not substituted for the canonical package.

One shared deterministic predecessor changes only version metadata in
`extension/package.json` and `extension.vsixmanifest`; all other entry contents
match the candidate. This is neither a historical release nor upstream migration.
Previous candidates and their results are historical only; the
[corrected historical report](RC-0.1.0-27aeaa3-report.md) explicitly records
the failed independent review and F2's corrected attribution.

## Environment and execution boundary

- Windows 11 Pro `10.0.26200`, x64; product/editor language explicitly English.
  The OS-owned file picker may use the host's Russian display language.
- VS Code Desktop `1.139.0`, commit
  `2242ebbb54efeeb0129e08e919e7e8d43033cd83`, x64.
- Cursor Desktop `3.17.8`, commit
  `2fdd31c9f33f7fbe501f2d57772dc5bf64b63620`, x64. Cursor's extension API reports
  compatibility version `1.128.0`; that is not its product version.
- Node `24.14.1`, npm `11.8.0`. Defender protection remained enabled.
- Four fresh clean-install profiles and four fresh local-update profiles, each
  with isolated home/app data/user-data/extensions/workspace and empty inherited
  Cursor MCP configuration. Auto-updates disabled only in those profiles.
- Ordinary CLI-installed product activation; no development-host substitution.
  Every installed archive file checked, with only editor-added manifest
  installation metadata exempted.
- Loopback FTP/SFTP and deterministic MCP SDK agent only. Real credential and
  host-key prompts, SecretStorage, native modals, editor APIs, packaged MCP
  registration/stdio and live bridge were not mocked.

Cursor's own `--skip-onboarding` flag avoids external-account onboarding in these
test profiles. No account token injection, personal-profile copying or DOM
removal was used. Cursor account onboarding and model-backed AI are not qualified.
The [maintainer runbook](README.md) describes the reproducible harness and its
Windows-x64, owned-MCP-process capability adapter.

## Exclusive-window matrix

Owner authorized coordinator option 2 (temporarily no keyboard/mouse use),
recorded in task decision `9914e109`. Earlier shared-desktop results, including
four passing VS Code rows, were **not reused** for final sign-off.
All rows below are new executions on September 24, 2026, times **UTC**.

| Editor / protocol | Fresh install: 24 scenarios | Native local update: 6 scenarios |
| --- | --- | --- |
| VS Code / FTP | **PASS**, 14:29:43–14:30:49 — [evidence](rc-0.1.0-a2ebe0c/vscode-ftp-clean.json) | **PASS**, 14:30:50–14:31:14 — [evidence](rc-0.1.0-a2ebe0c/vscode-ftp-update.json) |
| VS Code / SFTP | **PASS**, 14:31:14–14:32:05 — [evidence](rc-0.1.0-a2ebe0c/vscode-sftp-clean.json) | **PASS**, 14:32:05–14:32:26 — [evidence](rc-0.1.0-a2ebe0c/vscode-sftp-update.json) |
| Cursor / FTP | **PASS**, 14:32:27–14:33:38 — [evidence](rc-0.1.0-a2ebe0c/cursor-ftp-clean.json) | **PASS**, 14:33:39–14:34:11 — [evidence](rc-0.1.0-a2ebe0c/cursor-ftp-update.json) |
| Cursor / SFTP | **PASS**, 14:34:12–14:35:08 — [evidence](rc-0.1.0-a2ebe0c/cursor-sftp-clean.json) | **PASS**, 14:35:08–14:35:38 — [evidence](rc-0.1.0-a2ebe0c/cursor-sftp-update.json) |

The [matrix](rc-0.1.0-a2ebe0c/matrix.json) lists the canonical scenario IDs,
timestamps and selected evidence. [SHA256SUMS](rc-0.1.0-a2ebe0c/SHA256SUMS) covers
all ten JSON evidence files. Expected/observed UI text, protocol assertions,
queue icons, hashes, source/candidate identity and operator identity are retained.
The selected attempts contain no failed record; completeness and privacy
validators pass. Evidence LF attributes preserve checksums across checkouts.

At `14:36:05 UTC`, a post-run process inspection found no task-owned editor,
controller, scenario-driver or MCP process. The coordinator was immediately
notified that the owner could use the desktop again. Clipboard contents were
held only in memory and restored after each diagnostic-copy check.

## Acceptance checklist

- [x] **Install/config:** identity/version/English commands, safe strict generated
  JSON, conflict checking and 100 local text backups, automation/deletion off;
  invoking Config preserves an existing file. `installed`, `configuration`.
- [x] **Read-only Test Connection:** real credential prompt/save and exact
  unchanged remote tree, FTP encryption warning Cancel without protocol work,
  independently verified first SFTP fingerprint. `connection`,
  `ftp-warning-cancel`, `sftp-first-key`.
- [x] **First transfer/primary sync:** exact upload/download bytes and terminal
  queue; Remote-to-Local creates/replaces and preserves destination-only files.
  Hidden-first-upload root lookup is clean. `first-transfer`, `primary-sync`.
- [x] **Bulk warning/partial recovery:** real modal profile/direction/paths;
  Cancel and window dismissal cause no transfer/network/hook activity and preserve
  bytes; approval runs the hook once and overwrites intended content. Mixed
  result completed 1 / failed 1 is truthful and explicitly recovered.
  `bulk-warning`, `bulk-partial-result`.
- [x] **Manual conflict fallback:** real diff, cancellation preserving remote
  bytes, explicit reviewed overwrite. `manual-conflict`.
- [x] **Autonomous scripted agent:** actual registered packaged MCP, all eight
  tools, stale/reinspection, submit and saved-edit acknowledge, newest revision
  resolve and terminal uploaded/cancelled/failed, with no manual conflict
  approval in the happy path and no replay of an unsafe write.
  `mcp-registration`, `agent-stale-upload`, `agent-acknowledge-cancel`,
  `agent-upload-failure`.
- [x] **Backup view/restore:** actual selection/open, native Restore cancellation,
  exact earlier text restored and pre-restore current text retained.
  `backup-restore`. Text-only, fail-open overwrite backup, fail-closed promised
  delete backup and no download/sync-delete undo remain explicit.
- [x] **Errors/recovery:** configuration, authentication, unavailable endpoint,
  remote path, permissions, bounded failed download preserving local bytes,
  backup faults, stale conflict and failed transfer; protocol-specific changed
  SFTP key and unavailable FTP timestamp. `error-*`, protocol and agent records.
- [x] **F1 actual Explorer boundary:** successful browse → denied folder refresh →
  categorized permission message, safe next step, Retry/Open Config/Copy
  Diagnostics/Troubleshoot/Show Output → explicit corrected read. Folder remains
  visibly **Read failed** until refresh; no raw/generic permission toast or
  remote mutation. Clipboard diagnostics verify `permission.denied`, correct
  protocol, safe retry and useful cause code. Hidden-view config replacement
  and subsequent upload/browse recover without root rejection.
  `explorer-error-recovery` in all four clean rows.
- [x] **State isolation:** remote listings exclude configuration, keys and
  private conflict state. Existing automated retention/active-preservation
  coverage retained. `state-isolation`.
- [x] **Real update:** actual native Install-from-VSIX chooser in the running
  synthetic predecessor profile, then full restart on exact 0.1.0 bytes.
  No uninstall, storage copy, port change or credential reentry. Custom config
  hashes, functional authentication/transfer, old backup hashes/discovery/restore
  and both SFTP known-host hashes persist. All eight rows have no root-lifecycle
  error logs. `in-place-update`.
- [x] **Evidence:** reviewed and sanitized logs/assertions/checksums; no raw
  profiles, SecretStorage, MCP capabilities, private keys or personal paths
  published.
- [ ] **Independent human README usability:** owner-deferred until before first
  publication on 2026-09-24; the risk of confusing a fresh user remains.

## Review findings and their correction

### F1 — actionable Remote Explorer failure and root lifecycle

Corrected in the qualified runtime. The provider reports connection/list errors
through the existing categorized/redacted reporter, exposes an explicit
failed-folder status, and waits for explicit safe retry/refresh. Notification
dismissal does not block listing completion. Refresh no longer issues a second
remote list solely for previews. Root lookup initializes lazily; parent lookup
needs no remote I/O; retired in-flight results cannot repopulate a replacement
tree. Refresh command promises are intentionally awaited/observed.

Eleven focused regressions cover FTP/SFTP permission, network/path errors,
redaction, failed-state recovery, notification liveness, lazy/retired roots,
in-flight success/rejection and asynchronous refresh failure. Four real-editor
tree failure/recovery scenarios and all eight lifecycle guards passed.

### F2 — warning causality

Corrected collector and report, with four causal regressions. Multi-line origin
stacks stay attached to errors. All eight historical ENOTCONN records identify
the editor-owned Git ChildProcess/getRepositoryRoot path; they were incorrectly
called injected protocol faults before review. Root lookup errors can be
lazy/uninitialized or retired; the collector no longer assumes every one follows
config replacement. An errno without an identifying stack remains unattributed.
Explicit fixture protocol diagnostic text is a separate category.

Historical observations were not rewritten as new successes. Their warning
samples/checksums were corrected and their matrix/report marked needs_changes.
Fresh [warning samples/counts](rc-0.1.0-a2ebe0c/runtime-warnings.json) contain
**zero root-lifecycle errors**. Eight Git ENOTCONN records remain in the four
clean rows, with identifying stacks; four generic renderer entries remain
unattributed by the message alone. No generic toast was present in the selected
UI assertions; the reviewer previously sampled the analogous Git paths as
log-only. This is not a claim of a warning-free editor or a waiver of defects.

Other recorded noise: editor/CLI DEP0169, Windows jump-list warnings, Cursor
fresh-profile defaults, and missing optional sandbox `.ssh/config`. Required
behavior passed; no editor-owned unrelated code was modified.

## Verification and remaining boundaries

Local automated gate: **60/60 suites**, **522 passed, 1 pre-existing skipped,
523 total**, **2 snapshots**; lint, local TypeScript `--noEmit`, compile and
whitespace checks pass. Separate loopback FTP **10/10** and SFTP **12/12** pass
with open-handle detection; no Jest non-exit/open-handle warning. The 13 original
QA helper guards, 11 F1 regressions and 4 F2 causal regressions pass. New JS and
PowerShell helper syntax checks pass. The existing skipped transfer test is
`sync --update with time offset`.

Independent remote queries: **Release `36008363622`** and **Quality
`36008369921`** succeeded on `a2ebe0c...`. Eight Release jobs succeeded; all three
publishers skipped. Artifact was unexpired; source/tag, checksum/provenance/
notes and package inspection pass. CI emitted action-runtime deprecation and
runner-image migration notices without failing those jobs.

Remote CI covers committed candidate source, **not** the remaining uncommitted
R11 harness/fixtures/maintainer docs/evidence. These still require independent
review/acceptance, coordinator integration and source-matched CI.
QA/helpers/evidence remain excluded by the explicit package allowlist.

Preserved but excluded from final sign-off: old candidate attempts, the first
f861 driver expecting a child of a collapsed replacement root, an early picker
mouse-selection timeout, a Cursor native-modal targeting failure, and the
owner-interrupted shared-desktop Cursor attempt. Native buttons may share ID 0;
the driver now targets the exact button HWND with bounded BM_CLICK, verified
with five Cancel/no-connection probes before the exclusive run. All eight final
exclusive rows passed without retries. Old attempts are retained privately and
summarized in the [worklog](R11-worklog.md).

Windows 10 and VS Code 1.104.0 were not executed; only the exact Windows 11/editor
builds above are proven. Supported floors remain unchanged. FTPS, real endpoints,
model-backed AI, registry publication, upstream migration, binary/universal
recovery and independent human usability are not qualified. First publication
still needs separate owner consent and every deployment needs manual GitHub
Environment approval after checks.

## Operator signature

**Signed: Kent — gpt-6-astra implementation agent, September 24, 2026 UTC.**
I reviewed the exclusive-window observations, artifact/source binding,
checksums and verification outcomes above. Export signature:
`2026-09-24T14:36:22.788Z`. This is a named agent/operator attestation, not a human
test or cryptographic certificate. F1/F2 independent-review closure remains
required. **GUI lock remains active for both implementation and reviewer.**
