# Download watcher regression

Downloads must not trigger watcher uploads, including after the transfer has
left `FileService._pendingTransferTasks`. The original watcher fails the
`does not reupload a repeated event` test: its leading event is skipped while
the task is pending, but its trailing event uploads the completed download.

## Implementation

- `TransferTask` records a SHA-256 of the staging file **before** its atomic
  rename. A watcher dispatch waits for that commit and compares the current
  bytes, so an edit immediately after rename is not adopted as the baseline.
- Claims are exact local paths, normalized for the platform. Temporary names
  with the extension's UUID suffix are excluded on create/change/delete.
- Every queued event is checked at dispatch. Directory events are expanded and
  their descendants checked individually, including events for an existing
  parent directory. Empty directories created by a download are claimed too.
- Save/rename time windows and active-conflict checks remain in force. Waiting
  for an upload/conflict does not block dispatch in other projects.
- Failure restores the preceding version, cancellation before commit preserves
  the destination, and retries use the same shared path. No config is rewritten.

Claims are version baselines, not transfer locks. Unchanged downloaded versions
remain known after sync finishes; a different content hash is eligible for
upload immediately, even at the same size and restored mtime. A TTL or LRU
eviction would let sufficiently late events upload the unchanged download.

There is one entry per downloaded path in active watchers, not per event or
transfer. Repeated downloads replace that entry. Edits and deletes remove it;
watcher disposal clears paths no longer watched, including failed/cancelled
sessions. A single unreferenced timer checks up to 128 paths per second for
deletions whose events were excluded/missed. Memory is **O(watched downloaded
paths)**, not a constant-size cache; retained versions are necessary to recognize
arbitrarily late events. Historical deletions are pruned, and closed projects
retain no versions. Hashing streams file content and watcher checks run serially
instead of opening thousands of files at once.

## Reproduce

Run from the repository root with the installed dependencies:

```powershell
node node_modules/jest/bin/jest.js --runInBand test/modules/downloadWatcher.spec.js
node node_modules/jest/bin/jest.js --runInBand test/modules/downloadWatcher.scale.spec.js
node node_modules/jest/bin/jest.js --runInBand test/modules/downloadWatcher.protocol.spec.js
npm test -- --runInBand
npm run lint
node node_modules/typescript/bin/tsc --noEmit
npm run compile
npm run package -- --output-dir release-bundle/download-watcher
npm run package:inspect -- --file release-bundle/download-watcher/sftp-sync-ai-0.1.0.vsix
```

The tests create isolated `mkdtemp` directories. Protocol fixtures bind only to
`127.0.0.1`; no user's project, connection configuration or installed extension
is accessed. The watcher module, lodash debounce, transfer/staging/rename code,
local filesystem and hash checks are real. The upload/delete functions are
recording sinks: tests fail if the watcher attempts an unintended transfer.

## What the tests establish

The deterministic event tests cover the original race, repeated and next-day
events, replacement delete/create signals, same-size edits with restored mtime,
edits immediately after rename, staging events, retry, errors, active
cancellation, failed replacement, overlapping downloads, save/rename/conflict
suppression, ignored paths, grouped directory events, disposal and missed-delete
cleanup.

The scale suite runs four cases, each scheduling **10,000** real staged writes:
simulated events and native recursive Windows `fs.watch`, each with completion
and halfway cancellation. Concurrency is 16. Cancellation completes 5,008 files
and cancels the remaining 4,992. Every case verifies zero reverse-upload
attempts, no staging leftovers, an independent edit during the run, a same-file
edit after it, one retained version per unchanged completed file and zero
versions after watcher disposal. The native cases also assert that all completed
destination paths were actually observed; zero uploads alone is insufficient.

The protocol suite downloads via real loopback FTP and SFTP and observes real
`fs.watch` events for all four command paths. It checks downloaded bytes and
subsequent local-edit dispatch.

Limits: the 10,000-file cases use small generated files and local source streams,
not 10,000 network transfers. Native events are adapted from Node's
rename/change events to VS Code's create/change/delete callbacks. This is not a
test of VS Code's extension host, its exact event batching, other operating
systems, network mounts, very large files, or OS event-buffer overflow. No
watcher can upload an edit for which the OS delivers no usable event. Loopback
protocol tests cover small trees, separately from the scale test.
