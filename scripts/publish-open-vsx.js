const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { artifactName, extractChangelogSection, readManifest, sha256, validateReleaseTag,
  verifyReleaseBundle, writeReleaseMetadata } = require('./release');

const REGISTRY = 'https://open-vsx.org';
const normalizeNotes = value => value.replace(/\r\n?/g, '\n').trimEnd();

function runGh(root, args) {
  const result = childProcess.spawnSync('gh', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error('GitHub release lookup/download failed. No Open VSX upload was attempted.');
  return result.stdout;
}

async function prepareExistingBundle({ root = process.cwd(), bundleDir, tag, gh = args => runGh(root, args),
  resolveTag = value => childProcess.execFileSync('git', ['rev-parse', `${value}^{commit}`], { cwd: root, encoding: 'utf8' }).trim() }) {
  const manifest = readManifest(root);
  validateReleaseTag(tag, manifest.version);
  const directory = path.resolve(bundleDir);
  if (directory === path.resolve(root)) throw new Error('Existing-release output cannot be the repository root.');
  if (fs.existsSync(directory) && (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory() || fs.readdirSync(directory).length)) {
    throw new Error('Existing-release output must be a new or empty real directory.');
  }
  const release = JSON.parse(gh(['release', 'view', tag, '--json', 'assets,body,isDraft,isPrerelease,tagName']));
  if (release.tagName !== tag || release.isDraft || release.isPrerelease) throw new Error('A matching published GitHub release is required.');
  const notes = extractChangelogSection(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), manifest.version);
  if (normalizeNotes(release.body || '') !== normalizeNotes(notes)) throw new Error('GitHub release notes do not match this version of CHANGELOG.');
  const name = artifactName(manifest);
  const assets = new Set(release.assets.map(asset => asset.name));
  if (!assets.has(name) || !assets.has(`${name}.sha256`)) throw new Error('The GitHub release must include a VSIX and checksum.');
  const sourceSha = resolveTag(tag);
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('The release tag must resolve to a commit.');
  fs.mkdirSync(directory, { recursive: true });
  gh(['release', 'download', tag, '--dir', directory, '--pattern', name, '--pattern', `${name}.sha256`]);
  const vsixPath = path.join(directory, name);
  const checksum = fs.readFileSync(`${vsixPath}.sha256`, 'utf8').replace(/\r\n/g, '\n');
  if (checksum !== `${sha256(vsixPath)}  ${name}\n`) throw new Error('Downloaded GitHub VSIX checksum does not match.');
  writeReleaseMetadata({ root, outputDir: directory, manifest, tag, sourceSha, vsixPath });
  return verifyReleaseBundle({ root, bundleDir: directory, tag, sourceSha });
}

async function registryVersion(manifest, fetchImpl) {
  const url = `${REGISTRY}/api/${encodeURIComponent(manifest.publisher)}/${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Open VSX metadata lookup failed (${response.status}).`);
  const metadata = await response.json();
  if (metadata.namespace !== manifest.publisher || metadata.name !== manifest.name || metadata.version !== manifest.version
    || (metadata.targetPlatform && metadata.targetPlatform !== 'universal')) throw new Error('Open VSX returned a different extension/version/platform.');
  return metadata;
}

async function verifyRegistryBytes(metadata, expectedHash, fetchImpl) {
  const download = new URL(metadata.files?.download || '');
  if (download.origin !== REGISTRY || download.protocol !== 'https:') throw new Error('Unexpected Open VSX download origin.');
  const response = await fetchImpl(download.toString(), { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Open VSX package download failed (${response.status}).`);
  const hash = crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  if (hash !== expectedHash) throw new Error('Open VSX version exists with different VSIX bytes. Refusing duplicate publication.');
}

async function publishOpenVsx({ root = process.cwd(), bundleDir, tag, sourceSha, fetchImpl = fetch,
  runner = (executable, args) => childProcess.spawnSync(executable, args, { cwd: root, stdio: 'inherit' }),
  pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), maxChecks = 15 }) {
  if (process.env.OVSX_PAT) throw new Error('OIDC publishing must not use OVSX_PAT. Remove the static credential.');
  const verification = await verifyReleaseBundle({ root, bundleDir, tag, sourceSha });
  const manifest = readManifest(root);
  const existing = await registryVersion(manifest, fetchImpl);
  if (existing) await verifyRegistryBytes(existing, verification.hash, fetchImpl);
  // Passing a VSIX avoids packaging; requiring OIDC avoids token-store/PAT fallback.
  // skip-duplicate still authenticates through OIDC, and is allowed only after byte equality above.
  const result = runner(process.execPath, [path.join(root, 'node_modules', 'ovsx', 'bin', 'ovsx'),
    '--registryUrl', REGISTRY, 'publish', verification.vsixPath, '--trusted-publishing', '--skip-duplicate']);
  if (result.error || result.status !== 0) throw new Error('Open VSX OIDC publication failed; inspect the CLI result above.');
  for (let check = 0; check < maxChecks; check++) {
    const metadata = await registryVersion(manifest, fetchImpl);
    if (metadata) {
      await verifyRegistryBytes(metadata, verification.hash, fetchImpl);
      return { version: manifest.version, sha256: verification.hash, alreadyPresent: Boolean(existing),
        url: `${REGISTRY}/extension/${manifest.publisher}/${manifest.name}/${manifest.version}` };
    }
    if (check + 1 < maxChecks) await pause(2000);
  }
  throw new Error('Open VSX accepted the command but the matching public version is not yet available.');
}

module.exports = { prepareExistingBundle, publishOpenVsx };
if (require.main === module) {
  const [mode, directory, tag, sourceSha] = process.argv.slice(2);
  (async () => {
    if (mode !== 'bundle' && mode !== 'existing') throw new Error('Usage: publish-open-vsx.js bundle|existing <directory> <tag> [source-sha]');
    const verified = mode === 'existing' ? await prepareExistingBundle({ bundleDir: directory, tag }) : undefined;
    const result = await publishOpenVsx({ bundleDir: directory, tag, sourceSha: verified?.provenance.sourceSha || sourceSha });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
