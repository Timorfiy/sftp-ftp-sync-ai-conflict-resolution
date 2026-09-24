const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { inspectVsix } = require('./inspect-vsix');

const BUNDLE_FILES = {
  notes: 'release-notes.md',
  provenance: 'provenance.json',
};
const SEMVER_TAG =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function readManifest(root = process.cwd()) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function artifactName(manifest) {
  if (!manifest.name || !manifest.version) {
    throw new Error('package.json must define name and version.');
  }
  return `${manifest.name}-${manifest.version}.vsix`;
}

function extensionId(manifest) {
  if (!manifest.publisher || !manifest.name) {
    throw new Error('package.json must define publisher and name.');
  }
  return `${manifest.publisher}.${manifest.name}`;
}

function validateReleaseTag(tag, version) {
  if (typeof tag !== 'string' || !SEMVER_TAG.test(tag)) {
    throw new Error(`Release tag must be strict v<semver>; received ${JSON.stringify(tag)}.`);
  }
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`Release tag ${tag} does not match package version ${expected}.`);
  }
  return tag;
}

function validateSourceSha(sourceSha) {
  if (!/^[0-9a-f]{40}$/i.test(sourceSha || '')) {
    throw new Error('Source SHA must be a full 40-character Git commit SHA.');
  }
  return sourceSha.toLowerCase();
}

function normalizeLines(value) {
  return value.replace(/\r\n?/g, '\n');
}

function extractChangelogSection(changelog, version) {
  const normalized = normalizeLines(changelog);
  const lines = normalized.split('\n');
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+\\[?${escapedVersion}\\]?(?:\\s+-.*)?\\s*$`);
  const start = lines.findIndex(line => heading.test(line));
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no exact top-level section for ${version}.`);
  }
  const endOffset = lines.slice(start + 1).findIndex(line => /^##\s+/.test(line));
  const end = endOffset === -1 ? lines.length : start + 1 + endOffset;
  const section = lines.slice(start, end);
  while (section.length > 0 && section[section.length - 1] === '') {
    section.pop();
  }
  if (section.length < 2 || section.slice(1).every(line => line.trim() === '')) {
    throw new Error(`CHANGELOG.md section for ${version} has no release notes.`);
  }
  return `${section.join('\n')}\n`;
}

function sha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function localVsceCli(root) {
  return require.resolve('@vscode/vsce/vsce', { paths: [root] });
}

async function packageVsix({
  root = process.cwd(),
  outputDir = root,
  runner = childProcess.spawnSync,
  vsceCli = localVsceCli(root),
}) {
  const manifest = readManifest(root);
  const filename = artifactName(manifest);
  const outputPath = path.resolve(outputDir, filename);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.rmSync(outputPath, { force: true });

  const result = runner(
    process.execPath,
    [vsceCli, 'package', '--out', outputPath],
    { cwd: root, stdio: 'inherit' }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`VSCE package failed with exit code ${result.status}.`);
  }
  await inspectVsix(outputPath);
  return { manifest, filename, outputPath };
}

function checksumFilename(vsixName) {
  return `${vsixName}.sha256`;
}

function writeReleaseMetadata({ root, outputDir, manifest, tag, sourceSha, vsixPath }) {
  const hash = sha256(vsixPath);
  const filename = path.basename(vsixPath);
  const notes = extractChangelogSection(
    fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
    manifest.version
  );
  const provenance = {
    schemaVersion: 1,
    extensionId: extensionId(manifest),
    packageName: manifest.name,
    version: manifest.version,
    tag,
    sourceSha,
    artifact: {
      name: filename,
      bytes: fs.statSync(vsixPath).size,
      sha256: hash,
    },
  };
  fs.writeFileSync(path.join(outputDir, BUNDLE_FILES.notes), notes, 'utf8');
  fs.writeFileSync(
    path.join(outputDir, checksumFilename(filename)),
    `${hash}  ${filename}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(outputDir, BUNDLE_FILES.provenance),
    `${JSON.stringify(provenance, null, 2)}\n`,
    'utf8'
  );
  return provenance;
}

async function buildReleaseBundle({
  root = process.cwd(),
  outputDir = path.join(root, 'release-bundle'),
  tag,
  sourceSha,
  packageRunner,
}) {
  const manifest = readManifest(root);
  validateReleaseTag(tag, manifest.version);
  const normalizedSha = validateSourceSha(sourceSha);
  const resolvedOutput = path.resolve(outputDir);
  if (resolvedOutput === path.resolve(root)) {
    throw new Error('Release bundle output directory must not be the repository root.');
  }
  if (fs.existsSync(resolvedOutput)) {
    const stat = fs.lstatSync(resolvedOutput);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Release bundle output must be a real directory, not a file or symbolic link.');
    }
    if (fs.readdirSync(resolvedOutput).length > 0) {
      throw new Error('Release bundle output directory must be empty; choose a new directory to preserve existing files.');
    }
  }
  fs.mkdirSync(resolvedOutput, { recursive: true });
  const packaged = await packageVsix({
    root,
    outputDir: resolvedOutput,
    runner: packageRunner,
  });
  return writeReleaseMetadata({
    root,
    outputDir: resolvedOutput,
    manifest: packaged.manifest,
    tag,
    sourceSha: normalizedSha,
    vsixPath: packaged.outputPath,
  });
}

function expectedBundleFiles(provenance) {
  return [
    BUNDLE_FILES.notes,
    BUNDLE_FILES.provenance,
    checksumFilename(provenance.artifact.name),
    provenance.artifact.name,
  ].sort();
}

async function verifyReleaseBundle({
  root = process.cwd(),
  bundleDir = path.join(root, 'release-bundle'),
  tag,
  sourceSha,
}) {
  const manifest = readManifest(root);
  const resolvedBundle = path.resolve(bundleDir);
  const provenancePath = path.join(resolvedBundle, BUNDLE_FILES.provenance);
  if (!fs.existsSync(provenancePath)) {
    throw new Error(`Release provenance not found: ${provenancePath}`);
  }
  const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
  validateReleaseTag(tag || provenance.tag, manifest.version);
  const expectedSourceSha = validateSourceSha(sourceSha || provenance.sourceSha);
  const expected = {
    extensionId: extensionId(manifest),
    packageName: manifest.name,
    version: manifest.version,
    tag: tag || provenance.tag,
    sourceSha: expectedSourceSha,
    artifactName: artifactName(manifest),
  };
  if (
    provenance.schemaVersion !== 1 ||
    provenance.extensionId !== expected.extensionId ||
    provenance.packageName !== expected.packageName ||
    provenance.version !== expected.version ||
    provenance.tag !== expected.tag ||
    provenance.sourceSha !== expected.sourceSha ||
    provenance.artifact?.name !== expected.artifactName
  ) {
    throw new Error('Release provenance does not match package, tag, or source SHA.');
  }

  const actualFiles = fs.readdirSync(resolvedBundle).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedBundleFiles(provenance))) {
    throw new Error(`Release bundle has unexpected files: ${actualFiles.join(', ')}`);
  }
  const vsixPath = path.join(resolvedBundle, provenance.artifact.name);
  const hash = sha256(vsixPath);
  const bytes = fs.statSync(vsixPath).size;
  if (hash !== provenance.artifact.sha256 || bytes !== provenance.artifact.bytes) {
    throw new Error('Release VSIX does not match provenance hash or size.');
  }
  const checksum = fs.readFileSync(
    path.join(resolvedBundle, checksumFilename(provenance.artifact.name)),
    'utf8'
  );
  if (checksum !== `${hash}  ${provenance.artifact.name}\n`) {
    throw new Error('Release checksum file does not match the VSIX.');
  }
  const expectedNotes = extractChangelogSection(
    fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
    manifest.version
  );
  if (fs.readFileSync(path.join(resolvedBundle, BUNDLE_FILES.notes), 'utf8') !== expectedNotes) {
    throw new Error('Release notes do not exactly match the CHANGELOG section.');
  }
  await inspectVsix(vsixPath);
  return { provenance, vsixPath, hash };
}

function channelPlan(channel, verification) {
  const vsix = verification.provenance.artifact.name;
  const checksum = checksumFilename(vsix);
  const plans = {
    marketplace: {
      executable: 'vsce',
      args: ['publish', '--packagePath', vsix, '--skip-duplicate'],
      credential: 'VSCE_PAT',
    },
    'open-vsx': {
      executable: 'ovsx',
      args: ['publish', vsix, '--skip-duplicate'],
      credential: 'OVSX_PAT',
    },
    github: {
      executable: 'gh',
      args: ['release', 'create-or-verify', verification.provenance.tag],
      assets: [vsix, checksum],
      notes: BUNDLE_FILES.notes,
      credential: 'GH_TOKEN',
    },
  };
  if (!Object.hasOwn(plans, channel)) {
    throw new Error(`Unknown release channel: ${channel}`);
  }
  return {
    channel,
    artifactSha256: verification.hash,
    ...plans[channel],
  };
}

function parseOptions(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--') || index + 1 >= rest.length) {
      throw new Error(`Invalid argument: ${key}`);
    }
    options[key.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function gitSourceSha(root) {
  return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

async function main(argv = process.argv.slice(2)) {
  const root = process.cwd();
  const { command, options } = parseOptions(argv);
  const manifest = readManifest(root);
  const outputDir = path.resolve(options['output-dir'] || path.join(root, 'release-bundle'));
  const tag = options.tag;
  const sourceSha = options['source-sha'] || gitSourceSha(root);

  if (command === 'package') {
    const packaged = await packageVsix({ root, outputDir: options['output-dir'] || root });
    process.stdout.write(`${packaged.outputPath}\n`);
    return;
  }
  if (command === 'inspect') {
    const filename = path.resolve(options.file || path.join(root, artifactName(manifest)));
    await inspectVsix(filename);
    process.stdout.write(`${filename}\n`);
    return;
  }
  if (command === 'build' || command === 'dry-run') {
    const provenance = await buildReleaseBundle({ root, outputDir, tag, sourceSha });
    process.stdout.write(`${JSON.stringify(provenance)}\n`);
    if (command === 'build') {
      return;
    }
  }
  if (command === 'verify' || command === 'plan' || command === 'dry-run') {
    const verification = await verifyReleaseBundle({
      root,
      bundleDir: outputDir,
      tag,
      sourceSha,
    });
    if (command === 'verify') {
      process.stdout.write(`${verification.hash}\n`);
      return;
    }
    const channels =
      command === 'dry-run' ? ['marketplace', 'open-vsx', 'github'] : [options.channel];
    for (const channel of channels) {
      process.stdout.write(`${JSON.stringify(channelPlan(channel, verification))}\n`);
    }
    return;
  }
  throw new Error('Usage: release.js package|inspect|build|verify|plan|dry-run [options]');
}

module.exports = {
  artifactName,
  buildReleaseBundle,
  channelPlan,
  checksumFilename,
  extensionId,
  extractChangelogSection,
  packageVsix,
  readManifest,
  sha256,
  validateReleaseTag,
  verifyReleaseBundle,
  writeReleaseMetadata,
};

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
