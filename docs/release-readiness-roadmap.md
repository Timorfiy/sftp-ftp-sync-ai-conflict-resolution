# Release Readiness Roadmap

Status: approved by owner on 2026-09-23

The owner approved this roadmap in full. Approved choices and the remaining
decisions are recorded in section 8. Resolve remaining decisions before the
dependent work. Approval of the roadmap does not authorize first publication.

Audit date: 2026-09-23

Repository baseline: `254eeb3a9a3525d49bc5958b129f5467e7472d5e`

This document defines the work required to make SFTP/FTP Sync + AI Conflict
Resolution independently installable and safely usable by its first supported
audience. It is an audit and execution plan, not a claim that the planned work
has already been implemented.

## 1. Agreed Product Boundary

### Target user

The first supported user is an English-speaking developer or technical site
owner who:

- uses JSON at a basic level;
- already has valid server credentials and knows the intended remote path;
- uses VS Code Desktop or Cursor Desktop on Windows 10 or Windows 11; and
- can operate an already-running editor agent when using AI conflict
  resolution.

The first release does not promise support for every user, editor, operating
system, server, or AI provider.

### First-release product decisions

- Plain FTP and SFTP are mandatory and receive equal acceptance coverage.
- FTPS remains experimental until separately qualified.
- Remote-to-Local is the primary bulk-sync scenario.
- Bulk sync is manually invoked and is not AI-driven.
- Local-to-Remote bulk sync must require an explicit overwrite confirmation.
- Preview/dry-run sync is useful but does not block the first release.
- New generated configurations enable conflict checking and local text
  backups. Destructive watcher and sync deletion remain disabled.
- Existing configurations are not silently migrated.
- AI conflict resolution uses tools and instructions exposed to an
  already-running editor agent. The extension does not embed a model or own an
  AI-provider API key.
- The agent must be able to obtain conflict context and a diff, prepare the
  merged local file, resolve the conflict, and wait for the upload result
  without a mandatory manual click in the happy path. Manual conflict
  resolution remains available.
- The product uses publisher `Timorfiy`, a new extension ID, and a private
  command namespace. It is not an update, replacement, or migration path for
  `PhilipDaoud.sftp-neo`.
- Continuing to read `.vscode/sftp.json` is allowed as a convenience, not as a
  migration promise.
- The intended channels are Visual Studio Marketplace, Open VSX, and the same
  VSIX attached to GitHub Releases. Tag automation prepares and publishes the
  artifact, but first publication is a separate owner-approved operation.
- English is the only supported interface and instruction language for the
  first release.

### Explicit non-goals for the first release

- macOS or Linux qualification;
- support for less-technical users through a setup wizard;
- preview/dry-run bulk sync;
- guaranteed explicit or implicit FTPS behavior;
- universal binary backups or recovery for every deletion mode;
- an embedded model, extension-managed AI account, or provider API key;
- migration from or coupling to the PhilipDaoud extension identity; and
- automatic changes to existing user configurations.

## 2. Testable Definition of the First Usable Release

The release is ready when an English-speaking developer or technical site owner
on Windows 10/11 can, from a clean VS Code Desktop or Cursor Desktop profile:

1. obtain the extension from the editor's intended registry or install the
   matching GitHub Release VSIX;
2. create a safe FTP or SFTP configuration without author-only knowledge;
3. test credentials, connectivity, permissions, and `remotePath` without
   writing or deleting remote data;
4. perform a first upload and download;
5. manually run Remote-to-Local sync;
6. understand and explicitly approve a Local-to-Remote bulk overwrite;
7. receive an actionable, redacted error and recovery path for representative
   configuration, authentication, network, path, permission, host-key,
   conflict, backup, and transfer failures;
8. use manual conflict resolution; and
9. ask an already-running supported editor agent to inspect a conflict, update
   the local file with the resolved content, resolve the conflict, and report
   whether the upload succeeded, failed, or became stale.

The release must also demonstrate that:

- destructive delete options are off in newly generated configurations;
- secrets are absent from configuration examples, logs, diagnostics, packaged
  files, and test artifacts;
- plain FTP users receive a clear warning that credentials and content are not
  transport-encrypted;
- SFTP host-key changes remain rejected;
- conflict state cannot be uploaded or synchronized and is cleaned according
  to a bounded retention policy;
- FTP and SFTP pass equivalent deterministic loopback acceptance scenarios;
- all intended JS and TS test suites run from the standard Windows command and
  Jest exits without leaked asynchronous handles;
- the same built-once VSIX passes package inspection and installation in both
  editors; and
- a release dry-run validates tag, version, checksums, release notes, and all
  three delivery destinations without performing the first publication.

Real servers and external AI services are not required for release
qualification. Loopback protocol fixtures, a scripted fake agent, and
fresh-profile editor checks provide deterministic evidence.

## 3. Current-State Evidence

Labels have strict meanings:

- **Verified**: observed in the baseline repository or command output.
- **Unverified**: plausible or required behavior not exercised in its real
  editor/protocol environment.
- **Hypothesis**: a risk inferred from verified implementation details and
  requiring a focused reproduction.

| Status | Area | Observation and evidence | Release implication |
| --- | --- | --- | --- |
| **Verified** | Clean install | `npm.cmd ci --no-audit --no-fund` succeeded with 498 packages and deprecated `glob@10.5.0` warnings. | Dependency installation is reproducible at the audited lockfile, with maintenance warnings to triage separately. |
| **Verified** | Standard tests | `npm.cmd test -- --runInBand` exited successfully but ran only 5 TypeScript suites: 29 passed and 1 skipped. `package.json#jest.testMatch` uses `<rootDir>/test/**/*.spec.js`, which did not discover the 18 JS suites on Windows. | The current green command is not a trustworthy regression gate. |
| **Verified** | Hidden JS tests | A diagnostic path-neutral Jest match ran 18 suites and 194 tests, but Jest reported open asynchronous handles. There are 18 `test/**/*.spec.js` files and 5 TS `*-test.ts` files in the baseline. | Test discovery and lifecycle cleanup block release confidence. Exact expected totals must be asserted after the gate is repaired. |
| **Verified** | Static/build checks | `npm.cmd run lint`, `.\node_modules\.bin\tsc.cmd --noEmit`, and `npm.cmd run compile` passed. Webpack emitted a production bundle of approximately 994 KiB. | Compilation works locally, but bundle size and package contents still need release gates. |
| **Verified** | Packaging | `npm.cmd run package` failed after clean install because `vsce` was not found. `package.json` invokes `vsce package`, but neither `@vscode/vsce`/`vsce` nor `ovsx` is pinned. | A clean checkout cannot produce the install artifact promised by the README. |
| **Verified** | CI | `.github/workflows/codeql-analysis.yml` and `devskim-analysis.yml` target `master`, while the repository branch is `main`; neither runs install, tests, lint, typecheck, compile, or packaging. | There is no automated quality or release gate on the active branch. |
| **Verified** | Identity | `package.json` declares `publisher: PhilipDaoud`, `name: sftp-neo`, and public commands under `sftp.*`. | The manifest does not yet represent the agreed standalone Timorfiy product and namespace. |
| **Verified** | Distribution state | The 2026-09-23 audit found no repository tags or GitHub Releases and no tag-based release workflow. Existing PhilipDaoud registry identities are not this standalone product. | Registry and update claims must wait for a reproducible independent artifact and owner-approved first publication. |
| **Verified** | Install instructions | `README.md` tells users to install a VSIX built from the repository, while the audited clean checkout cannot package one. | The first user path currently starts with a broken promise. |
| **Verified** | Generated config | `src/modules/config.ts:92` defaults `conflictCheck` to `false` and backups to disabled/remote. The generated file at `src/modules/config.ts:221` includes disabled remote backups and does not enable conflict checking. | Newly generated configs do not use the agreed first-release safety defaults. |
| **Verified** | Connection check | No contributed `Test Connection` command appears in `package.json`; configuration is first exercised by browse or transfer behavior. | A user cannot safely isolate setup errors before an operation. |
| **Verified** | Conflict guard | `src/fileHandlers/transfer/conflictCheck.ts#createConflictLifecycle` checks remote metadata before Local-to-Remote overwrite. FTP with unavailable exact modification time becomes `timestamp-unavailable`. | A useful guard exists, but it is optional and needs protocol-level acceptance. |
| **Verified** | Manual conflict UI | `src/fileHandlers/transfer/conflictBridge.ts` offers diff, overwrite, overwrite-all, and cancel; decision requests are revision checked before acceptance. | Manual fallback and stale-decision primitives exist. |
| **Verified** | Agent integration gap | The bridge accepts file-protocol requests marked as source `mcp`, but the repository contains no shipped MCP server/tool registration or user setup path. | The AI product claim is not independently usable yet. |
| **Unverified** | Autonomous AI flow | No supported-editor acceptance run has shown an agent reading context/diff, writing the resolved local file, resolving, and waiting for final upload status without manual action. | This full flow is a release blocker, not an assumed capability. |
| **Verified** | Conflict storage | `src/extension.ts#activate` initializes the bridge for every workspace. `src/fileHandlers/transfer/conflictBridge.ts#initializeConflictBridge` eagerly creates `.kent-tmp/sftp-conflicts`; records contain absolute paths, snapshots, requests, responses, and status. | Internal conflict data currently lives inside the user's project before a conflict occurs. |
| **Verified** | Conflict cleanup/exclusion | Bridge disposal removes only its current `bridge.json`; stale snapshot cleanup can fail open. No runtime transfer exclusion for `.kent-tmp/sftp-conflicts` was found in `src/core/fileService.ts`, and no complete size/age bound was found. | Isolation, transfer exclusion, privacy, and bounded cleanup block the public AI flow. |
| **Hypothesis** | Conflict data upload | Because conflict state is under the workspace and is not automatically excluded by runtime transfer rules, a broad upload/sync may send snapshots or metadata to the configured destination. | Reproduce with an isolated filesystem test; regardless, explicitly exclude internal state by construction. |
| **Verified** | Overwrite backups | `src/core/transferTask.ts` calls `src/core/backup.ts#createBackup` before Local-to-Remote overwrite when enabled. Backup content is text-classified; binary content is skipped. `createBackup` returns `null` on failure and the upload continues. | Backups are not a universal undo guarantee and overwrite backup failure is fail-open. |
| **Verified** | Delete backups | `backupBeforeDelete` is fail-closed, and manual remote deletion has modal confirmation in `src/commands/fileCommandDeleteRemote.ts`. `docs/options.md` states that `backup.onDelete` does not cover `syncOption.delete`. | Manual deletion has useful protection; sync deletion needs separate promises and tests. |
| **Verified** | Bulk sync warning gap | `src/fileHandlers/transfer/index.ts` blocks only the combination `conflictCheck + syncOption.delete`. No general Local-to-Remote bulk overwrite confirmation was found. | The agreed bulk warning is still missing. |
| **Verified** | Credentials | `src/modules/secrets.ts#getKey` uses only host, username, and secret type under the `sftp-neo` prefix. Protocol, port, workspace, and profile are absent. | Different endpoints can address the same stored-secret key. |
| **Hypothesis** | Credential collision | Two endpoints sharing host and username but differing by protocol or port may retrieve the same password/passphrase. | Prove with SecretStorage tests and replace with endpoint-scoped identity plus an explicit migration policy for this product's own stored values. |
| **Verified** | FTP transport | `src/modules/config.ts` defaults FTP `secure` to `false`; no first-run warning for plain FTP was found. Secret Storage protects local storage, not network transport. | Plain FTP requires an explicit, non-suppressive-at-first-use security explanation. |
| **Verified** | SFTP host key | `src/core/remote-client/hostKeyStore.ts` scopes host keys by host, port, and workspace and rejects changed keys. | Preserve and acceptance-test this safe behavior. |
| **Unverified** | Live protocols | No real server was contacted. FTP/SFTP first transfer, reconnect, permissions, server quirks, and conflict behavior were not qualified end-to-end in this audit. | Use deterministic loopback fixtures; label real-server compatibility by tested contract, not anecdote. |
| **Verified** | Error experience | `src/helper/error.ts#reportError` generally displays the error string and a `Detail` action that opens Output. | Failures lack a consistent category, safe next action, and documented recovery path. |
| **Verified** | Documentation drift | `README.md`, `FAQ.md`, `docs/commands.md`, `docs/options.md`, schema files, and runtime defaults contain stale upstream links, JSON examples with comments, differing defaults/paths, and safety claims that require qualification. | Documentation must follow stabilized behavior and be checked as an executable release surface. |
| **Unverified** | Fresh-profile journey | Installation, update, configuration, first transfer, recovery, manual conflict, and agent conflict flows have not been signed off in clean VS Code and Cursor profiles on Windows. | Final release acceptance must exercise the whole journey in both editors. |

## 4. Risk Register

| Risk | Evidence/status | Impact | Required control |
| --- | --- | --- | --- |
| Existing remote content is overwritten by upload or Local-to-Remote sync. | Verified capability; broad sync confirmation absent. | Data loss or unintended deployment. | Safe new defaults, conflict checks, explicit bulk confirmation, text backups with accurate limitations, and loopback tests. |
| Destination-only content is deleted by watcher or sync options. | Verified destructive options; defaults are currently false; `syncOption.delete` is outside `backup.onDelete`. | Recursive remote or local deletion. | Keep defaults off, identify direction and scope in confirmations/docs, fail closed where backup is promised, and test cancellation/recovery. |
| Users believe backups cover all files and failure modes. | Verified text-only classification and fail-open overwrite backup. | False recovery confidence. | Precisely state text-only scope, retention, fail-open/fail-closed boundaries, and unsupported sync-delete recovery. |
| Conflict snapshots or absolute paths leave the project or accumulate. | Verified in-workspace eager state; upload is a hypothesis until reproduced. | Source disclosure, path disclosure, repository clutter, or unbounded disk use. | Store lazily outside transfer scope or hard-exclude by construction; define age/count/size retention and cleanup/recovery. |
| Credentials are reused across distinct endpoints. | Verified key inputs; collision behavior is a hypothesis until tested. | Authentication with the wrong secret and confusing failures. | Endpoint-scoped key including protocol/host/port and appropriate workspace/profile identity; tested migration and deletion. |
| Plain FTP is mistaken for a secure credential path. | Verified `secure: false` behavior and no onboarding warning found. | Credential and content interception. | Explicit first-use warning and documentation; keep FTPS claims separate until qualified. |
| SFTP identity changes are bypassed or poorly explained. | Changed-key rejection is verified; user recovery is not. | Man-in-the-middle exposure or support dead end. | Preserve rejection, add actionable safe recovery, and test known/new/changed keys. |
| AI resolves against stale content or reports success too early. | Revision checks and upload statuses exist; complete tool flow is unverified. | Wrong merge uploaded or false success. | Tool contract must revalidate revisions and expose terminal uploaded/failed/stale state. |
| Raw errors expose secrets or provide no safe next step. | Generic raw-message path verified; systematic redaction unverified. | Secret leakage, repeated destructive retries, abandonment. | Typed error categories, redaction tests, safe diagnostics, and scenario-specific recovery. |
| Users cannot install or update consistently. | Clean packaging failure and absent release pipeline verified. | No self-service adoption or trustworthy updates. | Pin packaging tools, build once, inspect contents, dry-run release, then separately approve first publication. |
| Editor or OS assumptions leak into the release promise. | Windows-only test discovery bug verified; live Cursor/VS Code flow unverified. | Unsupported combinations appear supported. | Publish explicit Windows/editor/minimum-version bounds backed by fresh-profile acceptance. |

## 5. Prioritized Delivery Phases

### Phase A — Establish a trusted engineering and artifact baseline

Complete R0, then R1. The project must first know whether regressions exist and
must be able to build the exact artifact under test. Without these foundations,
later behavior and documentation cannot be accepted reliably.

### Phase B — Make protocol and conflict behavior deterministic and contained

Complete R2 and R3. FTP/SFTP acceptance fixtures establish the shared behavior
contract, while conflict-state isolation removes a concrete privacy and
transfer risk before exposing agent tooling.

### Phase C — Complete the defining conflict-resolution experience

Complete R4. This is the product's differentiator and must be tested through a
standard tool contract, a fake agent, both editors, and both mandatory
protocols. Manual fallback remains part of acceptance.

### Phase D — Make first use and destructive operations safe

Complete R5, R6, and R7. These tasks establish safe generated configuration,
non-destructive connection validation, transport warnings, endpoint-scoped
credentials, and deliberate bulk overwrite behavior.

### Phase E — Make failures and instructions self-service

Complete R8 and R9 after the underlying behavior stabilizes. Error recovery,
README, schema, command help, and examples must describe what the tested
product actually does, including limitations.

### Phase F — Prepare delivery and prove the complete journey

Complete R10 and R11. Release automation must build one artifact and dry-run
all destinations without performing first publication. The resulting release
candidate must pass fresh-profile install and update acceptance in VS Code and
Cursor on Windows.

### Deferred improvements

- **P1:** preview/dry-run bulk sync with file selection;
- **P1:** explicit and implicit FTPS qualification, including current `secure`
  behavior;
- **P1:** broader binary and `syncOption.delete` backup/recovery coverage;
- **P1/P2:** macOS and Linux support matrices, including MCP/tool sandbox
  differences; and
- **P2:** guided setup for less-technical users.

## 6. Independently Verifiable Task Proposals

These are proposals only. They must not be created or started in Kent until the
owner approves this roadmap.

### R0 — Restore a trusted quality gate (M)

- **User problem:** A green standard test command hides most regression suites
  on Windows, leaks async handles in the wider diagnostic run, and has no
  active-branch CI gate.
- **Outcome:** One standard command discovers all JS and TS suites
  cross-platform, exits cleanly, and `main` CI checks install, tests, lint,
  typecheck, and compile.
- **Scope:** Jest matching and lifecycle cleanup; quality CI only. No release
  publication.
- **Acceptance:** Clean `npm ci` succeeds; all 23 baseline suites are
  discovered by the standard command; the exact passed/skipped totals are
  asserted after repair; no open-handle warning remains; Windows is mandatory
  in CI, with Linux available for later packaging work.
- **Verification:** Local Windows run plus GitHub Actions logs/artifacts.
- **Dependencies:** None.
- **Size:** M.

### R1 — Establish independent identity and reproducible VSIX packaging (M)

- **User problem:** A clean checkout cannot build the advertised VSIX, and the
  manifest still belongs to another publisher/ID and namespace.
- **Outcome:** A pinned toolchain produces one inspected VSIX for the agreed
  standalone `Timorfiy.<new-id>` identity and private command namespace.
- **Scope:** Manifest identity, command IDs/context keys where required,
  package scripts/dependencies, package allowlist, and local installation
  smoke tests. No publication.
- **Acceptance:** `npm ci` through quality gate and `npm run package` needs no
  global tools; manifest metadata is internally consistent; the package
  contains no secrets, fixtures, `.kent-tmp`, or unnecessary sources; the same
  VSIX installs in clean VS Code and Cursor profiles; `.vscode/sftp.json`
  remains readable without promising migration.
- **Verification:** `vsce ls`, unpacked-content allowlist, checksum, and
  installation smoke tests.
- **Dependencies:** R0; owner decision on exact package name, display name, and
  command prefix.
- **Size:** M.

### R2 — Add deterministic loopback FTP/SFTP acceptance fixtures (L)

- **User problem:** Mandatory protocols are not proven end-to-end and real
  servers are unsuitable as a repeatable gate.
- **Outcome:** Local fixtures exercise FTP and SFTP through one user-facing
  acceptance contract.
- **Scope:** Plain FTP and SFTP connection, browse, upload, download,
  reconnect/failure, remote change, and conflict metadata. FTPS is not gating.
- **Acceptance:** Both protocols pass first transfer, changed-remote,
  unknown-FTP-timestamp, authentication/path/permission failure, retry, and
  disconnect cases without external network access or committed secrets.
- **Verification:** Windows CI matrix with deterministic loopback servers and
  isolated ports/filesystems.
- **Dependencies:** R0.
- **Size:** L.

### R3 — Isolate and bound conflict state (M)

- **User problem:** Internal conflict snapshots and metadata are eagerly
  written under the project, can be considered for transfer, and have no
  complete bounded lifecycle.
- **Outcome:** State is lazy, private from transfer/sync, bounded by an approved
  retention policy, recoverable after interruption, and user-clearable.
- **Scope:** Storage location, transfer exclusion, privacy, retention,
  stale/orphan handling, and cleanup. No AI reasoning.
- **Acceptance:** Normal activation creates no project artifact; no upload or
  sync can transfer conflict state; records and snapshots obey age/count/size
  limits; crash/restart cases are tested; cleanup does not erase an active
  decision; the user can clear state safely.
- **Verification:** Unit/integration tests with temporary workspaces and
  assertions for exclusion, retention, restart, and cleanup.
- **Dependencies:** R0; owner retention decision.
- **Size:** M.

### R4 — Ship agent tools and autonomous conflict-result flow (L)

- **User problem:** The existing bridge is an internal file protocol, not a
  discoverable feature an editor agent can use.
- **Outcome:** A standard MCP/tool layer and English instructions let supported
  VS Code and Cursor agents list/get conflict context, inspect local and remote
  content/diff, submit or acknowledge resolved local content, resolve/cancel
  with revision validation, and wait for the upload result.
- **Scope:** Editor-agent tools and instructions using the editor's existing
  model. No embedded model, provider SDK, or extension-owned API key. Manual UI
  remains.
- **Acceptance:** A scripted fake agent and manual editor smokes for FTP and
  SFTP complete remote change → context/diff → local merged file → stale
  revalidation → upload → `uploaded`; stale decisions are rejected; upload
  failures return to the agent; the happy path needs no manual click.
- **Verification:** Tool contract tests, race/revision tests, loopback E2E, and
  both-editor smoke evidence.
- **Dependencies:** R2 and R3; packaged delivery relies on R1.
- **Size:** L.

### R5 — Provide safe generated config and Test Connection (M)

- **User problem:** A new user receives safety features disabled and can only
  discover connection mistakes through browsing or transfer.
- **Outcome:** New configs enable conflict checking and local text backups,
  keep all destructive deletion off, and expose a read-only Test Connection
  command with actionable results and a plain-FTP warning.
- **Scope:** Generated configuration, validation, onboarding, and
  non-destructive connection probing. No less-technical wizard and no silent
  migration.
- **Acceptance:** Only newly generated configs receive the agreed defaults;
  existing files are unchanged; Test Connection distinguishes config, auth,
  network, remote-path, and permission failures without remote writes/deletes;
  plain FTP clearly explains transport risk.
- **Verification:** Config tests, loopback failure matrix, and fresh-profile
  walkthrough.
- **Dependencies:** R2.
- **Size:** M.

### R6 — Scope credentials to endpoints and verify redaction (M)

- **User problem:** Stored keys can collide across endpoints, and secret
  redaction is not proven across logs, errors, diagnostics, and packages.
- **Outcome:** Credentials use an immutable endpoint identity and all supported
  diagnostic surfaces are covered by redaction tests.
- **Scope:** This standalone Timorfiy product's credentials and migration of
  its own earlier stored values. No PhilipDaoud extension migration.
- **Acceptance:** Protocol/port-distinct endpoints cannot read each other's
  secrets; password, passphrase, and interactive answers never appear in
  logs/errors/exports/packages; plaintext-config warnings remain; users can
  delete saved credentials.
- **Verification:** SecretStorage mocks, collision/migration tests, log
  snapshots, and package inspection.
- **Dependencies:** R1 and R2.
- **Size:** M.

### R7 — Require explicit Local-to-Remote bulk confirmation (S/M)

- **User problem:** Bulk upload can overwrite many remote files without a
  dedicated product warning.
- **Outcome:** Local-to-Remote sync requires a modal confirmation naming the
  profile and paths; Remote-to-Local remains the primary manual scenario with
  accurate overwrite/recovery language.
- **Scope:** Confirmation, direction labels, cancellation, and delete-enabled
  wording. No preview UI and no AI participation in bulk sync.
- **Acceptance:** Cancel changes no files; confirmation is mandatory for
  Local-to-Remote; delete-enabled variants explicitly identify the deletion
  direction; agent tools cannot initiate an AI-driven bulk sync.
- **Verification:** Command tests and loopback cancellation/confirmation
  smoke.
- **Dependencies:** R2 and R5.
- **Size:** S/M.

### R8 — Make errors and recovery actionable (M)

- **User problem:** Raw errors plus Output require internal knowledge and do
  not consistently tell users what is safe to do next.
- **Outcome:** Configuration, auth, network, path, permission, host-key, FTP
  timestamp, conflict, backup, packaging, and transfer failures map to
  redacted messages, safe next actions, and specific troubleshooting sections.
- **Scope:** Error taxonomy, messages, partial-result handling, recovery links,
  and safe diagnostics. No telemetry.
- **Acceptance:** Representative fixtures produce distinct actions; retry and
  cancel do not hide partial results; backup fail-open and delete fail-closed
  behavior are stated accurately; diagnostics contain no secrets.
- **Verification:** Message/snapshot tests and a manual failure walkthrough.
- **Dependencies:** R2, R3, and R6.
- **Size:** M.

### R9 — Align English README, schema, commands, and help (M)

- **User problem:** Current instructions contain stale links, invalid strict
  JSON examples, mismatched defaults, and an AI promise without a standalone
  setup path.
- **Outcome:** One accurate English path covers Windows VS Code/Cursor install,
  FTP/SFTP setup, Test Connection, first transfer, Remote-to-Local sync,
  Local-to-Remote warning, manual and agent conflict resolution, recovery,
  update, security, limitations, and support.
- **Scope:** User documentation and schema after behavior stabilizes. The
  preview-sync RFC remains an unapproved P1 proposal.
- **Acceptance:** Examples parse as strict JSON; runtime, generated config, and
  schema defaults agree; links belong to this product; FTP/FTPS and backup
  limits are precise; a target test user completes the journey without author
  assistance.
- **Verification:** JSON parsing, link checking, docs/runtime/schema checklist,
  and fresh-user review.
- **Dependencies:** R1 and R4 through R8.
- **Size:** M.

### R10 — Add tag-based build-once release automation without first publication (M)

- **User problem:** There is no reproducible update channel or proof that all
  destinations receive the same binary.
- **Outcome:** Version tags run the quality gate, build one VSIX, validate
  tag/version, generate checksum/release notes, and use that artifact for
  Marketplace, Open VSX, and GitHub Release.
- **Scope:** Workflow, permissions, secret contract, and dry-run. Do not add
  tokens to the repository and do not execute first publication.
- **Acceptance:** A manual/dry-run path works without publish secrets; publish
  jobs use protected environment secrets such as `VSCE_PAT` and `OVSX_PAT`,
  minimal permissions, and no rebuild; a single-channel failure is visible and
  retryable without changing the binary.
- **Verification:** Workflow validation/actionlint and a non-publishing dry-run
  using R1's inspected artifact.
- **Dependencies:** R0, R1, and R9; owner tag-approval policy.
- **Size:** M.

### R11 — Qualify release-candidate install, update, and complete journey (M)

- **User problem:** No evidence proves that a new user can independently
  install, update, configure, transfer, recover, and resolve conflicts in both
  supported editors.
- **Outcome:** A versioned RC passes a fresh-profile VS Code/Cursor Windows
  matrix and an upgrade between two local VSIX versions.
- **Scope:** Loopback protocols and scripted/fake agent only; no real
  publication, server, or external AI service.
- **Acceptance:** Install → config → Test Connection → first transfer →
  Remote-to-Local sync → bulk warning → manual conflict fallback → autonomous
  agent conflict resolution → backup restore → error recovery → extension
  update all pass; the product's own configs and secrets survive the documented
  update path.
- **Verification:** Signed manual QA checklist with editor/OS versions, logs or
  screenshots, and artifact checksums.
- **Dependencies:** R1 through R10.
- **Size:** M.

## 7. Recommended First Task

Start with **R0 — Restore a trusted quality gate** after roadmap approval.

It has no product dependency, exposes the repository's real regression state,
and prevents every later task from being accepted against a Windows command
that silently skips 18 JS suites. R1 should follow immediately so all later
editor and protocol checks run against a reproducible candidate artifact.

## 8. Owner Decisions

### Approved on 2026-09-23

- Package name: `sftp-sync-ai`; publisher: `Timorfiy`; extension ID:
  `Timorfiy.sftp-sync-ai`.
- Display name: `SFTP/FTP Sync + AI Conflict Resolution`.
- Private command prefix: `sftpSyncAI` (case-sensitive, capital `AI`).
- Initial standalone version: `0.1.0`. This does not authorize publication or
  imply an update/migration from `PhilipDaoud.sftp-neo`.
- Conflict-state retention: 90 days, at most 250 inactive/terminal or
  restart-orphaned records per workspace, 500 MiB total state, and 100 MiB per
  snapshot. Cleanup must preserve active decisions. If a new snapshot cannot
  fit without deleting active state, it is unavailable with an explicit
  storage-limit reason; working files must not be silently overwritten.
  These limits concern internal conflict state, not ordinary local backups.
- Ordinary local text backups: retain 100 versions per file in newly
  generated configurations. Existing configurations remain unchanged.
- Minimum editor versions: VS Code 1.104.0 and Cursor 3.17.8, with the complete
  first-release AI/MCP feature set. Do not preserve a separate VS Code 1.90
  non-AI support tier. State actual tested versions separately from the
  declared support floor.
- Autonomous coordination: at most three independent tasks run concurrently.
  After independent review and mandatory verification pass, the coordinator
  may accept results, integrate code, push/open PRs, and start ready dependent
  tasks. Prerequisite code must be included in the source branch first.
  Unresolved product choices, scope expansion, real external services, and
  first publication still require owner decisions. Unperformed mandatory
  checks are not silently waived.

### Remaining decisions

Decide whether every publish tag requires manual GitHub Environment approval
or a protected/signed version tag itself authorizes publishing before the
dependent release-automation work. First publication remains separately
authorized in either case.

### Owner-approved verification deferral — 2026-09-24

The independent human fresh-user/usability walkthrough of the README is
deferred until before first publication. Independent agent documentation
validation and the required functional, real-editor, loopback, and CI checks
continue for the release candidate; they are not substitutes for human
usability evidence. The risk remains that a new target user may encounter
unclear instructions. R9 can complete after its other criteria pass, and R11
must retain this human check in the pre-publication checklist without claiming
it passed. This decision does not authorize publication or defer functional QA.

## 9. Acceptance and Traceability Checklist

### SFTPSYNC-1 requirement coverage

- [x] Target user, editors, OS, language, protocols, AI role, sync direction,
  and intended distribution are explicitly bounded.
- [x] “Any user” is replaced by a testable first-release definition without
  claiming support for all environments.
- [x] Install, configuration, first transfer/sync, conflicts, errors,
  recovery, and update are represented in evidence and planned acceptance.
- [x] README, examples, commands, errors, help, and promise/capability drift
  are audited.
- [x] Overwrite/delete, backups, credentials, FTP/SFTP, conflict state, and
  unsupported environments are represented in evidence and risks.
- [x] AI dependencies are explicit: an existing editor agent and shipped tool
  layer are required; no embedded model or extension API key is planned;
  manual fallback remains.
- [x] Build, tests, CI, packaging, release automation, and distribution
  channels are covered without choosing or executing first publication.
- [x] Facts, unverified scenarios, and hypotheses use separate labels.
- [x] Blockers, improvements, dependencies, deferred work, and priority
  rationale are explicit.
- [x] Each proposed task states user problem, outcome, scope, acceptance,
  verification, dependencies, and relative size.
- [x] The quality-gate task is recommended first.
- [x] Remaining owner decisions are listed.

### Completion boundary for this roadmap task

- [x] No extension behavior, existing user documentation, schema, dependency,
  CI workflow, or Git history is changed by SFTPSYNC-1.
- [x] No VSIX is published and no follow-up Kent task is created or started.
- [x] No real server or external AI service is used.
- [x] Owner gives final approval to this roadmap.
- [ ] Remaining owner decisions in section 8 are resolved before the dependent
  work.

The implementation of R0-R11 is outside SFTPSYNC-1.
