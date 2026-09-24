// Windows-only real installed-editor RC controller; no product code is loaded here.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { verifyCandidate, verifyInstalled, writeArchive, createPredecessor, verifyPredecessor, sha256, readArchive } = require('./artifacts');
const { connect, waitFor, sleep } = require('./cdp');
const pin = require('./candidate.json');
const startFTP = require('../fixtures/ftpServer');
const startSFTP = require('../fixtures/sftpServer');
const createSandbox = require('../fixtures/protocolSandbox');

function isolatedEnvironment(root) {
  const home = path.join(root, 'home');
  const env = { ...process.env, USERPROFILE: home, HOME: home,
    HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(2),
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    SFTP_RC_ROOT: root,
  };
  for (const key of Object.keys(env)) {
    if (/^(ELECTRON_RUN_AS_NODE|VSCODE_|CURSOR_|SFTP_SYNC_AI_MCP_)/i.test(key)) delete env[key];
  }
  return env;
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function editorCLI(executable, args, env) {
  // Calling the installed editor CLI JS under its own Electron avoids cmd quoting.
  const parent = path.dirname(executable);
  let app = path.join(parent, 'resources', 'app');
  try { await fs.access(path.join(app, 'out', 'cli.js')); } catch {
    const dirs = await fs.readdir(parent, { withFileTypes: true });
    const candidates = [];
    for (const dir of dirs.filter(d => d.isDirectory())) {
      const candidate = path.join(parent, dir.name, 'resources', 'app');
      try { await fs.access(path.join(candidate, 'out', 'cli.js')); candidates.push(candidate); } catch {}
    }
    assert.equal(candidates.length, 1, 'Expected one installed editor application directory');
    [app] = candidates;
  }
  return exec(executable, [path.join(app, 'out', 'cli.js'), ...args], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 90000, maxBuffer: 2 * 1024 * 1024,
  });
}

async function buildProbe(file) {
  const entries = new Map();
  for (const name of ['package.json', 'extension.js']) {
    entries.set(`extension/${name}`, await fs.readFile(path.join(__dirname, 'probe', name)));
  }
  entries.set('[Content_Types].xml', Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'
  ));
  entries.set('extension.vsixmanifest', Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="rc-qualification-probe" Version="0.0.1" Publisher="kent-qa"/><DisplayName>RC qualification probe</DisplayName><Description xml:space="preserve">Local QA only</Description><Tags/><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.104.0"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>'
  ));
  await writeArchive(file, entries);
}

class Cell {
  constructor(options) { Object.assign(this, options); }
  async initialize() {
    assert.equal(process.platform, 'win32', 'Real editor runner is Windows-only');
    assert(['ftp', 'sftp'].includes(this.protocol));
    assert(['vscode', 'cursor'].includes(this.editor));
    this.candidate = await verifyCandidate(this.bundle, pin);
    const { verifyReleaseBundle } = require('../../scripts/release');
    await verifyReleaseBundle({
      root: path.resolve(__dirname, '../..'), bundleDir: this.bundle,
      tag: 'v0.1.0', sourceSha: pin.source,
    });
    // Refuse to reuse a profile accidentally. Update reuses this same Cell explicitly.
    await fs.mkdir(this.root, { recursive: false });
    this.env = isolatedEnvironment(this.root);
    this.workspace = path.join(this.root, 'workspace');
    this.data = path.join(this.root, 'user-data');
    this.extensions = path.join(this.root, 'extensions');
    for (const dir of [this.workspace, this.extensions, path.join(this.data, 'User'),
      path.join(this.env.HOME, '.cursor'), path.join(this.env.HOME, 'Desktop'),
      path.join(this.env.HOME, 'Documents'), path.join(this.env.HOME, 'Downloads'),
      this.env.APPDATA, this.env.LOCALAPPDATA]) {
      await fs.mkdir(dir, { recursive: true });
    }
    await fs.writeFile(path.join(this.env.HOME, '.cursor', 'mcp.json'), '{"mcpServers":{}}');
    await fs.writeFile(path.join(this.data, 'User', 'settings.json'), JSON.stringify({
      'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
      'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
      'security.workspace.trust.enabled': false, 'window.restoreWindows': 'none',
      'workbench.enableExperiments': false, 'git.openRepositoryInParentFolders': 'never',
      'files.hotExit': 'off', 'window.title': '${rootName} - RC qualification',
    }, null, 2));
    this.sandbox = await createSandbox();
    if (this.protocol === 'sftp') {
      this.hostKey = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1', privateKeyEncoding: { type: 'sec1', format: 'pem' },
      }).privateKey;
      const { utils } = require('ssh2');
      this.fingerprint = crypto.createHash('sha256').update(utils.parseKey(this.hostKey).getPublicSSH()).digest('hex');
    }
    this.fixture = await (this.protocol === 'ftp' ? startFTP : startSFTP)({
      sandbox: this.sandbox, hostKey: this.hostKey,
    });
    this.port = this.fixture.port;
    this.version = (await editorCLI(this.exe, ['--version'], this.env)).stdout.trim();
    const probe = path.join(this.root, 'probe.vsix');
    await buildProbe(probe);
    if (this.update) {
      this.predecessorFile = this.predecessorVsix || path.join(this.root, 'sftp-sync-ai-0.0.0.vsix');
      this.predecessor = this.predecessorVsix
        ? await verifyPredecessor(this.candidate, this.predecessorFile)
        : await createPredecessor(this.candidate, this.predecessorFile);
      await this.install(this.predecessorFile);
    } else await this.install(this.candidate.file);
    await this.install(probe);
    this.debugPort = await freePort();
    await this.launch();
  }
  async install(file) {
    const result = await editorCLI(this.exe, [
      '--user-data-dir', this.data, '--extensions-dir', this.extensions,
      '--install-extension', file, '--force',
    ], this.env);
    await fs.appendFile(path.join(this.root, 'install.log'), result.stdout + result.stderr);
  }
  async launch() {
    await fs.rm(path.join(this.root, 'probe.json'), { force: true });
    this.process = spawn(this.exe, [
      '--user-data-dir', this.data, '--extensions-dir', this.extensions,
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${this.debugPort}`,
      '--lang=en', '--skip-welcome', '--skip-release-notes', '--disable-updates',
      ...(this.editor === 'cursor' ? ['--skip-onboarding'] : []),
      '--disable-workspace-trust', '--new-window', this.workspace,
    ], { env: this.env, stdio: 'ignore' });
    this.process.on('error', error => { this.launchError = error; });
    this.connection = await waitFor(async () => {
      if (this.launchError) throw this.launchError;
      try { return JSON.parse(await fs.readFile(path.join(this.root, 'probe.json'), 'utf8')); }
      catch { return undefined; }
    }, 'installed extension activation', 90000);
    this.cdp = await connect(this.debugPort);
    this.info = await this.probe({ op: 'info' });
    assert.equal(this.info.productActive, true);
    assert.equal(this.info.language, 'en');
    assert.equal(path.resolve(this.info.workspace).toLowerCase(), this.workspace.toLowerCase());
    assert(this.info.extensionPath.toLowerCase().startsWith((this.extensions + path.sep).toLowerCase()));
    if (this.info.productVersion === '0.1.0') {
      this.verifiedEntries = await verifyInstalled(this.candidate, this.info.extensionPath);
    } else {
      assert(this.update, 'Unexpected product version in clean install row');
      this.verifiedEntries = await verifyInstalled({ entries: await readArchive(this.predecessorFile) }, this.info.extensionPath);
    }
  }
  async probe(body) {
    const response = await fetch(`http://127.0.0.1:${this.connection.port}`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(65000),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    return result.result;
  }
  start(command, args = []) { return this.probe({ op: 'start', command, args }); }
  async done(job) {
    const result = await waitFor(async () => {
      const result = await this.probe({ op: 'job', id: job.id });
      return result.status === 'pending' ? undefined : result;
    }, 'editor command completion', 60000);
    assert.equal(result.status, 'done', result.error);
  }
  async command(command, args = []) { await this.done(await this.start(command, args)); }
  async native(action = 'inspect', button, file) {
    const result = await exec('powershell.exe', [
      '-NoProfile', '-File', path.join(__dirname, 'native.ps1'),
      '-ProcessId', String(this.process.pid), '-Action', action, ...(button ? ['-Button', button] : []),
      ...(file ? ['-File', file] : []),
    ], { timeout: 15000, maxBuffer: 512 * 1024 });
    return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  }
  async closeEditor() {
    if (!this.process) return;
    if (this.cdp) this.cdp.close();
    const process = this.process;
    if (process.exitCode === null) {
      // Task-owned root and descendants only; never kill by editor name.
      await exec('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { timeout: 15000 }).catch(error => {
        if (process.exitCode === null) throw error;
      });
    }
    this.process = undefined;
  }
  async close() {
    try { await this.closeEditor(); } finally {
      try { if (this.fixture) await this.fixture.close(); } finally {
        if (this.sandbox) await this.sandbox.close();
      }
    }
  }
  async reconfigureFixture({ available = true, changedKey = false, mdtm = true } = {}) {
    if (this.fixture) { await this.fixture.close(); this.fixture = undefined; }
    if (!available) return;
    const key = changedKey ? crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1', privateKeyEncoding: { type: 'sec1', format: 'pem' },
    }).privateKey : this.hostKey;
    this.fixture = await (this.protocol === 'ftp' ? startFTP : startSFTP)({
      sandbox: this.sandbox, hostKey: key, port: this.port, mdtm,
    });
  }
  async updateCandidate() {
    assert(this.update && this.info.productVersion === '0.0.0', 'Update requires a synthetic predecessor profile');
    const configPath = path.join(this.workspace, '.vscode', 'sftp.json');
    const configHash = sha256(await fs.readFile(configPath));
    // Use the README's actual Install from VSIX file chooser in the running
    // predecessor profile, then perform a full restart (stronger than reload).
    await this.start('workbench.extensions.action.installVSIX');
    await waitFor(async () => {
      const items = await this.native();
      return items.some(item => item.type === 'Native.Edit' && item.id === 1148);
    }, 'Install from VSIX native file chooser');
    await this.native('file', undefined, this.candidate.file);
    const target = path.join(this.extensions, 'timorfiy.sftp-sync-ai-0.1.0');
    await waitFor(async () => {
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8'));
        return manifest.version === '0.1.0';
      } catch { return false; }
    }, 'actual newer VSIX installation', 60000);
    await verifyInstalled(this.candidate, target);
    const uiBeforeRestart = await this.cdp.text();
    await this.closeEditor();
    await sleep(1000);
    await this.launch();
    assert.equal(this.info.productVersion, '0.1.0');
    assert.equal(sha256(await fs.readFile(configPath)), configHash, 'Update changed product configuration');
    return { predecessor: this.predecessor, candidate: pin, configHash, version: this.info.productVersion,
      installedEntriesVerified: this.verifiedEntries.length, fullRestart: true, endpointPortUnchanged: this.port,
      installation: 'Extensions: Install from VSIX / native file chooser', uiBeforeRestart };
  }
}

async function main() {
  const [bundle, root, editor, protocol, exe, mode, predecessor] = process.argv.slice(2);
  const cell = new Cell({ bundle: path.resolve(bundle), root: path.resolve(root), editor, protocol, exe,
    update: mode === 'update', predecessorVsix: predecessor ? path.resolve(predecessor) : undefined });
  let control;
  const lifetime = setTimeout(() => cleanup().then(() => process.exit(1)), 2 * 60 * 60 * 1000);
  async function cleanup() {
    clearTimeout(lifetime);
    if (control) { control.closeAllConnections(); control.close(); }
    await cell.close();
  }
  process.once('SIGINT', () => cleanup().then(() => process.exit()));
  try {
    await cell.initialize();
    // Private controller for interactive agent-driven qualification. Only fixture
    // paths/actions are accepted; no eval, production source imports or secrets.
    const token = crypto.randomBytes(32).toString('hex');
    control = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(403).end(); return;
      }
      try {
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 256 * 1024) throw new Error('Controller request too large');
          chunks.push(chunk);
        }
        const request = JSON.parse(Buffer.concat(chunks));
        let result;
        switch (request.op) {
          case 'info': result = { ...cell.info, editorBuild: cell.version, protocol: cell.protocol, port: cell.port,
            fingerprint: cell.fingerprint, pid: cell.process.pid, debugPort: cell.debugPort,
            verifiedEntries: cell.verifiedEntries }; break;
          case 'probe': result = await cell.probe(request.request); break;
          case 'native': result = await cell.native(request.action, request.button); break;
          case 'ui': result = await cell.cdp.text(); break;
          case 'command': result = await cell.cdp.command(request.label); break;
          case 'click': result = await cell.cdp.click(request.text); break;
          case 'pick': result = await cell.cdp.pick(request.text); break;
          case 'key': result = await cell.cdp.key(request.key, request.code, request.virtualKey, request.modifiers); break;
          case 'insert': result = await cell.cdp.send('Input.insertText', { text: request.text }); break;
          case 'screenshot': {
            assert.equal(path.basename(request.file), request.file);
            await cell.cdp.screenshot(path.join(cell.root, request.file)); result = true; break;
          }
          case 'seed': await cell.sandbox.seed(request.path, request.content, request.mtime ? new Date(request.mtime) : undefined); result = true; break;
          case 'snapshot': result = { tree: await cell.sandbox.snapshot(), operations: cell.sandbox.operations,
            connections: cell.sandbox.connectionCount }; break;
          case 'deny': cell.sandbox.deny(request.path); result = true; break;
          case 'allow': cell.sandbox.allow(request.path); result = true; break;
          case 'denyWrite': cell.sandbox.denyWrite(request.path); result = true; break;
          case 'allowWrite': cell.sandbox.allowWrite(request.path); result = true; break;
          case 'disconnect': cell.sandbox.disconnect(request.operation, request.mode); result = true; break;
          case 'clearFaults': cell.sandbox.clearDisconnects(); result = true; break;
          case 'authentication': cell.sandbox.credentials.password = request.accept ? 'test' : 'fixture-reject-password'; result = true; break;
          case 'fixture': await cell.reconfigureFixture(request.options); result = true; break;
          case 'update': result = await cell.updateCandidate(); break;
          case 'restart': await cell.closeEditor(); await sleep(1500); await cell.launch(); result = cell.info; break;
          case 'close': result = true; res.end(JSON.stringify({ ok: true, result })); await cleanup(); return;
          default: throw new Error('Unknown controller operation');
        }
        res.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
    control.requestTimeout = 90000;
    control.listen(0, '127.0.0.1', async () => {
      await fs.writeFile(path.join(cell.root, 'control.json'), JSON.stringify({ port: control.address().port, token }));
      console.log(JSON.stringify({ ready: true, editor, protocol, root: cell.root, pid: cell.process.pid,
        candidate: pin.sha256, version: cell.version }));
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = { Cell, isolatedEnvironment, editorCLI, buildProbe };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
