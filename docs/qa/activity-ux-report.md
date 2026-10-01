# Activity UX verification — 2026-10-01

## Pre-release candidate and source

- The Windows QA below was completed on `feat/activity-interface` before release preparation, with the implementation still uncommitted.
- Base commit: `6a1487e0c0171a98e49a539e8a0d45cb443ba0da`. This is the base revision, not a claim that the commit contains the implementation.
- Candidate: `_debug/activity-ux-final/sftp-sync-ai-0.9.0.vsix`, 1643047 bytes.
- SHA-256: `20524cdadfeb25c04083760c30ad8c5a7b9976af9c14754689aa529569743aa7`.
- One universal VSIX; this was a local 0.9.0 development candidate. It was not published. The final tag workflow produces its own immutable, source-matched release bundle.
- Changed-source hashes: `_debug/activity-ux-final-editors/source-files.json`.

## Automated checks

- Full Jest run passed: 70 suites, 628 passed, 7 skipped, 2 snapshots. Later UI/cancellation/grouping additions were verified on the final source with all 69 other suites: 628 passed, 7 skipped, 2 snapshots.
- The remaining scale suite passed four 10,000-file simulated/native cases in the full run: zero reverse uploads, independent edits preserved, zero retained paths after cleanup. The final amendments concern Activity grouping and cancellation bookkeeping; watcher/content-suppression logic is unchanged.
- TypeScript `--noEmit`, ESLint, webpack compilation and Git whitespace checks passed.
- Loopback acceptance: FTP 10/10; SFTP 12/12, with open-handle detection.
- VSIX inspection passed: 35 entries, no forbidden paths or secret canaries.
- New tests cover logical retries with retained failure history, multiple profiles, partial/cancelled outcomes, menu dismissal, explicit conflict cancellation, agent prompts, filters, badges, background error episodes, one-second arrival windows and overlapping-task cancellation.
- Existing bridge/MCP protocol, revision, dirty-buffer, snapshot and stale-generation regression tests passed. The GUI smoke does not claim a new full editor-MCP/SecretStorage qualification.

## Installed Windows editor checks

Host: win32 10.0.26200 x64. The exact inspected candidate was installed into fresh isolated profiles; installed files were verified against the VSIX. No production endpoint, account credentials or external AI provider was used.

| Editor | Protocol | Result |
| --- | --- | --- |
| VS Code 1.139.1 | FTP | PASS |
| VS Code 1.139.1 | SFTP | PASS |
| Cursor 3.22.7 | FTP | PASS |
| Cursor 3.22.7 | SFTP | PASS |

Each row exercised real uploads and exact loopback bytes, grouped Activity rows, keyboard filtering, native dark/light rendering, a conflict without an automatic picker, Escape preserving pending state, native diff, Copy Agent Prompt with clipboard restoration, and explicit cancellation preserving remote content.

Raw observations and PNGs: `_debug/activity-ux-final-editors/<editor>-<protocol>/` and `report.json`. Theme selection uses actual installed theme IDs and disables OS theme detection only in disposable QA profiles. It does not modify the user's editor settings.

This is installed-editor automation plus visual inspection, not an independent human fresh-user walkthrough. Earlier failed driver attempts are retained separately under `_debug/`; they are not scored as passes.

## Remaining qualification

- Ubuntu and macOS Intel/Apple Silicon installed-editor UI, credential storage and editor MCP registration were not checked on this Windows host; preliminary compatibility status remains.
- Existing multi-OS/architecture CI and case-sensitive APFS jobs are preserved, but no new GitHub Actions run is claimed for these unpushed changes.
- Windows support floors are unchanged; this report records actual tested builds and does not claim a fresh Windows 10 or minimum-editor-version run.
- No user `.vscode/sftp.json` was changed. QA configurations used loopback fixtures only.

## Release preparation

The owner authorized publishing the combined 0.9.0 release on 2026-10-01.
The release includes both the prior cross-platform work and Activity. Release
notes are the matching CHANGELOG section. The GitHub tag workflow must complete
its multi-platform quality gate and channel validators before publication.
Use the final GitHub Release VSIX and checksum for manual store uploads, rather
than any historical local QA candidate above. Marketplace/Open VSX availability
is verified separately. Preliminary Linux/macOS qualification limits still apply.

Final local release-preparation validation on 2026-10-01 passed all 70 Jest
suites: 632 passed, 7 skipped, 2 snapshots. This includes all four 10,000-file
scale cases on the final source. TypeScript, ESLint and release-documentation /
workflow tests also passed before creating the version tag.
