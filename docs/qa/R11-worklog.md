# R11 qualification worklog

Operator: Kent (implementation agent). Started 2026-09-24 UTC.
Source baseline: `ff7fafa45b5ea6066663b84e7bad8dd22424e192`.
Canonical dry-run: Release `35987203611`, artifact `10802514081`.
Candidate: `sftp-sync-ai-0.1.0.vsix`, 723358 bytes,
SHA-256 `b78e78507a1599579788e87fc8decd420e95b55b194a1c2efef56248bc1648b5`.

This is a live action checklist, **not a release sign-off**. Raw profiles,
credentials, MCP capabilities and screenshots awaiting review stay under ignored
`_debug/`. No product bytes may be substituted for the canonical package.

## Actions

- [x] Inspect task, decisions, integrated source and clean task worktree.
- [x] Reverify canonical checksum, provenance/notes and package inspection:
  release verifier passes; inspector passes 33 entries.
- [x] Implement bounded isolated Windows runner, UI controller, artifact guard,
  synthetic predecessor and deterministic fake agent; test helper failure paths.
- [x] VS Code / FTP clean-install full journey.
- [x] VS Code / SFTP clean-install full journey.
- [x] Cursor / FTP clean-install full journey.
- [x] Cursor / SFTP clean-install full journey.
- [x] VS Code / FTP in-place local 0.0.0 → canonical 0.1.0 update.
- [x] VS Code / SFTP in-place local 0.0.0 → canonical 0.1.0 update.
- [x] Cursor / FTP in-place local 0.0.0 → canonical 0.1.0 update.
- [x] Cursor / SFTP in-place local 0.0.0 → canonical 0.1.0 update.
- [x] Review/sanitize/hash evidence; produce version-bound signed scenario matrix.
- [x] Add maintainer runbook and prepublication checklist link.
- [x] Run final Jest, lint, typecheck, compile, FTP/SFTP acceptance, package
  exclusion and whitespace checks.
- [x] Audit every acceptance item and prepare the self-contained review handoff.

## Boundaries and outstanding evidence

Windows 11 Pro 10.0.26200 x64 is available. Windows 10 and VS Code 1.104.0 floor
execution are not claimed. Actual editor builds will be recorded at execution.
FTPS, real endpoints, registry publication and model-backed AI are out of scope.
Only the independent **human** fresh-user README usability check is deferred
(owner decision 2026-09-24); it remains required before first publication.

Baseline planning gate passed 57 suites / 493 tests, one existing skipped test,
lint, typecheck and compile. It does not qualify the new harness. Baseline remote
Quality `35987199863` and Release `35987203611` passed; R11 changes have no
source-matched remote checks until coordinator integration.

## Implementation progress (2026-09-24, 11:18 UTC)

New uncommitted tooling is in `test/rc/`. It installs both the canonical VSIX
and a separate QA command probe with the editor CLI, then starts a **normal
installed** editor (no development-host substitution). All 31 extension archive
files are checked; editor-added `package.json.__metadata` alone is disregarded.
The probe invokes actual commands/editor APIs without replacing product APIs.
UI input uses CDP and native Windows dialog messages against owned processes.
Only one GUI driver runs at a time.

Preserved private evidence: `_debug/rc-vscode-ftp-04/observations.jsonl`.
That profile has passed configuration safety/non-migration, real credential
prompt/SecretStorage save, plaintext warning Cancel/no network, read-only probe,
exact upload/download, Remote-to-Local preservation, inert bulk Cancel and
approved overwrite, manual diff/cancel/overwrite, all eight MCP tools,
stale/reinspect/submit/upload, acknowledge/cancel, failed upload with one write
attempt, and actual backup selection/view/Cancel/Restore/pre-restore protection.
These are partial scenario observations, **not whole-cell or RC sign-off**.
Other cells, error matrix, upgrade and helper regression/final gates are pending.

Harness development attempts `rc-vscode-ftp-01` through `03` remain preserved
but do not count as acceptance. Corrected automation issues: Windows path drive
case, configuration reload requires real editor save, native dialog buttons
need directed WM_COMMAND, quick-pick/context-menu selection needs real mouse
events and settled layout, and minified editor constructor names cannot identify
diff tabs. Profile 01 activation timed out and was cleaned up; 02/03 owned editors
were closed by the runner. No user's editor/profile was touched.

VS Code `lm.invokeTool` outside a chat request prompted for MCP write approval
and timed out during harness development. The final fake-agent adapter uses the
official SDK and the exact installed stdio server, with only the capability
injected into the verified owned editor-launched MCP child read over a private
pipe (R4 precedent). It never dumps environment/SecretStorage and does not
intercept registration. Registration/startup and all eight tools are observed
in the real editor first. No manual conflict approval is used in agent scenarios.

Confirmed documentation finding: README's bulk-upload paragraph calls the
approval button **Continue**, but the actual native button is **Sync Local →
Remote**. The safe modal works. Prepare a focused documentation regression and
coordinate canonical-candidate reissue before final sign-off; never qualify
locally changed shipped bytes as the original candidate.

At 12:30 UTC, VS Code/SFTP additionally exercised the same successful scenarios
plus configuration/authentication/network/path/permission/changed-key failures
and recovery, bounded failed download preserving its destination, fail-open
overwrite-backup warning, fail-closed delete preflight and backup recovery.
Its private profile is `rc-vscode-sftp-01`; all owned processes were closed.
Helper regression tests passed 9/9; shipped-doc regression surface plus helper
tests passed 31/31. The only shipped correction so far is the README button label.

Cursor's completely new profile displays a full-window login onboarding overlay.
The product commands and native warnings run behind it, but real mouse clicks
cannot reach notifications. That attempt (`rc-cursor-ftp-01`) is **not accepted**
for connection/UI qualification. The installed Cursor CLI explicitly parses
`--skip-onboarding` and its workbench reads that option. Use this editor-provided
launch flag in isolated Cursor QA to avoid signing into an external service.
Do not remove overlay DOM, copy account storage, inject auth tokens or claim
Cursor account onboarding/model-backed AI was tested. This is extension
qualification in an installed editor; raw first-run overlay screenshot is retained.

## Candidate reissue and current checkpoint (12:52 UTC)

Coordinator committed **only** README.md and its regression as
`27aeaa3ecb80c4766dacbfde75d72425522df738` on the feature branch, pushed a draft
PR #14 and dispatched non-publishing Release `36000977616`. This is now task
HEAD; original implementation baseline remains `ff7fafa...`. All other changes
remain uncommitted. Await the coordinator's verified new artifact pin before
the final eight-row matrix. Original-package observations remain supplemental.

Original-package supplementary execution:

- Cursor/FTP `rc-cursor-ftp-02` and Cursor/SFTP `rc-cursor-sftp-01`: complete core,
  backup, manual/MCP and applicable error/recovery scenarios passed.
- Native Install-from-VSIX predecessor → candidate/full-restart passed in
  `rc-update-vscode-ftp-02` and `rc-update-cursor-sftp-01`. Both retained exact
  custom config bytes and real saved authentication without credential entry;
  old backups remained byte-identical/discoverable/restorable. SFTP known-host
  hash was unchanged.
- Additional `rc-harness-edges-01` proved terminal queue icons, a pre-sync hook
  not running on Cancel or **window dismissal**, one hook execution on approval,
  and a mixed bulk result (completed 1, failed 1) with targeted write-only
  permission denial and recovery. No runtime bug was found.
- Earlier update setup timed out because Windows native picker expected an
  isolated Desktop directory and filename control 1148. Both corrected.
  Earlier window-dismiss automation addressed a child control instead of the
  root dialog; it now checks root class `#32770` before sending WM_CLOSE.
  Earlier partial-sync injection denied preflight too, so it did not produce a
  partial transfer; the fixture now has explicit write-only faults.
- Every owned editor/fixture/controller has been closed at this checkpoint.

Local gate after the shipped correction: 58 suites, 503 passed + 1 existing
skipped test, 2 snapshots; lint/typecheck/compile all passed; separate FTP 10/10
and SFTP 12/12 passed; no open-handle warning. Gate log: private shell 1298.
Subsequent helper/fixture regressions: 33/33 across helper + FTP + SFTP suites,
with open-handle detection. Final gate must be repeated after tooling settles.

Serial `test/rc/matrix.js` now creates one shared, checksummed deterministic
predecessor, updates statuses incrementally and supports same-pin resume while
preserving failed attempts. `assertRow` refuses missing, duplicate, failed or
wrong-hash/source observations. Final signed report/export is still pending.

New canonical independently verified on 2026-09-24: Release `36000977616`,
artifact `10808705885`, source `27aeaa3ecb80c4766dacbfde75d72425522df738`,
723358 bytes, SHA-256
`1256ba34302813c6d06caf694d2b8e80fc93e0bae7e8ad3005e55c348257e719`.
Bundle verifier and 33-entry inspector pass. Independent entry comparison finds
only `extension/readme.md` changed. Independent GitHub queries show that Release
and PR Quality `36000979416` completed success for this exact source. This does
not certify the uncommitted R11 tooling/evidence. Final matrix output root:
`_debug/rc-final-1256ba343028`.

Final matrix checkpoint: VS Code/FTP clean (23 scenarios), VS Code/FTP update
(6), VS Code/SFTP clean (23) passed on the new pin. Their observations are not
rerun during resume. Retained failed attempts: first FTP clean timed out on the
editor's Close All Editors command after successful backup recovery; a fresh
attempt passed unchanged product behavior. First SFTP update had already
installed/restarted/authenticated/transferred successfully but a refreshed
backup context menu disappeared before selection; the driver now reopens only
that non-mutating menu and checks visible/hit-testable controls. Its fresh
attempt is running. No mutation/Restore/transfer is retried automatically.
Failed records are preserved and excluded from signed successful attempts.

All eight final rows now pass: 23 assertions/scenarios in each of four clean
rows, 6 in each of four update rows (116 selected scenario results). Each
successful attempt has no failed record. All final owned controllers/editors
and loopback/SDK processes were closed. Final local gate shell 1333 exited 0;
evidence review/export, report and acceptance audit remain in progress.

## Implementation exit audit

The signed report is `docs/qa/RC-0.1.0-report.md`; reviewed JSON evidence and
SHA256SUMS are in `docs/qa/rc-0.1.0-27aeaa3/`. All 8 rows / 116 required
scenario results were revalidated against the new candidate/source and all
10 evidence checksums/privacy guards passed. Evidence LF attributes preserve
checksums through Windows checkouts. Runbook/prepublication links were checked.

Final repeated gate after exporter/warning-collector/report work: shell 1344
exit 0, 58 suites / 507 passed / 1 skipped / 508 total / 2 snapshots, lint,
typecheck, compile, FTP 10/10, SFTP 12/12, new JS syntax and diff checks pass.
Final process inspection found no task-owned editor, controller, fixture or
MCP process remaining. Defender remains on.

Runtime warning samples/counts and both failed final-matrix attempts are
retained and explicitly discussed. The unexplained first Close All Editors
timeout was not silently attributed to a product fix; the succeeding fresh
attempt used unchanged product bytes. Retired-remote-resource/ENOTCONN and generic
renderer log entries remain an **open independent-review finding against R8/R11**,
not an accepted limitation or owner waiver. Selected UI captures contain the
required actionable messages but not the generic text; exact visible consequence
requires reviewer reproduction/causality assessment.

Choose **review**. Remaining uncommitted changes are QA/tooling/fixtures/
maintainer documentation/evidence only. Coordinator already committed the
minimal shipped correction as `27aeaa3...`; no other product bytes changed.
Independent workflow review/acceptance, integration and source-matched CI for
these uncommitted changes remain pending. No publication is authorized.

## Independent-review corrections — F1 / F2

Review returned `needs_changes` on 2026-09-24. Preserve original baseline
`ff7fafa45b5ea6066663b84e7bad8dd22424e192`, current HEAD `27aeaa3...`,
all prior artifacts/profiles and successful observations. The former sign-off
is now **historical, not acceptance-ready**.

- **F1 required:** actual Remote Explorer denied-folder refresh produces a raw,
  unactionable toast; lazy/uninitialized and retired roots also reject detached
  refresh work. Reuse actionable/redacted reporting, represent listing failure
  truthfully, and verify actual tree recovery.
- **F2 required:** all eight original ENOTCONN events have editor Git
  ChildProcess/getRepositoryRoot stacks, not fixture causality. Root errors can
  precede config replacement too. Correct causality from stack/scenario evidence.

Correction checklist:

- [x] Inspect review, preserved workspace and original source baseline.
- [x] F1 focused product correction and lifecycle/error regression tests.
- [x] F2 stack-aware collector, causal regression and historical evidence correction.
- [x] Actual-editor QA for read-only tree failure/actionable recovery,
  lazy first upload and hidden-view config-reload refresh.
- [x] Required gate and coordinator runtime-reissued canonical RC.
- [x] Verify new bundle and rerun all eight fresh clean/update rows.
- [x] Correct signed report/evidence/checksums and audit both review findings.
- [x] Final gates, cleanup and corrected independent-review handoff.

F1 implementation: persistent failed-folder icon/description and existing
categorized/redacted read-error actions; user-triggered retry, no extra listing
from refresh; lazy roots, local-only parent lookup and cancelled retired results;
refresh-command promises are observed. Eleven focused tests pass.
F2: grouped origin stacks prove all eight historical ENOTCONN events are built-in
Git errors, not protocol injections. Four causal classification tests pass.
Historical report/matrix explicitly marked needs_changes; raw scenarios retained.

Gate shell 1408 passed: 60 suites, 522 passed/1 existing skipped/523 total,
2 snapshots; lint/typecheck/compile; FTP10/SFTP12; whitespace check.
Coordinator asked to commit only the two Remote Explorer source files,
troubleshooting copy and their new regression file and issue a canonical runtime
candidate. No local package was substituted. New actual-editor tree scenario
and hidden-first-upload guard are ready but not yet executed on corrected bytes.

Coordinator committed the four requested correction files as
`a2ebe0cbfc2fb6625c8e82487373593cc4b3ddff` and dispatched Release `36008363622`.
Only coordinator changed Git history; all other uncommitted work is preserved.
Historical ten-file checksums/privacy validation passes after F2 correction:
eight ENOTCONN records classified by Git origin stacks, zero inferred
`injected-disconnect` categories. Await verified new pin.

New runtime pin independently verified: source
`a2ebe0cbfc2fb6625c8e82487373593cc4b3ddff`, Release `36008363622`,
artifact `10812015294`, 723857 bytes, SHA-256
`f861ecd4c3b3dad9310fbca9fe98ce64dac70bf4d74c37fc46e233769b3d3da7`.
Release verifier and 33-entry inspector pass. Source-matched PR Quality
`36008369921` and Release passed. New matrix output:
`_debug/rc-final-f861ecd4c3b3`; expected 24 scenarios per clean row plus 6 per
update row = 120 selected results, including F1 tree diagnostics/recovery.

New-matrix progress: VS Code/FTP clean (24) and update (6) passed on f861ecd4.
The clean evidence includes actual failed-folder status, full recovery actions,
real redacted clipboard diagnostics, read-only recovery, and hidden config
replacement without root rejections. First driver attempt reached that recovery
but expected a child of the correctly collapsed replacement root; explicitly
expanding the renamed root fixed the harness. First VS Code/SFTP attempt kept
the conflict picker open after a too-early mouse decision; the driver now
settles/hit-tests the picker before its single click. Failed attempts preserved;
unchanged candidate bytes, no blind mutation retries.

## Owner GUI pause — 2026-09-24 14:10 UTC

Coordinator relayed owner desktop interference and ordered immediate GUI pause.
Stopped owned matrix PID 17504 and scenario PID 34268. Their controller/editor
children were already gone when authenticated close was attempted; subsequent
CIM inspections showed no task-owned editor, Node controller/driver or MCP
process. Coordinator/task-watching shells were left untouched. No clipboard
diagnostic check was in progress (last selected observation was backup-restore).

The in-flight `cursor-ftp-clean-2` attempt is explicitly **INTERRUPTED /
unqualified**, preserved under `_debug/rc-final-f861ecd4c3b3`. It must not be
counted as PASS; accidental owner input is possible. Four VS Code rows passed
earlier on f861ecd4; all Cursor rows are incomplete. **Do not resume any GUI,
native input, editor launch or focus-changing test until coordinator relays
the owner's timing/isolation approval.** Only non-GUI work may continue.

Before the stop, native modal automation was corrected: Cursor's native
Continue/Cancel controls can both have ID 0, so parent WM_COMMAND is ambiguous.
The driver now focuses the owned root dialog and sends bounded BM_CLICK to the
actual button handle. Five sequential Cancel probes yielded zero connections,
then explicit Continue/credential save succeeded in a separate diagnostic profile.
That profile was closed before the interrupted matrix resumed; no product bytes
changed. The earlier failed Cursor attempt is retained.

## Exclusive GUI window authorized

Owner explicitly chose coordinator option 2: resume windowed tests now while
they temporarily leave keyboard/mouse unused (task decision comment
`9914e109`). This supersedes the pause for this testing window only.
All eight rows are running fresh in `_debug/rc-exclusive-f861ecd4c3b3`; prior
f861 rows are supplemental, not final sign-off. Notify the coordinator as soon
as all owned GUI processes close so the owner can use the desktop again.
Do not wait/watch the coordinator session; use ordinary bounded test-process
polling and receive steering messages between tool calls.

Exclusive window complete: all 8 fresh rows passed at first attempt, 120
selected results, 14:29:43–14:35:38 UTC. Post-run process inspection at
14:36:05 UTC found no owned editor/controller/driver/MCP processes; coordinator
immediately notified that the desktop was released. No further GUI testing is
authorized without another coordination window.

Reviewed export now at `docs/qa/rc-0.1.0-a2ebe0c/`: all four clean rows contain
`explorer-error-recovery` (categorized permission/actions, real redacted Copy
Diagnostics, explicit failed-folder marker, read-only recovery and hidden
config replacement). All eight rows have no lazy/retired-root error logs.
One shared synthetic predecessor SHA-256
`75d8661f65f650e67a5a8c6323bdf46a81355ca4878b5e8cfc54a4d43df04162`,
723391 bytes, version metadata only. Earlier shared-desktop results remain
supplemental and the interrupted row is never included in this sign-off.

Correction exit audit: final gate shell 1466 exit 0 — 60 suites, 522 passed,
1 pre-existing skipped, 523 total, 2 snapshots; lint/typecheck/compile;
FTP10/SFTP12 with open-handle detection; JS syntax/diff checks pass. Native
PowerShell parsing and 28 focused/helper/causal tests passed without GUI.
Package allowlist excludes QA/evidence, five maintainer-doc relative-link
checks pass, current and historical ten-file evidence checksums/privacy pass.
Defender AV/real-time/behavior monitoring remain enabled.

F1 corrected runtime and F2 corrected causal evidence are ready for the same
independent reviewer. Remaining generic renderer entries are not assigned
causality from their message alone; Git stacks and explicit fixture diagnostics
are separate. New source-matched Release/Quality are green for a2ebe0c; the
remaining uncommitted full R11 tooling/docs still need integration CI.

**HARD GUI LOCK for implementation AND review remains active.** Review source,
unit tests and fresh evidence non-GUI first. If additional GUI is necessary,
send the coordinator precise scope/time and obtain a new owner timing/isolation
agreement before launching anything. No waiting/watch on coordinator session.
