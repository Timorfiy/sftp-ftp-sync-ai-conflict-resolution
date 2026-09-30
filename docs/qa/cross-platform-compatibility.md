# Cross-platform compatibility verification

Candidate: 0.9.0. Source branch: `feat/cross-platform-compatibility`.

## Local checks

Windows host, Node.js 24.14.1, npm 11.8.0. Core and protocol checks use temporary
files and loopback FTP/SFTP servers. The initial full suite passed 68 suites,
608 tests, with 7 skips (six POSIX permission scenarios require a POSIX runner).
The 10,000-file simulated and native watcher tests reported zero reverse uploads
and successful independent local edits. Later final checks are recorded below.

## CI coverage

The Quality workflow requires nine OS/architecture runners and an isolated
case-sensitive APFS job. Execution evidence is added after the jobs finish;
configured coverage alone is not a passed test result. macOS 14 Intel has no
runner in this matrix. The Windows hosted runner does not add manual Windows
10/11 or installed-editor qualification.

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
