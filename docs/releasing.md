# Maintainer release runbook

This runbook prepares one verified VSIX for three release channels. GitHub
Releases are published by the version-tag workflow. Visual Studio Marketplace
and Open VSX receive the same VSIX through their publisher interfaces.
The runbook is excluded from the shipped VSIX by the package allowlist.

`Validate Visual Studio Marketplace plan` and `Validate Open VSX plan` verify
the bundle and publication command without uploading anything. The workflow
has no automatic publishing jobs or token requirements for those two stores.
A successful workflow means the package and GitHub Release are ready; it does
not mean the two marketplace uploads have been completed.

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
- [ ] Require manual `release` Environment approval after successful checks for
  **every** GitHub Release deployment, including later releases.

No checkbox above authorizes creating a tag or publishing an extension by itself.

## One-time protected environment setup

1. Create a GitHub Environment named `release`.
2. Add required reviewers. Every version-tag deployment must wait for a manual
   reviewer approval after the quality, build, and channel-validation jobs pass.
3. Restrict the environment to protected version tags matching the repository's
   release policy. A protected or signed tag alone does not authorize
   publication.
4. Add environment variable `RELEASE_ENABLED=true`. The GitHub publish job fails closed
  when it is absent or has another value.

GitHub Release uses the job-scoped GitHub token and is the only job granted
`contents: write`. No `VSCE_PAT` or `OVSX_PAT` is needed for manual marketplace
uploads. Do not put tokens in source, workflow inputs, logs, or artifacts.

## Secretless dry-run

1. From the Actions page, run **Release** with `tag` equal to
   `v${package.json.version}` (for the initial release, `v0.1.0`).
2. Do not add a publish switch; manual dispatch is always non-publishing.
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
- manual environment approval for the GitHub Release deployment.

Review the common artifact hash before approving. The GitHub publish job
downloads and re-verifies the existing bundle; it never compiles or packages
another VSIX. Its summary links to the release and both manual upload pages.

If GitHub publication fails, use **Re-run failed jobs**. Do not move the tag,
rebuild the extension, or change the bundle. GitHub Release automation reuses
identical notes/assets, uploads only a missing asset, and completes an
interrupted draft only after re-verifying the bundle. A different existing
asset or release note, or a draft that cannot be published, requires investigation.

## Manual Marketplace and Open VSX uploads

1. Download the `.vsix` and its `.sha256` file from the matching
   [GitHub Release](https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/releases).
   Alternatively, download the immutable release bundle from the workflow run.
2. Check the version and SHA-256 before uploading. Use the same verified VSIX
   for both stores; do not rebuild it locally.
3. In [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage/publishers/Timorfiy),
   choose **More Actions → Update**, select the VSIX, and upload it.
4. In [Open VSX](https://open-vsx.org/user-settings/extensions), choose
   **Publish extension**, select the same VSIX, and publish it.
5. Confirm the expected version was accepted in each publisher interface.
   `Verifying` or `Under review` means store checks are still pending. Confirm
   the public listing separately before reporting the version as available.

If a manual upload fails, inspect the store's version status before retrying
the same file. Completing a manual upload does not change a past Actions run.
Older runs with removed automatic publishing jobs can remain red; new runs
no longer attempt those token-based uploads.
