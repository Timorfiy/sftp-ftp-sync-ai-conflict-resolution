# Historical RC 0.1.0 / 27aeaa3 qualification report — 2026-09-24

**Historical result: 116 assertions passed, but independent review returned
NEEDS CHANGES (F1/F2). This candidate is not acceptance-ready.** The original
eight-row execution below is preserved as historical evidence, with the
warnings and execution limits below. This is an **agent/operator sign-off**,
not a claim of independent human usability testing or publication authorization.
Independent workflow review/acceptance and integration of the QA changes remain
required.

## Immutable artifacts and source

| Item | Identity |
| --- | --- |
| Original task baseline | `ff7fafa45b5ea6066663b84e7bad8dd22424e192` |
| Qualified source | `27aeaa3ecb80c4766dacbfde75d72425522df738` |
| Product | `Timorfiy.sftp-sync-ai`, version `0.1.0` |
| Candidate | `sftp-sync-ai-0.1.0.vsix`, 723358 bytes |
| Candidate SHA-256 | `1256ba34302813c6d06caf694d2b8e80fc93e0bae7e8ad3005e55c348257e719` |
| Release run / artifact | `36000977616` / `10808705885` |
| Bundle | `release-bundle-36000977616-1` |
| Download archive SHA-256 (GitHub artifact API) | `47a2620c5465949935f1cb6c3aafcd2a8b878a15a2dc18dd514b445e548e06ea` |
| Synthetic predecessor | `sftp-sync-ai-0.0.0.vsix`, 722892 bytes |
| Predecessor SHA-256 | `a4137b570f30f130501ca709cc1fd95a8792595ae3dcfc1cdcbe61c2fde31e2c` |

The coordinator reissued the original dry-run candidate after fixing one
qualification finding: README said **Continue**, whereas the bulk confirmation
button is **Sync Local → Remote**. The correction and a regression comparing
README to the actual modal copy are committed in the qualified source. Independent
archive comparison found 33 entries in both candidates and **only
`extension/readme.md` changed**. Runtime bytes did not change.

The previous SHA-256
`b78e78507a1599579788e87fc8decd420e95b55b194a1c2efef56248bc1648b5`
is supplemental development evidence only. None of its observations substitute
for the final matrix.

The one shared synthetic predecessor changes only version metadata in
`extension/package.json` and `extension.vsixmanifest`. All other entry contents
equal the canonical candidate. It is not a historical release or evidence of
PhilipDaoud migration. The tracked product release version stays `0.1.0`.

## Tested environment

- Windows 11 Pro, `10.0.26200`, x64; host OS display language is Russian, product
  and editor interfaces were explicitly English. OS-owned file chooser labels
  can follow the host language.
- VS Code Desktop `1.139.0`, commit
  `2242ebbb54efeeb0129e08e919e7e8d43033cd83`, x64.
- Cursor Desktop `3.17.8`, commit
  `2fdd31c9f33f7fbe501f2d57772dc5bf64b63620`, x64. Its extension API reports VS
  Code compatibility version `1.128.0`; that is **not** the Cursor product version.
- Node `24.14.1`, npm `11.8.0`. Defender antivirus, real-time protection and
  behavior monitoring were verified enabled.
- Four distinct clean profiles and four distinct update profiles. Each had its
  own process home, app data, user-data, extensions and workspace. Only loopback
  endpoints were configured; inherited Cursor global MCP discovery was isolated.

No development-host substitution was needed: both the candidate and the separate
QA probe were CLI-installed, and the product activated in ordinary installed
editor windows. All 31 installed extension files were checked against the VSIX;
the editor's added manifest installation metadata was the sole allowed difference.
The [runbook](README.md) explains the actual command/UI and scripted-MCP boundaries.

## Signed execution matrix

Times below are UTC on **September 24, 2026**. Each clean row passed 23 required
scenarios; each update row passed 6. Total: **116 selected scenario results**.
The canonical scenario IDs, exact expected/observed results, editor/OS metadata
and failed-attempt history are in the [machine-readable matrix](rc-0.1.0-27aeaa3/matrix.json).
Every evidence file is listed in [SHA256SUMS](rc-0.1.0-27aeaa3/SHA256SUMS).

| Editor / protocol | Fresh install | In-place local update |
| --- | --- | --- |
| VS Code / FTP | **PASS**, 12:58:13–12:59:14 — [evidence](rc-0.1.0-27aeaa3/vscode-ftp-clean.json) | **PASS**, 12:59:15–12:59:40 — [evidence](rc-0.1.0-27aeaa3/vscode-ftp-update.json) |
| VS Code / SFTP | **PASS**, 12:59:40–13:00:27 — [evidence](rc-0.1.0-27aeaa3/vscode-sftp-clean.json) | **PASS**, 13:02:43–13:03:05 — [evidence](rc-0.1.0-27aeaa3/vscode-sftp-update.json) |
| Cursor / FTP | **PASS**, 13:03:05–13:04:11 — [evidence](rc-0.1.0-27aeaa3/cursor-ftp-clean.json) | **PASS**, 13:04:11–13:04:46 — [evidence](rc-0.1.0-27aeaa3/cursor-ftp-update.json) |
| Cursor / SFTP | **PASS**, 13:04:47–13:05:39 — [evidence](rc-0.1.0-27aeaa3/cursor-sftp-clean.json) | **PASS**, 13:05:40–13:06:11 — [evidence](rc-0.1.0-27aeaa3/cursor-sftp-update.json) |

### Acceptance-to-evidence audit

- [x] **Install/configuration:** exact candidate files, identity/version,
  activation and English commands; strict generated JSON, conflict checks and
  100 local text backups enabled, automation/deletion off; existing config not
  rewritten. Records: `installed`, `configuration`.
- [x] **Test Connection/secrets:** actual password input and Save-to-Secret-Storage
  controls; successful read-only probe with unchanged remote tree; FTP native
  warning and Cancel with no new protocol work; independently matched SFTP
  fingerprint. Records: `connection`, `ftp-warning-cancel`, `sftp-first-key`.
- [x] **Transfer/primary sync:** exact upload/download bytes and terminal queue;
  Remote-to-Local replaces/creates while preserving destination-only files.
  Records: `first-transfer`, `primary-sync`. No download undo is claimed.
- [x] **Bulk safety:** native modal names profile/direction/paths/recovery limits;
  Cancel and window dismissal preserve trees, perform no protocol work and
  do not run the installed pre-sync hook; approval runs it once and performs
  the intended overwrite. A mixed transfer reports completed 1 / failed 1 with
  an error queue icon and successful explicit recovery. Records:
  `bulk-warning`, `bulk-partial-result`.
- [x] **Manual fallback:** real diff editor, Cancel leaves remote unchanged,
  explicit Overwrite uploads reviewed content. Record: `manual-conflict`.
- [x] **Autonomous scripted agent:** actual automatic editor MCP registration
  and editor-launched packaged stdio process; official SDK client exercises all
  eight tools against the live bridge. Reinspection after stale rejection,
  submit and saved-edit acknowledgement, revision-checked resolve and terminal
  wait distinguish uploaded/cancelled/failed. No manual conflict approval in
  the happy path. One failed write attempt is not replayed. Records:
  `mcp-registration`, `agent-stale-upload`, `agent-acknowledge-cancel`,
  `agent-upload-failure`.
- [x] **Backup restore:** actual Local Backups selection/open, native Restore
  Cancel, exact earlier text restored, and pre-restore current text protected.
  Record: `backup-restore`. Text-only, fail-open overwrite backup, fail-closed
  promised delete backup and no sync-delete/download undo remain explicit.
- [x] **Failure/recovery:** configuration/Open Config, authentication, unavailable
  endpoint, remote path, permissions, download interruption, backup failure,
  stale conflict and failed upload. SFTP changed-key rejection and FTP unavailable
  timestamp covered where applicable. Failed safe reads preserve the old local
  file; explicit recovery succeeds. Records: `error-*`,
  `sftp-changed-key`, `ftp-timestamp-unavailable`, agent failure records.
- [x] **Isolation:** remote listings contain no product configuration, keys or
  private conflict state. Conflict state remains outside the transfer workspace;
  existing automated tests cover retention budgets and active preservation.
  Record: `state-isolation`.
- [x] **Actual update/persistence:** native **Install from VSIX** chooser in the
  running 0.0.0 profile, then full restart on exact 0.1.0 bytes. Same home/profile/
  workspace/endpoint; no uninstall, copied storage or credential reentry.
  Custom config hashes match; saved authentication and transfer succeed; old
  backup hashes persist and an old backup restores; both SFTP rows retain the
  known-host hash. Record: `in-place-update`.
- [x] **Evidence safety:** selected UI text, protocol/byte assertions and runtime
  warnings reviewed and sanitized; checksums verified. Raw profiles, screenshots,
  capability files and SecretStorage were not exported.
- [ ] **Independent human README usability:** not run; explicitly deferred by the
  owner on 2026-09-24 until before first publication.

## Verification categories

### Local automated gate

After implementation: standard `npm.cmd test -- --runInBand` passed **58/58
suites**, **507 passed, 1 skipped, 508 total tests**, **2 snapshots**. No Jest
open-handle/non-exit warning. The existing skipped case remains
`sync --update with time offset` in the transfer tests.

`npm.cmd run lint`, local `tsc.cmd --noEmit`, `npm.cmd run compile` and
`git diff --check` passed. Separate FTP acceptance passed **10/10** and SFTP
acceptance **12/12**, both with open-handle detection. New helper tests passed
**13/13** and cover artifact/source mismatch, version-only predecessor, installed
byte tampering, bounded waits, teardown failures, environment isolation,
sanitization, completeness refusal and stable-endpoint/write-only fixtures.
All new JavaScript files passed `node --check`.

Package listing retains the explicit shipping allowlist: QA code, fixtures,
reports, profiles and evidence are excluded. Exact canonical bundle verification
and the 33-entry secret/path inspector passed. Compilation here was for
regression checks, not to replace the qualified VSIX.

### Remote checks

Independently queried **Release `36000977616`** and **PR Quality `36000979416`**
both completed **success** on `27aeaa3...`. Release's quality/protocol jobs,
single-bundle build, three channel validators and common barrier passed; all
three publication jobs were **skipped**. The artifact API reported unexpired
artifact `10808705885` and the archive digest above.

These checks qualify the committed candidate source. The remaining R11 harness,
fixture, maintainer-documentation and evidence changes are **uncommitted and
have no source-matched remote CI yet**. The coordinator must integrate them
after independent workflow review/acceptance and verify remote CI separately.

## Findings, failures and limitations

1. **Fixed shipped documentation finding:** approval-button wording. Regression
   and coordinator-issued replacement artifact verified as described above.
2. **Preserved unsuccessful final-matrix attempts:** first VS Code/FTP clean
   attempt timed out closing editors after successful backup recovery. A fresh
   attempt passed without product changes. First VS Code/SFTP update installed,
   restarted and authenticated successfully, but its backup menu disappeared
   before selection. The driver now waits for visible, hit-testable controls and
   reopens only that non-mutating menu. Neither failed attempt is counted as a
   successful row; their timestamps remain in the matrix. The earlier
   Close All Editors timeout was not reproduced or conclusively attributed.
3. **Runtime warnings are retained, not hidden:** see
   [sanitized warning samples and counts](rc-0.1.0-27aeaa3/runtime-warnings.json).
   These include editor/CLI `DEP0169`, Windows jump-list warnings, Cursor
   fresh-state initialization messages, and absent optional sandbox `.ssh/config`.
   Extension-host logs also contain remote-root lookup errors, including lazy
   first-upload roots **before** config replacement as well as retired roots.
   All eight historical `read ENOTCONN` occurrences have **editor-owned Git
   ChildProcess/getRepositoryRoot stacks**, not loopback-fixture causality.
   Required typed diagnostics, exact bytes, queue outcomes, reconnection and
   restoration still passed. This is not a warning-free run, and the extra
   generic text is **not present in the selected UI captures**. The
   independent reviewer sampled 100ms UI states through two clean journeys and
   found no generic/root/ENOTCONN toast in those paths. This supports a log-only
   classification for those observed paths, not a blanket waiver.
   **F1 separately reproduced a visible defect:** denied-folder refresh in the
   actual Remote Explorer showed raw FTP/SFTP permission text without safe
   actions. The correction must reuse categorized/redacted errors and cover the
   real tree. **F2 corrected the erroneous original errno/root causality claims**
   using origin stacks. A runtime-reissued candidate and new full matrix are
   required before renewed sign-off.
4. **Cursor account onboarding is outside this check.** Its own
   `--skip-onboarding` flag avoids external sign-in in isolated test profiles.
   No DOM removal, account-token injection, personal-profile copying or
   external model call was used. The extension UI, host-key/credential prompts,
   actual SecretStorage and native update remained real.
5. **Execution gaps:** Windows 10 and VS Code `1.104.0` were not executed.
   The supported boundary remains Windows 10/11, VS Code `1.104.0+`, Cursor
   `3.17.8+`; this report only proves the exact Windows 11/editor builds above.
   FTPS, real endpoints, registry installation/publication, external AI,
   upstream migration and binary/universal recovery are not qualified.
6. **Human usability risk remains:** a fresh target user may find the README
   confusing. The independent human check stays unchecked in the
   [prepublication checklist](../releasing.md#prepublication-checklist).

## Operator signature

**Signed: Kent — gpt-6-astra implementation agent, September 24, 2026 (UTC).**
This historical signature attests the selected observations only; F1/F2 invalidate
the earlier readiness conclusion. I executed and reviewed the selected real-editor and local-update observations,
their artifact binding and the verification results above. The automated
evidence export signature is timestamped `2026-09-24T13:07:41.415Z`.
This is a named agent/operator attestation, not a human or cryptographic signing
certificate. It does not waive the listed limitations, independent review or
the separate owner/environment approvals required for publication.
