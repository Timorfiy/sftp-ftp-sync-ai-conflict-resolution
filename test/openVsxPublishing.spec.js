const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const { writeReleaseMetadata } = require('../scripts/release');
const { prepareExistingBundle, publishOpenVsx } = require('../scripts/publish-open-vsx');

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftpsync-oidc-'));
  const manifest = { name: 'sftp-sync-ai', publisher: 'Timorfiy', version: '0.9.0' };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '## 0.9.0 - 2026-10-01\n\nRelease fixture.\n');
  const bundle = path.join(root, 'bundle'); fs.mkdirSync(bundle);
  const vsix = path.join(bundle, 'sftp-sync-ai-0.9.0.vsix');
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile(); zip.addBuffer(Buffer.from('safe release'), 'extension/README.md'); zip.end();
    const stream = fs.createWriteStream(vsix); stream.on('close', resolve); stream.on('error', reject); zip.outputStream.pipe(stream);
  });
  const provenance = writeReleaseMetadata({ root, outputDir: bundle, manifest, tag: 'v0.9.0', sourceSha: 'a'.repeat(40), vsixPath: vsix });
  return { root, manifest, bundle, vsix, provenance, options: { root, bundleDir: bundle, tag: 'v0.9.0', sourceSha: 'a'.repeat(40) } };
}
const metadata = { namespace: 'Timorfiy', name: 'sftp-sync-ai', version: '0.9.0', targetPlatform: 'universal',
  files: { download: 'https://open-vsx.org/api/Timorfiy/sftp-sync-ai/0.9.0/file/test.vsix' } };
const response = value => ({ status: 200, ok: true, json: async () => value });
describe('Open VSX build-once OIDC publication', () => {
  let data;
  beforeEach(async () => { data = await fixture(); });
  afterEach(() => { fs.rmSync(data.root, { recursive: true, force: true }); delete process.env.OVSX_PAT; });
  test('publishes the verified VSIX using required OIDC and checks public bytes', async () => {
    let queries = 0;
    const fetchImpl = jest.fn(async url => url.endsWith('test.vsix')
      ? { ok: true, arrayBuffer: async () => fs.readFileSync(data.vsix) }
      : ++queries === 1 ? { status: 404, ok: false } : response(metadata));
    const runner = jest.fn(() => ({ status: 0 }));
    await expect(publishOpenVsx({ ...data.options, fetchImpl, runner })).resolves.toMatchObject({ version: '0.9.0', alreadyPresent: false, sha256: data.provenance.artifact.sha256 });
    expect(runner).toHaveBeenCalledWith(process.execPath, expect.arrayContaining([data.vsix, '--trusted-publishing', '--skip-duplicate']));
    expect(runner.mock.calls[0][1]).not.toContain('--pat');
  });
  test('an identical existing version still exercises OIDC, without replacing it', async () => {
    const fetchImpl = jest.fn(async url => url.endsWith('test.vsix')
      ? { ok: true, arrayBuffer: async () => fs.readFileSync(data.vsix) } : response(metadata));
    const runner = jest.fn(() => ({ status: 0 }));
    await expect(publishOpenVsx({ ...data.options, fetchImpl, runner })).resolves.toMatchObject({ alreadyPresent: true });
    expect(runner).toHaveBeenCalledTimes(1);
  });
  test('refuses different existing bytes before obtaining publishing authority', async () => {
    const fetchImpl = jest.fn(async url => url.endsWith('test.vsix')
      ? { ok: true, arrayBuffer: async () => Buffer.from('different') } : response(metadata));
    const runner = jest.fn();
    await expect(publishOpenVsx({ ...data.options, fetchImpl, runner })).rejects.toThrow('different VSIX bytes');
    expect(runner).not.toHaveBeenCalled();
  });
  test('rejects a corrupt CI bundle before contacting Open VSX', async () => {
    fs.appendFileSync(data.vsix, 'corruption'); const fetchImpl = jest.fn();
    await expect(publishOpenVsx({ ...data.options, fetchImpl })).rejects.toThrow('hash or size');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('fails closed for static PAT fallback, network lookup failure and CLI failure', async () => {
    process.env.OVSX_PAT = 'fixture-not-a-real-credential';
    await expect(publishOpenVsx(data.options)).rejects.toThrow('must not use OVSX_PAT'); delete process.env.OVSX_PAT;
    const runner = jest.fn(() => ({ status: 1 }));
    await expect(publishOpenVsx({ ...data.options, fetchImpl: async () => ({ status: 503 }), runner })).rejects.toThrow('lookup failed');
    expect(runner).not.toHaveBeenCalled();
    await expect(publishOpenVsx({ ...data.options, fetchImpl: async () => ({ status: 404 }), runner })).rejects.toThrow('OIDC publication failed');
  });
  test('does not treat registry acceptance as proof of public availability', async () => {
    await expect(publishOpenVsx({ ...data.options, runner: () => ({ status: 0 }), fetchImpl: async () => ({ status: 404 }),
      maxChecks: 2, pause: async () => {} })).rejects.toThrow('not yet available');
  });
  test('existing-release recovery downloads the published assets and never rebuilds', async () => {
    const directory = path.join(data.root, 'existing'); const calls = [];
    const gh = args => {
      calls.push(args);
      if (args[1] === 'view') return JSON.stringify({ tagName: 'v0.9.0', isDraft: false, isPrerelease: false,
        body: fs.readFileSync(path.join(data.bundle, 'release-notes.md'), 'utf8'), assets: [{ name: path.basename(data.vsix) }, { name: path.basename(data.vsix) + '.sha256' }] });
      fs.copyFileSync(data.vsix, path.join(directory, path.basename(data.vsix)));
      fs.copyFileSync(data.vsix + '.sha256', path.join(directory, path.basename(data.vsix) + '.sha256'));
      return '';
    };
    await expect(prepareExistingBundle({ root: data.root, bundleDir: directory, tag: 'v0.9.0', gh,
      resolveTag: () => 'a'.repeat(40) })).resolves.toMatchObject({ hash: data.provenance.artifact.sha256 });
    expect(calls.map(args => args.slice(0, 2))).toEqual([['release', 'view'], ['release', 'download']]);
    expect(fs.readFileSync(path.join(directory, path.basename(data.vsix)))).toEqual(fs.readFileSync(data.vsix));
  });
  test('recovery rejects another version and an existing non-empty output directory', async () => {
    await expect(prepareExistingBundle({ root: data.root, bundleDir: data.bundle, tag: 'v0.9.0' })).rejects.toThrow('new or empty');
    await expect(prepareExistingBundle({ root: data.root, bundleDir: path.join(data.root, 'new'), tag: 'v9.0.0' })).rejects.toThrow('does not match');
  });
});
