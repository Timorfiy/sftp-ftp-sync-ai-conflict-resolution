# Platform compatibility

One universal VSIX targets desktop VS Code 1.104.0+ and Cursor 3.17.8+.
Windows 10/11 retains its existing support scope. Linux/macOS compatibility is
preliminary until the installed editors have been checked manually.

| Target | Automated runner coverage |
| --- | --- |
| Ubuntu Desktop 22.04/24.04/26.04 LTS x64 | Ubuntu 22.04/24.04/26.04 hosted runners |
| macOS 14, Apple Silicon | macOS 14 ARM64 |
| macOS 15/26, Intel and Apple Silicon | Separate Intel and ARM64 runners |
| macOS 14, Intel | No runner in this matrix; not manually verified |
| Windows 10/11 | Existing Windows runner; no new claim of Windows 10/editor UI qualification |

Hosted runner OS checks verify core behavior, native filesystem operations,
loopback FTP/SFTP, standalone MCP stdio, compilation and VSIX packaging. They do
not launch installed VS Code/Cursor, exercise OS credential stores, or verify
editor MCP registration. A separate macOS job runs filesystem and watcher tests
on an isolated case-sensitive APFS volume. Exact completed runs and gaps are
recorded in the repository's cross-platform QA report.

Linux and macOS compatibility was implemented with AI assistance. Automated
checks cover the operating systems and architectures listed in the test report.
The extension has not been manually tested in installed VS Code or Cursor on
Linux/macOS. Editor UI, credential storage, and editor MCP integration remain
unverified in those environments.

Linux ARM64, other distributions, browser editors, Remote SSH, WSL and Dev
Containers are outside this compatibility stage. FTP/SFTP and configuration
contracts remain unchanged; FTPS remains experimental. The MCP server uses the
editor's own runtime, so users do not need a separate Node.js installation.

Local paths keep the local OS syntax; server paths use POSIX syntax. Linux paths
are case-sensitive. macOS path matching uses read-only filesystem detection,
including case-sensitive APFS, with strict comparison if detection is unavailable.
Saved passwords continue to use the editor's SecretStorage API. See
[authentication and local path troubleshooting](troubleshooting.md#authentication).
