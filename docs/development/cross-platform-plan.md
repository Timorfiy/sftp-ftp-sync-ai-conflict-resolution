# Cross-platform implementation and UX boundary

## Compatibility work

Target Ubuntu Desktop 22.04/24.04/26.04 LTS x64 and macOS 14/15/26 on supported
Intel/Apple Silicon hardware. Keep Windows 10/11, editor minimums, configuration,
MCP protocol and a single universal VSIX. Complete paths/case handling, staged
download modes, watcher behavior, SSH quoting, SecretStorage portability,
portable fixtures, the nine-runner CI matrix and case-sensitive APFS tests.

## Shared path contract for Activity

Activity must import `localPathKey` and `localPathContains` from the existing
`src/helper/localPaths.ts` module. Runtime operation/conflict grouping uses
these helpers; Activity must not add case folding, separator replacement,
string-prefix membership checks, or another path-normalization implementation.
Normalization belongs to the extension-host model. If Activity uses a webview,
send it the host-computed keys; do not import Node filesystem code into its renderer.
Keep original path spelling for display and filesystem I/O; runtime keys are
only for matching, indexing and grouping.
Register roots with `registerLocalPathRoot` and release registrations when the
owning scope closes. Existing extension/workspace registrations already cover
normal Activity operation. Do not persist runtime keys as replacements for
credential keys or existing workspace bucket IDs.

## Separate UX work

The UX task owns unified operation state, grouped errors, native editor
notifications, and the Activity conflict list. It replaces automatic Quick Pick
opening with actions chosen from Activity. Preserve conflict resolution actions,
revision/candidate checks, explicit destructive decisions, and transfer safety.
Closing an Activity action menu must not cancel a pending upload; cancellation
requires an explicit action. This compatibility change does not implement that
transition or a competing notification/conflict UI.

The Activity integration replaces the previous Windows notification mechanism
with native editor notifications and explicit conflict actions. Cross-platform system-notification adapters, helper-process
timeouts/fallbacks, Windows sound preservation work, associated process tests,
and system-notification requirements are excluded.

## Verification and delivery

Use temporary files and loopback FTP/SFTP fixtures only. Keep deterministic
10,000-file assertions and native watcher liveness/behavior checks. All required
Quality jobs must pass before the existing release workflow builds one inspected
bundle. Publication remains a separate step. Preserve historical Windows QA.

Report actual CI results separately from manual editor qualification. README
and release notes must disclose AI-assisted implementation and the absence of
manual Linux/macOS verification, using **Editor UI**, credential storage and
editor MCP integration as the unverified surfaces.
