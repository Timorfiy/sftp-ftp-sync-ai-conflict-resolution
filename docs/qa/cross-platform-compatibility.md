# Cross-platform compatibility verification

Candidate: 0.9.0. Source branch: `feat/cross-platform-compatibility`.

## Local checks

Windows host, Node.js 24.14.1, npm 11.8.0. Core and protocol checks use temporary
files and loopback FTP/SFTP servers. The initial full suite passed 68 suites,
608 tests, with 7 skips (six POSIX permission scenarios require a POSIX runner).
The 10,000-file simulated and native watcher tests reported zero reverse uploads
and successful independent local edits. Later final checks are recorded below.

## Completed CI coverage

Source: `818e58d6f04384f794a6c09d1d6abe011da6885a`.
The [final Quality run](https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/actions/runs/36751864706)
completed successfully: **28/28 jobs passed**.

| Runner | Full quality and VSIX inspection | FTP / SFTP acceptance |
| --- | --- | --- |
| windows-latest | PASS | PASS / PASS |
| ubuntu-22.04 x64 | PASS | PASS / PASS |
| ubuntu-24.04 x64 | PASS | PASS / PASS |
| ubuntu-26.04 x64 | PASS | PASS / PASS |
| macos-14 ARM64 | PASS | PASS / PASS |
| macos-15 ARM64 | PASS | PASS / PASS |
| macos-26 ARM64 | PASS | PASS / PASS |
| macos-15-intel x64 | PASS | PASS / PASS |
| macos-26-intel x64 | PASS | PASS / PASS |

The separate macos-26 case-sensitive APFS job passed filesystem guards, modes,
save/rename suppression, 10,000-file simulated/native workloads and nested native
FTP/SFTP watcher regressions. All native tests retain zero reverse-upload and
independent-edit assertions; the flat stress workloads use direct directory
watches while the nested protocol workloads use recursive watches.

Final full suites: **68/68** on each quality runner. Windows passed **611** tests
with **7** skips (six POSIX mode scenarios and one existing skipped test).
POSIX runners passed **617** tests with **1** skip. The case-sensitive APFS job
passed **7 suites / 75 tests**. Sampled Windows, Ubuntu 24.04, macOS 26 and APFS
native stress logs recorded 10,000 completed/observed files, zero reverse uploads,
successful parallel edits and zero retained paths after cleanup; cancellation
completed 5,008 files and cancelled 4,992.

macOS binding tests add and remove `127.0.0.2` on the isolated runner's loopback
interface. Linux directory metadata is included in retention accounting; test
budgets leave space for that metadata before deliberately exceeding the quota.
Fixtures use owned temporary directories and clean them up.

The [first run](https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/actions/runs/36747558889)
identified Windows-only fixtures, client/server disconnect timing, macOS
loopback/FSEvents assumptions and the APFS format name. The
[second run](https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/actions/runs/36749665691)
passed Windows/macOS and APFS but exposed Linux metadata/watch cost differences.
The final run includes their corrections; no transfer-count or safety assertion
was removed and no timeout was increased.

macOS 14 Intel has no runner in this matrix. The Windows hosted runner does not
add manual Windows 10/11 or installed-editor qualification.

## Local release artifact

One universal `sftp-sync-ai-0.9.0.vsix` was built and inspected with the existing
release-bundle script. Tagging, merging to main and release publication were not
performed. Bundle provenance and SHA-256 are generated alongside the artifact.

## Unverified editor surfaces

No manual Linux/macOS execution in installed VS Code or Cursor was performed.
Editor UI, OS credential storage, and editor MCP integration remain unverified.
Standalone MCP stdio tests do not establish actual editor registration.

## UX boundary

The cross-platform system-notification adapter and its process tests were removed
from this change following the agreed scope correction. The existing Windows
mechanism remains until UX integration. Unified operations, grouped errors,
native editor notifications and Activity conflict actions belong to the UX task.
That task must use the shared local-path helpers and preserve conflict safety;
closing an action menu must not imply cancellation.
