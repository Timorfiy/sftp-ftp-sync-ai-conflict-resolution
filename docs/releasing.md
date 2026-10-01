# Maintainer release runbook

This runbook prepares one verified VSIX for three release channels. GitHub
Releases and Open VSX are published by the version-tag workflow. Visual Studio
Marketplace receives the same VSIX through its publisher interface.
The runbook is excluded from the shipped VSIX by the package allowlist.

`Validate Visual Studio Marketplace plan` and `Validate Open VSX plan` verify
the bundle and publication command without uploading anything. Open VSX uses a
separate OIDC publisher job after validation. Visual Studio Marketplace upload
remains manual.
A successful tag workflow verifies the package, GitHub Release and public
Open VSX bytes. It does not mean the Visual Studio Marketplace upload is done.

## Prepublication checklist

- [ ] Complete the [Windows RC qualification](qa/README.md) matrix and review its
  versioned, artifact-hash-bound agent/operator-signed evidence.
- [ ] Confirm source-matched remote quality and secretless Release checks, the
  immutable bundle checksum, and all channel validators.
- [ ] Have an independent English-speaking target user follow the README from
  a fresh profile. The owner deferred **only this human usability check** until
  before first publication on 2026-09-24. Agent functional QA is not a substitute;
  instructions may still confuse a fresh user until this check is completed.
- [ ] Review the explicitly untested supported OS/editor versions and recorded
  warnings/limitations; do not describe them as executed tests.
- [ ] Obtain separate owner consent for the first publication.
- [ ] Obtain owner authorization for each publication and follow the configured
  `release` Environment protection rules. When required reviewers are configured,
  deployment waits for their approval after successful checks.

No checkbox above authorizes creating a tag or publishing an extension by itself.

## One-time protected environment setup

1. Create a GitHub Environment named `release`.
2. Add required reviewers if manual deployment approval is desired. With
   required reviewers configured, every version-tag deployment waits for their
   approval after the quality, build, and channel-validation jobs pass.
3. Restrict the environment to protected version tags matching the repository's
   release policy. A protected or signed tag alone does not authorize
   publication.
4. Add environment variable `RELEASE_ENABLED=true`. The GitHub publish job fails closed
  when it is absent or has another value.

GitHub Release uses the job-scoped GitHub token and is the only job granted
`contents: write`. Open VSX receives `contents: read` and `id-token: write`
only in its publishing job. No `OVSX_PAT` is used. Manual Visual Studio
Marketplace upload does not require a CI `VSCE_PAT`. Do not put tokens in source, workflow inputs, logs, or artifacts.

## Secretless dry-run

1. From the Actions page, run **Release** with `tag` equal to
   `v${package.json.version}` (for the initial release, `v0.1.0`).
2. Leave `publish_open_vsx` unchecked. The default manual dispatch is non-publishing.
   Selecting it explicitly publishes only the matching existing GitHub Release
   to Open VSX, as described below; it does not create a GitHub Release.
3. Confirm the reusable quality gate passes and the build job uploads exactly
   one release bundle.
4. Confirm all three validation jobs pass without entering the protected
   environment or reading publish secrets.
5. Confirm every validation summary reports the same SHA-256.
6. Download the bundle and independently hash the VSIX. It must match
   `provenance.json` and the `.sha256` file.
7. Confirm no version tag, GitHub Release, Marketplace listing, or Open VSX
   listing was created by the dry-run.

The bundle must contain exactly one VSIX, its `.sha256` file,
`release-notes.md`, and `provenance.json`. Release notes must be the exact
matching `CHANGELOG.md` section.

Local build/dry-run commands require a new or empty output directory. They
refuse to clear an existing directory; keep earlier bundles intact and choose
a new `--output-dir` for another build.

## Version-tag GitHub publication

Publication requires all of the following:

- separate owner authorization for the first publication;
- a strict `v<semver>` tag exactly matching `v${package.json.version}`;
- successful quality, build, and three channel-validation jobs;
- the protected `release` environment with `RELEASE_ENABLED=true`; and
- owner authorization and any configured environment reviewer approval.

Review the common artifact hash before approving a protected deployment. The GitHub publish job
downloads and re-verifies the existing bundle; it never compiles or packages
another VSIX. Its summary links to the release and the store settings pages.

If GitHub publication fails, use **Re-run failed jobs**. Do not move the tag,
rebuild the extension, or change the bundle. GitHub Release automation reuses
identical notes/assets, uploads only a missing asset, and completes an
interrupted draft only after re-verifying the bundle. A different existing
asset or release note, or a draft that cannot be published, requires investigation.

## Manual Visual Studio Marketplace upload

1. Download the `.vsix` and its `.sha256` file from the matching
   [GitHub Release](https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/releases).
   Alternatively, download the immutable release bundle from the workflow run.
2. Check the version and SHA-256 before uploading. Use the same verified VSIX
   that was uploaded to Open VSX; do not rebuild it locally.
3. In [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage/publishers/Timorfiy),
   choose **More Actions → Update**, select the VSIX, and upload it.
4. Confirm the expected version was accepted in the publisher interface.
   `Verifying` or `Under review` means store checks are still pending. Confirm
   the public listing separately before reporting the version as available.

If a manual upload fails, inspect the store's version status before retrying
the same file. Completing a manual upload does not change a past Actions run.
Older runs with removed automatic publishing jobs can remain red; new runs
no longer attempt those token-based uploads.

## 0.9.0 release configuration

As checked on 2026-10-01, the repository's `release` Environment has
`RELEASE_ENABLED=true` and no required-reviewer protection rule. The existing
version-tag workflow therefore publishes the GitHub Release after its quality
and validation jobs succeed. Only create/push a release tag after the owner has
requested that publication. No environment protections are changed by the
Activity release. Visual Studio Marketplace upload remains manual. The
trusted-publishing change adds Open VSX OIDC without changing environment rules.

Version 0.9.0 combines preliminary Linux/macOS compatibility with native
Activity, grouped notifications and explicit conflict actions. The pre-release
Windows installed-editor evidence is in [Activity UX QA](qa/activity-ux-report.md).
Do not present that older local candidate's checksum as the workflow-built
release checksum, or automatic OS checks as manual Linux/macOS editor QA.

## Open VSX trusted publisher

Register one GitHub trusted publisher for `Timorfiy.sftp-sync-ai` in
[Open VSX extension settings](https://open-vsx.org/user-settings/extensions/Timorfiy/sftp-sync-ai):

Registration requires namespace ownership, a signed Publisher Agreement and an
active extension version. A contributor role alone cannot register a publisher.

| Field | Value |
| --- | --- |
| Publisher | GitHub |
| Organization or User name | `Timorfiy` |
| Repository name | `sftp-ftp-sync-ai-conflict-resolution` |
| Workflow filename | `release.yml` |
| Environment name | `release` |

The registration grants this workflow/environment publishing rights for this
extension. The registry matches immutable repository/owner IDs and the workflow
filename. It accepts any branch/tag running that workflow; the workflow itself
allows automatic publishing only on version-tag pushes after all channel
validators pass. A separate existing-release dispatch requires explicit selection.

The pinned `ovsx 1.2.0` CLI requires `--trusted-publishing`; do not add `--pat`,
`OVSX_PAT`, or an access-token secret. GitHub's OIDC ID token is exchanged for a
short-lived token scoped to this extension. Neither token is printed or stored.
The publisher uploads the inspected bundle's VSIX and compares the public Open
VSX download with its immutable SHA-256. An existing version with different
bytes fails closed; an identical version is authenticated through OIDC and
skipped without replacement.

Registry acceptance can precede public availability. The publishing job waits
up to five minutes for the public version and verifies its downloaded bytes.
If availability is still delayed, inspect the registry status before retrying
the same existing release; do not create another version or rebuild the VSIX.

### Publish/retry an existing GitHub Release

Run **Release** from the current publisher branch, enter the strict matching
`tag` (for example `v0.9.0`) and check `publish_open_vsx`. The tag must match the
current package version. Quality/build/validator jobs are skipped for this
recovery mode; the Open VSX job downloads the already published GitHub Release
VSIX/checksum, verifies notes, tag source and package security, then uploads the
same bytes through OIDC. It never recompiles, recreates a GitHub Release, changes
a tag or deletes a registry version. `RELEASE_ENABLED=true` and the configured
`release` Environment rules apply to both publication paths.

Default manual dispatch with the checkbox off remains a secretless dry-run.
See [Open VSX trusted publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing).
