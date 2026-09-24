const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const {
  artifactName,
  buildReleaseBundle,
  channelPlan,
  extractChangelogSection,
  packageVsix,
  verifyReleaseBundle,
  writeReleaseMetadata,
} = require('../scripts/release');

function createVsix(filename, entries = [['extension/README.md', 'release fixture']]) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, content] of entries) {
      zip.addBuffer(Buffer.from(content), name);
    }
    zip.end();
    const output = fs.createWriteStream(filename);
    output.on('close', resolve);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
  });
}

function createReleaseRoot(version = '1.2.3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftpsync-release-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'dynamic-name',
      version,
      publisher: 'Publisher',
    })
  );
  fs.writeFileSync(
    path.join(root, 'CHANGELOG.md'),
    `## ${version} - 2026-09-24\n\nRelease ${version}.\n\n## 1.0.0 - 2026-01-01\n\nOld.\n`
  );
  return root;
}

describe('release bundle automation', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length > 0) {
      fs.rmSync(roots.pop(), { recursive: true, force: true });
    }
  });

  test('derives the VSIX name and package output from package metadata', async () => {
    const root = createReleaseRoot();
    roots.push(root);
    const fixture = path.join(root, 'fixture.vsix');
    await createVsix(fixture);
    const calls = [];
    const packaged = await packageVsix({
      root,
      outputDir: path.join(root, 'output'),
      runner(executable, args) {
        calls.push({ executable, args });
        fs.copyFileSync(fixture, args[args.indexOf('--out') + 1]);
        return { status: 0 };
      },
      vsceCli: path.join(process.cwd(), 'node_modules', '@vscode', 'vsce', 'vsce'),
    });

    expect(artifactName({ name: 'dynamic-name', version: '1.2.3' })).toBe(
      'dynamic-name-1.2.3.vsix'
    );
    expect(path.basename(packaged.outputPath)).toBe('dynamic-name-1.2.3.vsix');
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('package');
  });

  test.each(['0.1.0', 'v1', 'v01.2.3', 'v1.2.3.4', 'release-v1.2.3'])(
    'rejects malformed release tag %s',
    async tag => {
      const root = createReleaseRoot();
      roots.push(root);
      const bundleDir = path.join(root, 'bundle');
      fs.mkdirSync(bundleDir);
      const vsixPath = path.join(bundleDir, 'dynamic-name-1.2.3.vsix');
      await createVsix(vsixPath);
      writeReleaseMetadata({
        root,
        outputDir: bundleDir,
        manifest: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))),
        tag: 'v1.2.3',
        sourceSha: 'a'.repeat(40),
        vsixPath,
      });

      await expect(
        verifyReleaseBundle({
          root,
          bundleDir,
          tag,
          sourceSha: 'a'.repeat(40),
        })
      ).rejects.toThrow(/strict v<semver>|does not match/);
    }
  );

  test('rejects a well-formed tag that does not equal the package version', async () => {
    const root = createReleaseRoot();
    roots.push(root);
    const bundleDir = path.join(root, 'bundle');
    fs.mkdirSync(bundleDir);
    const vsixPath = path.join(bundleDir, 'dynamic-name-1.2.3.vsix');
    await createVsix(vsixPath);
    writeReleaseMetadata({
      root,
      outputDir: bundleDir,
      manifest: JSON.parse(fs.readFileSync(path.join(root, 'package.json'))),
      tag: 'v1.2.3',
      sourceSha: 'a'.repeat(40),
      vsixPath,
    });

    await expect(
      verifyReleaseBundle({
        root,
        bundleDir,
        tag: 'v1.2.4',
        sourceSha: 'a'.repeat(40),
      })
    ).rejects.toThrow('does not match package version v1.2.3');
  });

  test('extracts deterministic exact notes and rejects missing or empty sections', () => {
    const lf = '## 1.2.3 - 2026-09-24\n\nNotes.\n\n## 1.2.2\n\nOld.\n';
    expect(extractChangelogSection(lf, '1.2.3')).toBe(
      '## 1.2.3 - 2026-09-24\n\nNotes.\n'
    );
    expect(extractChangelogSection(lf.replace(/\n/g, '\r\n'), '1.2.3')).toBe(
      '## 1.2.3 - 2026-09-24\n\nNotes.\n'
    );
    expect(() => extractChangelogSection(lf, '2.0.0')).toThrow('no exact top-level section');
    expect(() => extractChangelogSection('## 1.2.3\n\n## 1.2.2\n\nOld.\n', '1.2.3')).toThrow(
      'has no release notes'
    );
    expect(
      extractChangelogSection('## 1.2.3+build.4\n\nExact notes.\n', '1.2.3+build.4')
    ).toBe('## 1.2.3+build.4\n\nExact notes.\n');
  });

  test('refuses to clear a nonempty output directory or repository root', async () => {
    const root = createReleaseRoot();
    roots.push(root);
    const outputDir = path.join(root, 'existing-output');
    fs.mkdirSync(outputDir);
    const sentinel = path.join(outputDir, 'keep.txt');
    fs.writeFileSync(sentinel, 'must survive');
    const packageRunner = jest.fn();

    await expect(buildReleaseBundle({
      root,
      outputDir,
      tag: 'v1.2.3',
      sourceSha: 'a'.repeat(40),
      packageRunner,
    })).rejects.toThrow('must be empty');
    await expect(buildReleaseBundle({
      root,
      outputDir: root,
      tag: 'v1.2.3',
      sourceSha: 'a'.repeat(40),
      packageRunner,
    })).rejects.toThrow('must not be the repository root');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('must survive');
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
    expect(packageRunner).not.toHaveBeenCalled();
  });

  test('verifies checksum, notes, provenance, and rejects a tampered VSIX', async () => {
    const root = createReleaseRoot();
    roots.push(root);
    const bundleDir = path.join(root, 'bundle');
    fs.mkdirSync(bundleDir);
    const vsixPath = path.join(bundleDir, 'dynamic-name-1.2.3.vsix');
    await createVsix(vsixPath);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    writeReleaseMetadata({
      root,
      outputDir: bundleDir,
      manifest,
      tag: 'v1.2.3',
      sourceSha: 'a'.repeat(40),
      vsixPath,
    });

    const verified = await verifyReleaseBundle({
      root,
      bundleDir,
      tag: 'v1.2.3',
      sourceSha: 'a'.repeat(40),
    });
    expect(verified.provenance).toMatchObject({
      extensionId: 'Publisher.dynamic-name',
      version: '1.2.3',
      sourceSha: 'a'.repeat(40),
    });
    fs.appendFileSync(vsixPath, 'tampered');
    await expect(
      verifyReleaseBundle({
        root,
        bundleDir,
        tag: 'v1.2.3',
        sourceSha: 'a'.repeat(40),
      })
    ).rejects.toThrow('does not match provenance');
  });

  test('dry-run plans all channels without reading or exposing publish secrets', async () => {
    const root = createReleaseRoot();
    roots.push(root);
    const bundleDir = path.join(root, 'bundle');
    fs.mkdirSync(bundleDir);
    const vsixPath = path.join(bundleDir, 'dynamic-name-1.2.3.vsix');
    await createVsix(vsixPath);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    writeReleaseMetadata({
      root,
      outputDir: bundleDir,
      manifest,
      tag: 'v1.2.3',
      sourceSha: 'a'.repeat(40),
      vsixPath,
    });
    const verified = await verifyReleaseBundle({
      root,
      bundleDir,
      tag: 'v1.2.3',
      sourceSha: 'a'.repeat(40),
    });
    const canary = 'publish-secret-must-not-be-read';
    process.env.VSCE_PAT = canary;
    process.env.OVSX_PAT = canary;
    const plans = ['marketplace', 'open-vsx', 'github'].map(channel =>
      channelPlan(channel, verified)
    );
    delete process.env.VSCE_PAT;
    delete process.env.OVSX_PAT;

    expect(JSON.stringify(plans)).not.toContain(canary);
    expect(plans.map(plan => plan.credential)).toEqual(['VSCE_PAT', 'OVSX_PAT', 'GH_TOKEN']);
    expect(fs.readFileSync(path.join(__dirname, '../scripts/release.js'), 'utf8')).not.toContain(
      'process.env'
    );
  });
});
