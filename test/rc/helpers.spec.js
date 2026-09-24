const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { sha256, readArchive, writeArchive, verifyCandidate, createPredecessor, verifyInstalled } = require('./artifacts');
const { waitFor } = require('./cdp');
const { Cell, isolatedEnvironment } = require('./runner');
const { Journey } = require('./journey');
const createSandbox = require('../fixtures/protocolSandbox');
const startFTP = require('../fixtures/ftpServer');
const startSFTP = require('../fixtures/sftpServer');
const { assertRow, cleanScenarios } = require('./matrix');
const candidatePin = require('./candidate.json');
const { assertPublicEvidence } = require('./export-evidence');

describe('RC qualification guards', () => {
  let root;
  let candidate;
  let pin;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-helper-'));
    const entries = new Map([
      ['extension/package.json', Buffer.from(JSON.stringify({
        name: 'sftp-sync-ai', publisher: 'Timorfiy', version: '0.1.0', engines: { vscode: '^1.104.0' },
      }, null, 2))],
      ['extension.vsixmanifest', Buffer.from('<Identity Id="sftp-sync-ai" Version="0.1.0" Publisher="Timorfiy"/>')],
      ['extension/dist/extension.js', Buffer.from('unchanged runtime')],
    ]);
    const file = path.join(root, 'candidate.vsix');
    await writeArchive(file, entries);
    const bytes = await fs.readFile(file);
    pin = { file: 'candidate.vsix', bytes: bytes.length, sha256: sha256(bytes), source: 'a'.repeat(40) };
    await fs.writeFile(path.join(root, 'provenance.json'), JSON.stringify({ sourceSha: pin.source }));
    candidate = await verifyCandidate(root, pin);
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  test('refuses wrong candidate hash, size, source and unsafe path', async () => {
    await expect(verifyCandidate(root, { ...pin, sha256: '0'.repeat(64) })).rejects.toThrow('checksum mismatch');
    await expect(verifyCandidate(root, { ...pin, bytes: pin.bytes + 1 })).rejects.toThrow('size mismatch');
    await expect(verifyCandidate(root, { ...pin, source: 'b'.repeat(40) })).rejects.toThrow('source mismatch');
    await expect(verifyCandidate(root, { ...pin, file: '../candidate.vsix' })).rejects.toThrow('basename');
  });
  test('synthetic predecessor changes exactly version metadata, preserving canonical bytes', async () => {
    const original = await fs.readFile(candidate.file);
    const output = path.join(root, 'predecessor.vsix');
    const report = await createPredecessor(candidate, output);
    expect(report.changed).toEqual(['extension.vsixmanifest', 'extension/package.json']);
    const entries = await readArchive(output);
    expect(JSON.parse(entries.get('extension/package.json')).version).toBe('0.0.0');
    expect(entries.get('extension.vsixmanifest').toString()).toContain('Version="0.0.0"');
    expect(entries.get('extension/dist/extension.js')).toEqual(candidate.entries.get('extension/dist/extension.js'));
    expect(await fs.readFile(candidate.file)).toEqual(original);
    expect(report.sha256).not.toBe(pin.sha256);
    await expect(createPredecessor(candidate, output)).rejects.toMatchObject({ code: 'EEXIST' });
  });
  test('installed verification accepts editor metadata only, rejecting altered runtime and manifest', async () => {
    const directory = path.join(root, 'installed');
    await fs.mkdir(path.join(directory, 'dist'), { recursive: true });
    const manifest = JSON.parse(candidate.entries.get('extension/package.json'));
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ ...manifest, __metadata: { installedTimestamp: 123 } }));
    await fs.writeFile(path.join(directory, 'dist/extension.js'), 'unchanged runtime');
    await expect(verifyInstalled(candidate, directory)).resolves.toHaveLength(2);
    await fs.writeFile(path.join(directory, 'dist/extension.js'), 'modified runtime');
    await expect(verifyInstalled(candidate, directory)).rejects.toThrow('Installed bytes differ');
    await fs.writeFile(path.join(directory, 'dist/extension.js'), 'unchanged runtime');
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ ...manifest, publisher: 'other' }));
    await expect(verifyInstalled(candidate, directory)).rejects.toThrow('Installed manifest mismatch');
  });
  test('readiness waits are bounded and preserve predicate failures', async () => {
    await expect(waitFor(async () => false, 'not ready', 1)).rejects.toThrow('Timed out: not ready');
    await expect(waitFor(async () => { throw new Error('real failure'); }, 'check')).rejects.toThrow('real failure');
    await expect(waitFor(async () => 'ready', 'check')).resolves.toBe('ready');
  });
  test('fixture cleanup still runs if owned editor teardown fails', async () => {
    const cell = new Cell({});
    cell.closeEditor = jest.fn(async () => { throw new Error('editor teardown'); });
    cell.fixture = { close: jest.fn(async () => {}) };
    cell.sandbox = { close: jest.fn(async () => {}) };
    await expect(cell.close()).rejects.toThrow('editor teardown');
    expect(cell.fixture.close).toHaveBeenCalledTimes(1);
    expect(cell.sandbox.close).toHaveBeenCalledTimes(1);
  });
  test('sandbox environment changes only child environment and removes inherited editor IPC', () => {
    const original = process.env.USERPROFILE;
    const env = isolatedEnvironment(path.resolve(root));
    expect(env.USERPROFILE).toBe(path.join(path.resolve(root), 'home'));
    expect(process.env.USERPROFILE).toBe(original);
    expect(Object.keys(env).some(key => /^(VSCODE_|CURSOR_|SFTP_SYNC_AI_MCP_)/.test(key))).toBe(false);
  });
  test('public observations redact path case variants and reject secrets/capabilities', () => {
    const journey = new Journey(root);
    expect(JSON.stringify(journey.sanitize({ file: path.join(root, 'workspace', 'file.txt') }))).not.toContain(root);
    expect(JSON.stringify(journey.sanitize({ file: path.join(root.toLowerCase(), 'file.txt') }))).not.toContain(root.toLowerCase());
    for (const input of [{ password: 'secret' }, { token: 'secret' }, { data: 'SFTP_SYNC_AI_MCP_CONFIG=value' },
      { data: '-----BEGIN EC PRIVATE KEY-----' }]) {
      expect(() => journey.sanitize(input)).toThrow('Sensitive evidence');
    }
  });
  test('sign-off refuses missing, failed, duplicate or wrong-candidate scenarios', () => {
    const records = [...cleanScenarios, 'ftp-warning-cancel', 'ftp-timestamp-unavailable']
      .map(id => ({ id, status: 'PASS', candidateSha256: candidatePin.sha256, source: candidatePin.source }));
    expect(assertRow(records, 'ftp', 'clean')).toHaveLength(records.length);
    expect(() => assertRow(records.slice(1), 'ftp', 'clean')).toThrow('installed');
    expect(() => assertRow([...records, records[0]], 'ftp', 'clean')).toThrow('installed');
    expect(() => assertRow([...records, { id: 'stage-errors', status: 'FAIL' }], 'ftp', 'clean')).toThrow('failed attempt');
    expect(() => assertRow(records.map(record => ({ ...record, candidateSha256: 'bad' })), 'ftp', 'clean')).toThrow('Mixed candidate');
  });
  test('public export refuses escaped Windows paths, credential fields and capability dumps', () => {
    for (const value of [
      { path: 'C:\\Users\\somebody\\workspace' }, { path: 'c:/Users/somebody/workspace' },
      { password: 'not-for-evidence' }, { capability: 'not-for-evidence' },
      { data: '-----BEGIN EC PRIVATE KEY-----' },
      { path: '/home/somebody/project' },
    ]) expect(() => assertPublicEvidence(JSON.stringify(value))).toThrow();
    expect(() => assertPublicEvidence(JSON.stringify({ path: '<sandbox>/file.txt', sha256: 'a'.repeat(64) }))).not.toThrow();
    expect(() => assertPublicEvidence(JSON.stringify({ description: 'same profile/home/workspace/endpoint' }))).not.toThrow();
  });
  test('sandbox cleanup runs even when protocol teardown fails', async () => {
    const cell = new Cell({});
    cell.closeEditor = jest.fn(async () => {});
    cell.fixture = { close: jest.fn(async () => { throw new Error('protocol teardown'); }) };
    cell.sandbox = { close: jest.fn(async () => {}) };
    await expect(cell.close()).rejects.toThrow('protocol teardown');
    expect(cell.sandbox.close).toHaveBeenCalledTimes(1);
  });
  test('sandbox separates write-only failure from preflight/read failures', async () => {
    const sandbox = await createSandbox();
    try {
      await sandbox.seed('/target.txt', 'still readable');
      sandbox.denyWrite('/target.txt');
      expect((await sandbox.read('/target.txt')).toString()).toBe('still readable');
      expect(() => sandbox.assertWritable('/target.txt')).toThrow('Write permission denied');
      sandbox.allowWrite('/target.txt');
      expect(sandbox.assertWritable('/target.txt')).toBe(sandbox.assertAllowed('/target.txt'));
    } finally { await sandbox.close(); }
  });
});

describe.each([['ftp', startFTP], ['sftp', startSFTP]])('%s RC stable-endpoint fixture', (_name, start) => {
  test('same sandbox and endpoint can restart without altering its bytes; faults can be cleared', async () => {
    const sandbox = await createSandbox();
    let server;
    try {
      server = await start({ sandbox });
      const port = server.port;
      await sandbox.seed('/kept.txt', 'kept bytes');
      await server.close();
      server = await start({ sandbox, port });
      expect(server.port).toBe(port);
      expect((await sandbox.read('/kept.txt')).toString()).toBe('kept bytes');
      sandbox.disconnect('download', 'always');
      expect(sandbox.consumeDisconnect('download')).toBe(true);
      sandbox.clearDisconnects();
      expect(sandbox.consumeDisconnect('download')).toBe(false);
    } finally {
      if (server) await server.close();
      await sandbox.close();
    }
  });
});
