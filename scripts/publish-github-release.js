const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultRunner(args) {
  return childProcess.spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGh(runner, args, { allowMissing = false } = {}) {
  const result = runner(args);
  if (result.error) {
    throw result.error;
  }
  if (result.status === 0) {
    return result.stdout || '';
  }
  const detail = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  if (allowMissing && /(?:release not found|HTTP 404|status code 404)/i.test(detail)) {
    return null;
  }
  throw new Error(`gh ${args.join(' ')} failed with exit code ${result.status}: ${detail}`);
}

function releaseState(runner, tag, { allowMissing = false } = {}) {
  const output = runGh(
    runner,
    ['release', 'view', tag, '--json', 'assets,body,isDraft,isPrerelease,tagName'],
    { allowMissing }
  );
  return output === null ? null : JSON.parse(output);
}

function normalizedNotes(value) {
  return value.replace(/\r\n?/g, '\n').trimEnd();
}

function validateReleaseState(state, { tag, notes }) {
  if (state.tagName !== tag) {
    throw new Error(`Existing GitHub Release tag ${state.tagName} does not match ${tag}.`);
  }
  if (state.isPrerelease) {
    throw new Error('Existing GitHub Release is a prerelease, but this workflow publishes a release.');
  }
  if (normalizedNotes(state.body || '') !== normalizedNotes(notes)) {
    throw new Error('Existing GitHub Release notes differ from the immutable bundle.');
  }
}

function verifyExistingAsset({ runner, tag, assetName, localPath }) {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'sftpsync-release-asset-'));
  try {
    runGh(runner, ['release', 'download', tag, '--pattern', assetName, '--dir', destination]);
    const downloaded = path.join(destination, assetName);
    if (!fs.existsSync(downloaded) || !fs.readFileSync(localPath).equals(fs.readFileSync(downloaded))) {
      throw new Error(`Existing GitHub Release asset differs from the bundle: ${assetName}`);
    }
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}

async function publishGitHubRelease({
  bundleDir = path.resolve('release-bundle'),
  tag,
  runner = defaultRunner,
}) {
  if (!tag) {
    throw new Error('A release tag is required.');
  }
  const provenance = JSON.parse(
    fs.readFileSync(path.join(bundleDir, 'provenance.json'), 'utf8')
  );
  if (provenance.tag !== tag) {
    throw new Error(`Bundle tag ${provenance.tag} does not match ${tag}.`);
  }
  const notesPath = path.join(bundleDir, 'release-notes.md');
  const notes = fs.readFileSync(notesPath, 'utf8');
  const vsixName = provenance.artifact.name;
  const assets = [vsixName, `${vsixName}.sha256`];
  const assetPaths = assets.map(name => path.join(bundleDir, name));

  let state = releaseState(runner, tag, { allowMissing: true });
  if (state === null) {
    runGh(runner, [
      'release',
      'create',
      tag,
      '--verify-tag',
      '--title',
      tag,
      '--notes-file',
      notesPath,
      ...assetPaths,
    ]);
    state = releaseState(runner, tag);
  }

  validateReleaseState(state, { tag, notes });
  const existingAssets = new Set((state.assets || []).map(asset => asset.name));
  for (let index = 0; index < assets.length; index += 1) {
    const assetName = assets[index];
    const localPath = assetPaths[index];
    if (existingAssets.has(assetName)) {
      verifyExistingAsset({ runner, tag, assetName, localPath });
    } else {
      runGh(runner, ['release', 'upload', tag, localPath]);
    }
  }

  if (state.isDraft) {
    runGh(runner, ['release', 'edit', tag, '--draft=false']);
  }

  const finalState = releaseState(runner, tag);
  validateReleaseState(finalState, { tag, notes });
  const finalAssets = new Set((finalState.assets || []).map(asset => asset.name));
  if (finalState.isDraft || assets.some(asset => !finalAssets.has(asset))) {
    throw new Error('GitHub Release did not reach a published state with the immutable assets.');
  }
}

module.exports = {
  publishGitHubRelease,
};

if (require.main === module) {
  publishGitHubRelease({
    bundleDir: path.resolve(process.argv[2] || 'release-bundle'),
    tag: process.argv[3] || process.env.GITHUB_REF_NAME,
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
