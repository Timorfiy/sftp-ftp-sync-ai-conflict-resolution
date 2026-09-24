# Maintainer release runbook

This runbook prepares the three first-release channels. It is intentionally
excluded from the shipped VSIX by the package allowlist.

## One-time protected environment setup

1. Create a GitHub Environment named `release`.
2. Add required reviewers. Every version-tag deployment must wait for a manual
   reviewer approval after the quality, build, and channel-validation jobs pass.
3. Restrict the environment to protected version tags matching the repository's
   release policy. A protected or signed tag alone does not authorize
   publication.
4. Add environment variable `RELEASE_ENABLED=true`. Publish jobs fail closed
   when it is absent or has another value.
5. Add `VSCE_PAT` and `OVSX_PAT` as **environment secrets**, not repository
   secrets. Do not put tokens in source, workflow inputs, logs, or artifacts.
   GitHub Release uses the job-scoped GitHub token and is the only job granted
   `contents: write`.

Azure DevOps global PATs are scheduled to stop working on December 1, 2026.
Before Marketplace publication, revalidate that `VSCE_PAT` authentication is
still supported or migrate the environment to Microsoft's supported Entra
authentication.

## Secretless dry-run

1. From the Actions page, run **Release** with `tag` equal to
   `v${package.json.version}` (for the initial release, `v0.1.0`).
2. Do not add a publish switch; manual dispatch is always non-publishing.
3. Confirm the reusable quality gate passes and the build job uploads exactly
   one release bundle.
4. Confirm all three validation jobs pass without entering the protected
   environment and without reading `VSCE_PAT` or `OVSX_PAT`.
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

## Version-tag publication

Publication requires all of the following:

- separate owner authorization for the first publication;
- a strict `v<semver>` tag exactly matching `v${package.json.version}`;
- successful quality, build, and three channel-validation jobs;
- the protected `release` environment with `RELEASE_ENABLED=true`; and
- manual environment approval for **each** Marketplace, Open VSX, and GitHub
  Release deployment.

Review the common artifact hash before approving. The publish jobs download and
re-verify the existing bundle; they never compile or package another VSIX.

If one channel fails, use **Re-run failed jobs** for that channel. Do not move
the tag, rebuild the extension, or change the bundle. Registry commands use
duplicate-safe publishing, while GitHub Release automation reuses identical
notes/assets, uploads only a missing asset, and completes an interrupted draft
only after re-verifying the bundle. A different existing asset or release note,
or a draft that cannot be published, is treated as a visible failure requiring
investigation.
