const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const request = require('./control');
const { sha256 } = require('./artifacts');
const { connect, waitFor, sleep } = require('./cdp');
const pin = require('./candidate.json');

class Journey {
  constructor(root) {
    this.root = path.resolve(root);
    this.workspace = path.join(this.root, 'workspace');
    this.configPath = path.join(this.workspace, '.vscode', 'sftp.json');
    this.records = [];
  }
  control(body) { return request(this.root, body); }
  probe(body) { return this.control({ op: 'probe', request: body }); }
  async start(command, args = []) { return this.probe({ op: 'start', command, args }); }
  async done(job) {
    const result = await waitFor(async () => {
      const result = await this.probe({ op: 'job', id: job.id });
      return result.status === 'pending' ? undefined : result;
    }, 'editor command', 60000);
    assert.equal(result.status, 'done', result.error);
  }
  async command(command, args = []) { await this.done(await this.start(command, args)); }
  async text() { return this.control({ op: 'ui' }); }
  async expectText(text, timeout = 15000) {
    return waitFor(async () => {
      const value = await this.text(); return value.includes(text) && value;
    }, `UI containing ${text}`, timeout);
  }
  async click(text) {
    await sleep(450); // Native/workbench menus and notification toasts animate.
    await waitFor(() => this.ui.click(text), `UI button ${text}`);
  }
  async notification(text) {
    await this.command('notifications.showList');
    await this.expectText(text);
    await this.click(text);
  }
  async modal(button, expected, dismiss = false) {
    const elements = await waitFor(async () => {
      const elements = await this.control({ op: 'native', action: 'inspect' });
      return elements.some(item => item.name.includes(expected)) && elements;
    }, `native modal ${expected}`, 30000);
    await this.control({ op: 'native', action: dismiss ? 'dismiss' : 'click', button });
    await sleep(300);
    return elements.filter(item => item.type === 'Native.Button' ||
      item.name.includes(expected) || item.name.startsWith('Connection/profile:'));
  }
  async snapshot() { return this.control({ op: 'snapshot' }); }
  async remote(file) {
    const state = await this.snapshot();
    const entry = state.tree.find(entry => entry.path === file);
    assert(entry, `Remote file missing: ${file}`);
    return Buffer.from(entry.content, 'base64').toString();
  }
  async local(file, content) {
    await fs.mkdir(path.dirname(path.join(this.workspace, file)), { recursive: true });
    await fs.writeFile(path.join(this.workspace, file), content);
  }
  async seed(file, content, mtime) {
    await this.control({ op: 'seed', path: file, content, mtime });
  }
  async config(value) {
    // Configuration is reloaded on editor save, not arbitrary external disk writes.
    const saved = await this.probe({ op: 'save', file: '.vscode/sftp.json', content: JSON.stringify(value, null, 2) });
    assert.equal(saved.dirty, false, 'Editor configuration save did not complete');
    assert.deepEqual(JSON.parse(await fs.readFile(this.configPath, 'utf8')), value);
    await sleep(1000);
  }
  sanitize(value) {
    let text = JSON.stringify(value);
    for (const root of [this.root, this.workspace, os.homedir()]) {
      const forward = root.replace(/\\/g, '/');
      for (const form of [root, forward, forward.replace(/^([a-z]):/i, '$1%3A'), encodeURIComponent(root), encodeURIComponent(forward)]) {
        const escaped = JSON.stringify(form).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(escaped, 'gi'), '<sandbox>');
      }
    }
    // Only non-secret structured assertions and visible text are recorded.
    assert(!/SFTP_SYNC_AI_MCP_CONFIG|-----BEGIN [^-]*PRIVATE KEY|"token":|"password"\s*:\s*"[^"]/.test(text),
      'Sensitive evidence must not be recorded');
    return JSON.parse(text);
  }
  async record(id, expected, observed) {
    const record = this.sanitize({ id, status: 'PASS', utc: new Date().toISOString(),
      candidateSha256: pin.sha256, source: pin.source,
      operator: 'Kent (gpt-6-astra implementation agent)', expected, observed });
    this.records.push(record);
    await fs.appendFile(path.join(this.root, 'observations.jsonl'), JSON.stringify(record) + '\n');
    console.log(`PASS ${id}`);
  }
  async initialize() {
    this.info = await this.control({ op: 'info' });
    this.ui = await connect(this.info.debugPort);
    this.protocol = this.info.protocol;
    await this.record('installed', `${this.info.productVersion === '0.0.0' ? 'Synthetic predecessor' : 'Canonical'} installed bytes, active product, English editor`,
      { ...this.info, candidate: pin, os: { type: os.type(), release: os.release(), arch: os.arch() } });
  }
  async configure() {
    await this.control({ op: 'command', label: 'SFTP: Config' });
    await waitFor(async () => {
      try { return await fs.readFile(this.configPath, 'utf8'); } catch { return undefined; }
    }, 'generated config');
    const generated = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
    assert.equal(generated.conflictCheck, true);
    assert.deepEqual(generated.backup, {
      enabled: true, location: 'local', folder: '.vscode/sftp-backup', versions: 100, onDelete: false,
    });
    assert.equal(generated.uploadOnSave, false);
    assert.equal(generated.syncOption.delete, false);
    assert(Object.values(generated.watcher).every(value => value === false));
    this.validConfig = { ...generated, name: `RC ${this.protocol.toUpperCase()}`,
      host: '127.0.0.1', protocol: this.protocol, port: this.info.port, username: 'test', remotePath: '/',
      concurrency: 1, connectTimeout: 10000,
    };
    if (this.protocol === 'ftp') this.validConfig.secure = false;
    await this.config(this.validConfig);
    const before = sha256(await fs.readFile(this.configPath));
    await this.command('sftpSyncAI.config');
    await sleep(500);
    assert.equal(sha256(await fs.readFile(this.configPath)), before);
    await this.record('configuration', 'Strict JSON safe defaults; existing config not rewritten',
      { generated, existingSha256: before, noPlaintextCredential: !('password' in this.validConfig) });
    await this.command('workbench.action.closeAllEditors');
  }
  async connect() {
    const before = await this.snapshot();
    if (this.protocol === 'ftp') {
      const cancelled = await this.start('sftpSyncAI.testConnection');
      const modal = await this.modal('Cancel', 'Plain FTP');
      await this.done(cancelled);
      assert.deepEqual(await this.snapshot(), before);
      await this.record('ftp-warning-cancel', 'Encryption warning Cancel causes zero protocol work', { modal, unchanged: true });
    }
    const job = await this.start('sftpSyncAI.testConnection');
    if (this.protocol === 'ftp') await this.modal('Continue', 'Plain FTP');
    await waitFor(async () => (await this.text()).includes('password'), 'credential input', 15000);
    await this.control({ op: 'insert', text: 'test' });
    await this.control({ op: 'key', key: 'Enter', code: 'Enter', virtualKey: 13 });
    await this.expectText('Secret Storage');
    await this.notification('Save');
    if (this.protocol === 'sftp') {
      const text = await this.expectText(this.info.fingerprint);
      await this.record('sftp-first-key', 'First-key prompt matches independently generated fixture fingerprint',
        { fingerprint: this.info.fingerprint, prompt: text });
      await this.notification('Accept');
    }
    const message = await this.expectText('Test Connection succeeded');
    const after = await this.snapshot();
    assert.deepEqual(after.tree, before.tree);
    assert(!after.operations.some(op => /^(STOR|DELE|RMD|MKD|RNFR|RNTO|OPEN_WRITE|WRITE|REMOVE|RENAME|MKDIR)$/.test(op.operation)));
    await this.record('connection', 'Product prompt/save and read-only successful probe', { message, operations: after.operations });
    await this.command('notifications.hideList');
    await this.command('notifications.clearAll');
    await this.done(job);
  }
  async transfer(command, file) {
    await this.command(`sftpSyncAI.${command}.file`, [{ file }]);
  }
  async transfers() {
    await this.local('first.txt', 'first exact upload\n');
    await this.transfer('upload', 'first.txt');
    assert.equal(await this.remote('/first.txt'), 'first exact upload\n');
    await this.seed('/first.txt', 'first exact download\n', '2026-09-24T10:00:00Z');
    await this.transfer('download', 'first.txt');
    assert.equal(await fs.readFile(path.join(this.workspace, 'first.txt'), 'utf8'), 'first exact download\n');
    await this.assertNoRootErrors();
    await this.record('first-transfer', 'Upload and download exact bytes; first hidden-tree refresh has no root failure', { uploaded: true, downloaded: true,
      queue: await this.queue('first.txt', 'check'), ui: await this.text() });
    await this.local('primary/replace.txt', 'old local\n');
    await this.local('primary/local-only.txt', 'preserve local-only\n');
    await this.seed('/primary/replace.txt', 'primary remote replacement\n');
    await this.seed('/primary/new.txt', 'primary remote new\n');
    await this.command('sftpSyncAI.sync.remoteToLocal', [{ file: 'primary' }]);
    assert.equal(await fs.readFile(path.join(this.workspace, 'primary/replace.txt'), 'utf8'), 'primary remote replacement\n');
    assert.equal(await fs.readFile(path.join(this.workspace, 'primary/new.txt'), 'utf8'), 'primary remote new\n');
    assert.equal(await fs.readFile(path.join(this.workspace, 'primary/local-only.txt'), 'utf8'), 'preserve local-only\n');
    await this.record('primary-sync', 'Remote-to-Local replaces/creates and retains local-only content',
      { bytesVerified: true, downloadRecoveryVersionPromised: false, ui: await this.text() });
    await this.seed('/bulk/replace.txt', 'bulk remote before\n');
    await this.transfer('download', 'bulk/replace.txt');
    await this.local('bulk/replace.txt', 'bulk local replacement\n');
    await this.seed('/bulk/remote-only.txt', 'preserve remote-only\n');
    const config = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
    const marker = path.join(this.root, 'hook-count');
    await this.config({ ...config, hooks: { ...config.hooks,
      preSync: `"${process.execPath}" "${path.join(__dirname, 'hook.js')}" "${marker}"`,
    } });
    const before = await this.snapshot();
    const localBefore = sha256(await fs.readFile(path.join(this.workspace, 'bulk/replace.txt')));
    const cancelled = await this.start('sftpSyncAI.sync.localToRemote', [{ file: 'bulk' }]);
    const modal = await this.modal('Cancel', 'Local');
    await this.done(cancelled);
    assert.deepEqual(await this.snapshot(), before);
    assert.equal(sha256(await fs.readFile(path.join(this.workspace, 'bulk/replace.txt'))), localBefore);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    const dismissed = await this.start('sftpSyncAI.sync.localToRemote', [{ file: 'bulk' }]);
    await this.modal('Cancel', 'Confirm Local', true);
    await this.done(dismissed);
    assert.deepEqual(await this.snapshot(), before);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    const continued = await this.start('sftpSyncAI.sync.localToRemote', [{ file: 'bulk' }]);
    await this.modal('Sync Local \u2192 Remote', 'Confirm Local');
    await this.done(continued);
    assert.equal(await this.remote('/bulk/replace.txt'), 'bulk local replacement\n');
    assert.equal(await this.remote('/bulk/remote-only.txt'), 'preserve remote-only\n');
    assert.equal(await fs.readFile(marker, 'utf8'), 'executed\n');
    await this.record('bulk-warning', 'Modal names direction/profile/paths; cancel is inert; continue overwrites',
      { modal, cancelUnchanged: true, windowDismissUnchanged: true, cancelHookNotRun: true, approvedHookCount: 1, continueBytesVerified: true,
        queue: await this.queue('replace.txt', 'check'), ui: await this.text() });
    await this.config(config);
    await this.command('workbench.action.closeAllEditors');
  }
  async queue(file, icon) {
    await this.command('workbench.view.extension.sftp');
    const rows = await waitFor(() => this.ui.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.monaco-list-row')]
        .filter(row => /^(local|remote) /.test(row.textContent) && row.textContent.includes(${JSON.stringify(file)}))
        .map(row => ({
          label: row.textContent, tooltip: row.getAttribute('aria-label'),
          icons: [...row.querySelectorAll('[class*="codicon-"]')].map(node => node.className),
        }));
      return rows.some(row => row.icons.some(value => value.includes('codicon-${icon}'))) ? rows : false;
    })()`), `terminal ${icon} queue row for ${file}`);
    return rows;
  }
  async backupMenu(label) {
    // A refreshed TreeView can dismiss a just-opened context menu. Re-open only
    // this non-mutating menu, never a Restore confirmation or transfer command.
    await waitFor(async () => {
      await this.ui.row(label, 'right');
      await sleep(500);
      return (await this.text()).includes('Restore Backup') && await this.ui.click('Restore Backup');
    }, 'stable backup context menu');
  }
  async beginConflict(name) {
    const file = `${name}.txt`;
    await this.seed(`/${file}`, `${name} baseline\n`, '2026-09-24T09:00:00Z');
    await this.transfer('download', file);
    await this.seed(`/${file}`, `${name} remote edit\n`, '2026-09-24T09:02:00Z');
    await this.local(file, `${name} local edit\n`);
    const job = await this.start('sftpSyncAI.upload.file', [{ file }]);
    await this.expectText(`blocked upload of ${file}`);
    return { file, job, remote: `${name} remote edit\n` };
  }
  async manual() {
    await this.command('notifications.clearAll');
    const manual = await this.beginConflict('manual');
    await this.control({ op: 'pick', text: 'Open Diff' });
    await waitFor(async () => {
      const tabs = await this.probe({ op: 'tabs' });
      return tabs.some(tab => /diff/i.test(tab.type) || tab.label.includes('(remote \u2194 local)')) && tabs;
    }, 'real diff editor');
    const tabs = await this.probe({ op: 'tabs' });
    await this.control({ op: 'pick', text: 'Cancel upload' });
    await this.done(manual.job);
    assert.equal(await this.remote('/manual.txt'), manual.remote);
    const overwrite = await this.start('sftpSyncAI.upload.file', [{ file: manual.file }]);
    await this.expectText('blocked upload of manual.txt');
    await this.control({ op: 'pick', text: 'OverwriteUpload this file' });
    await this.done(overwrite);
    assert.equal(await this.remote('/manual.txt'), 'manual local edit\n');
    await this.record('manual-conflict', 'Open Diff, cancellation leaves remote unchanged, explicit overwrite succeeds',
      { tabs, cancelledUnchanged: true, overwrittenBytes: true, ui: await this.text() });
    await this.command('workbench.action.closeAllEditors');
  }
  async setupTools() {
    if (this.info.editor !== 'Cursor') {
      const startup = await this.start('workbench.mcp.startServer', ['*', { waitForLiveTools: true }]);
      await waitFor(async () => {
        const tools = (await this.probe({ op: 'tools' })).filter(tool => /_conflicts_/.test(tool.name));
        return tools.length === 8 && tools;
      }, 'eight automatically registered MCP tools');
      await this.done(startup);
    }
    this.agentClient = await require('./fake-agent').connectAgent(this.info);
    await this.record('mcp-registration', 'Actual editor starts packaged stdio MCP; eight tools are available',
      { tools: this.agentClient.names, registration: 'normal installed extension',
        transport: 'official SDK / identical installed stdio / live editor bridge',
        editorLaunchedMcpPid: this.agentClient.editorMcpPid });
  }
  async tool(name, input = {}) {
    return this.agentClient.call(name, input);
  }
  async findConflict(file) {
    return waitFor(async () => {
      const list = await this.tool('conflicts_list');
      assert.equal(list.ok, true);
      return list.conflicts.find(item => item.path === file && ['pending', 'reviewing'].includes(item.status));
    }, `captured ${file}`);
  }
  async agent() {
    await this.setupTools();
    const happy = await this.beginConflict('agent');
    let conflict = await this.findConflict(happy.file);
    const selector = { conflictId: conflict.conflictId, workspace: conflict.workspace };
    const context = await this.tool('conflicts_get', selector);
    const local = await this.tool('conflicts_read', { ...selector, side: 'local' });
    const remote = await this.tool('conflicts_read', { ...selector, side: 'remote' });
    assert.equal(remote.content, happy.remote);
    const diff = await this.tool('conflicts_diff', selector);
    assert.equal(diff.ok, true);
    const submit = await this.tool('conflicts_submit_local', { ...selector, expectedRevision: context.revision,
      expectedLocalSha256: local.sha256, content: 'agent first merged candidate\n' });
    assert.equal(submit.accepted, true);
    assert.equal(await this.remote('/agent.txt'), happy.remote);
    await this.seed('/agent.txt', 'agent raced remote\n', '2026-09-24T09:04:00Z');
    const stale = await this.tool('conflicts_resolve', { ...selector, expectedRevision: submit.revision, action: 'upload' });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, 'stale');
    conflict = await this.tool('conflicts_get', selector);
    const refreshed = await this.tool('conflicts_read', { ...selector, side: 'remote' });
    assert.equal(refreshed.content, 'agent raced remote\n');
    const reread = await this.tool('conflicts_read', { ...selector, side: 'local' });
    const merged = 'agent final exact merged bytes\n';
    const prepared = await this.tool('conflicts_submit_local', { ...selector, expectedRevision: conflict.revision,
      expectedLocalSha256: reread.sha256, content: merged });
    assert.equal(prepared.accepted, true);
    const resolved = await this.tool('conflicts_resolve', { ...selector, expectedRevision: prepared.revision, action: 'upload' });
    assert.equal(resolved.accepted, true);
    await this.done(happy.job);
    const terminal = await this.tool('conflicts_wait', { ...selector, expectedRevision: prepared.revision, timeoutSeconds: 5 });
    assert.equal(terminal.status, 'uploaded');
    assert.equal(terminal.terminal, true);
    assert.equal(await this.remote('/agent.txt'), merged);
    await this.record('agent-stale-upload', 'Scripted editor tools re-inspect stale state, submit, resolve, wait uploaded; no manual approval',
      { context, diff, stale, prepared, terminal, remoteSha256: sha256(Buffer.from(merged)), manualApprovals: 0 });

    const cancelled = await this.beginConflict('agent-cancel');
    const cancelContext = await this.findConflict(cancelled.file);
    const cancelSelector = { conflictId: cancelContext.conflictId, workspace: cancelContext.workspace };
    await this.probe({ op: 'save', file: cancelled.file, content: 'saved editor merge to acknowledge\n' });
    const saved = await this.tool('conflicts_read', { ...cancelSelector, side: 'local' });
    const acknowledged = await this.tool('conflicts_acknowledge_local', { ...cancelSelector,
      expectedRevision: cancelContext.revision, expectedLocalSha256: saved.sha256 });
    assert.equal(acknowledged.accepted, true);
    const cancel = await this.tool('conflicts_resolve', { ...cancelSelector,
      expectedRevision: acknowledged.revision, action: 'cancel' });
    assert.equal(cancel.accepted, true);
    await this.done(cancelled.job);
    const cancelTerminal = await this.tool('conflicts_wait', { ...cancelSelector,
      expectedRevision: acknowledged.revision, timeoutSeconds: 5 });
    assert.equal(cancelTerminal.status, 'cancelled');
    assert.equal(await this.remote(`/${cancelled.file}`), cancelled.remote);
    await this.record('agent-acknowledge-cancel', 'Saved-edit acknowledgement and terminal cancellation do not mutate remote',
      { acknowledged, cancelTerminal, remoteUnchanged: true });
    await this.command('workbench.action.closeAllEditors');

    const failed = await this.beginConflict('agent-failure');
    const failure = await this.findConflict(failed.file);
    const failureSelector = { conflictId: failure.conflictId, workspace: failure.workspace };
    const failureLocal = await this.tool('conflicts_read', { ...failureSelector, side: 'local' });
    const failureSubmit = await this.tool('conflicts_submit_local', { ...failureSelector, expectedRevision: failure.revision,
      expectedLocalSha256: failureLocal.sha256, content: 'agent write must fail with a partial upload\n' });
    assert.equal(failureSubmit.accepted, true);
    const before = await this.snapshot();
    await this.control({ op: 'disconnect', operation: 'upload' });
    await this.tool('conflicts_resolve', { ...failureSelector, expectedRevision: failureSubmit.revision, action: 'upload' });
    await this.done(failed.job);
    const failedTerminal = await this.tool('conflicts_wait', { ...failureSelector,
      expectedRevision: failureSubmit.revision, timeoutSeconds: 5 });
    assert.equal(failedTerminal.status, 'failed');
    const after = await this.snapshot();
    const writes = after.operations.slice(before.operations.length).filter(op => ['STOR', 'OPEN_WRITE'].includes(op.operation));
    assert.equal(writes.length, 1, 'An unsafe write must not be replayed');
    await this.record('agent-upload-failure', 'Induced write failure reports failed, not uploaded; no blind write retry',
      { failedTerminal, writes, queue: await this.queue(failed.file, 'error'), ui: await this.text() });
  }
  async backups() {
    await this.command('notifications.clearAll');
    await this.seed('/restore.txt', 'restore earlier remote text\n');
    await this.transfer('download', 'restore.txt');
    await this.local('restore.txt', 'restore current remote text\n');
    await this.transfer('upload', 'restore.txt');
    assert.equal(await this.remote('/restore.txt'), 'restore current remote text\n');
    const backupRoot = path.join(this.workspace, '.vscode', 'sftp-backup');
    const names = (await fs.readdir(backupRoot)).filter(name => name.startsWith('restore.txt.'));
    assert(names.length >= 1);
    const matching = [];
    for (const name of names) {
      if (await fs.readFile(path.join(backupRoot, name), 'utf8') === 'restore earlier remote text\n') matching.push(name);
    }
    assert(matching.length >= 1);
    await this.command('workbench.view.extension.sftp');
    await this.command('sftpSyncAI.revealInRemoteExplorer', [{ file: 'restore.txt' }]);
    const label = matching.sort().at(-1);
    await this.ui.row(label);
    await this.expectText('restore earlier remote text'.replace(/ /g, '\u00a0'));
    const opened = await this.text();
    const before = await this.snapshot();
    await this.backupMenu(label);
    const modal = await this.modal('Cancel', 'Restore backup from');
    assert.deepEqual(await this.snapshot(), before);
    await this.backupMenu(label);
    await this.modal('Restore', 'Restore backup from');
    await this.expectText('Restored backup to /restore.txt');
    assert.equal(await this.remote('/restore.txt'), 'restore earlier remote text\n');
    const currentNames = (await fs.readdir(backupRoot)).filter(name => name.startsWith('restore.txt.'));
    const contents = await Promise.all(currentNames.map(name => fs.readFile(path.join(backupRoot, name), 'utf8')));
    assert(contents.includes('restore current remote text\n'), 'Pre-restore protection must preserve current remote');
    await this.record('backup-restore', 'Actual Local Backups view/open; cancel inert; restore exact bytes with pre-restore protection',
      { opened, modal, cancelUnchanged: true, restored: true, preRestoreProtection: true, backupCount: currentNames.length,
        ui: await this.text(), scope: 'text only; no sync-delete or download undo guarantee' });
    await this.command('workbench.action.closeAllEditors');
  }
  async probeConnection(expected = 'Test Connection succeeded') {
    await this.command('notifications.clearAll');
    const job = await this.start('sftpSyncAI.testConnection');
    if (this.protocol === 'ftp') await this.modal('Continue', 'Plain FTP');
    await this.command('notifications.showList');
    const text = await this.expectText(expected, 30000);
    // showInformationMessage/showErrorMessage resolve when dismissed; they are
    // not a transfer or connection completion signal.
    await this.command('notifications.clearAll');
    // Notification dismissal is not required for functional success.
    const status = await this.probe({ op: 'job', id: job.id });
    assert(['pending', 'done'].includes(status.status));
    return text;
  }
  async errors() {
    const valid = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
    await this.command('workbench.view.explorer');
    await this.config({ ...valid, protocol: 'invalid' });
    const beforeConfig = await this.snapshot();
    const badConfig = await this.start('sftpSyncAI.testConnection');
    await this.command('notifications.showList');
    const configMessage = await this.expectText('Test Connection - Configuration');
    assert(configMessage.includes('Open Config'));
    assert.deepEqual(await this.snapshot(), beforeConfig);
    await this.click('Open Config');
    await this.config(valid);
    await this.command('workbench.action.closeAllEditors');
    await this.record('error-configuration', 'Configuration error before network; Open Config and save recover',
      { message: configMessage, unchanged: true, recovered: await this.probeConnection() });
    // Flush completed notification jobs before starting further error probes.
    await this.probe({ op: 'job', id: badConfig.id });

    await this.control({ op: 'authentication', accept: false });
    const auth = await this.probeConnection('Test Connection - Authentication');
    await this.control({ op: 'authentication', accept: true });
    await this.record('error-authentication', 'Saved credential rejection is actionable and endpoint recovers',
      { message: auth, recovered: await this.probeConnection(), credentialReentry: false });

    await this.control({ op: 'fixture', options: { available: false } });
    const network = await this.probeConnection('Test Connection - Network');
    await this.control({ op: 'fixture', options: {} });
    await this.record('error-network', 'Unavailable loopback endpoint fails; same endpoint reconnects',
      { message: network, recovered: await this.probeConnection() });

    await this.config({ ...valid, remotePath: '/does-not-exist' });
    const missing = await this.probeConnection('Test Connection - Remote path');
    await this.config(valid);
    await this.record('error-path', 'Missing remotePath reports next action; corrected path succeeds',
      { message: missing, recovered: await this.probeConnection() });

    await this.seed('/denied/sample.txt', 'permission fixture\n');
    await this.control({ op: 'deny', path: '/denied' });
    await this.config({ ...valid, remotePath: '/denied' });
    const denied = await this.probeConnection('Test Connection - Permission');
    await this.control({ op: 'allow', path: '/denied' });
    const permissionsRecovered = await this.probeConnection();
    await this.config(valid);
    await this.record('error-permission', 'Denied remote folder reports permission action; granting access recovers',
      { message: denied, recovered: permissionsRecovered });

    if (this.protocol === 'sftp') {
      await this.control({ op: 'fixture', options: { changedKey: true } });
      const changed = await this.probeConnection('Test Connection - Host key');
      assert(changed.includes('does not match the saved key'));
      await this.control({ op: 'fixture', options: {} });
      await this.record('sftp-changed-key', 'Changed key is rejected without accept-new-key shortcut; original key reconnects',
        { message: changed, recovered: await this.probeConnection() });
    }
    await this.transferErrors();
  }
  async partialSync() {
    await this.local('partial-sync/a-ok.txt', 'partial operation completed item\n');
    await this.local('partial-sync/z-denied.txt', 'partial operation failed item\n');
    await this.seed('/partial-sync/keep.txt', 'unrelated remote preserved\n');
    await this.control({ op: 'denyWrite', path: '/partial-sync/z-denied.txt' });
    const job = await this.start('sftpSyncAI.sync.localToRemote', [{ file: 'partial-sync' }]);
    await this.modal('Sync Local \u2192 Remote', 'Confirm Local');
    await this.done(job);
    const message = await this.text();
    const completed = await this.remote('/partial-sync/a-ok.txt');
    assert.equal(completed, 'partial operation completed item\n');
    assert.equal(await this.remote('/partial-sync/keep.txt'), 'unrelated remote preserved\n');
    assert(message.includes('failed: 1'));
    assert(message.includes('Completed: 1'));
    const queue = await this.queue('z-denied.txt', 'error');
    await this.control({ op: 'allowWrite', path: '/partial-sync/z-denied.txt' });
    await this.transfer('upload', 'partial-sync/z-denied.txt');
    assert.equal(await this.remote('/partial-sync/z-denied.txt'), 'partial operation failed item\n');
    await this.record('bulk-partial-result', 'Mixed approved sync reports completed and failed items truthfully and recovers',
      { message, queue, completedSha256: sha256(Buffer.from(completed)), recovered: true });
  }
  async assertNoRootErrors() {
    const logs = [];
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.name === 'exthost.log') logs.push(await fs.readFile(file, 'utf8'));
      }
    }
    await walk(path.join(this.root, 'user-data/logs'));
    assert(!logs.some(log => /Can't find config for remote resource/.test(log)), 'Detached Remote Explorer root rejection');
  }
  async explorerErrors() {
    await this.command('notifications.clearAll');
    await this.command('workbench.action.closeAllEditors');
    await this.seed('/qa-folder/listed.txt', 'readonly explorer fixture\n');
    await this.command('workbench.view.extension.sftp');
    await this.command('sftpSyncAI.remoteExplorer.refresh');
    await this.ui.row('qa-folder');
    await this.expectText('listed.txt');
    const before = await this.snapshot();
    await this.control({ op: 'deny', path: '/qa-folder' });
    await this.command('sftpSyncAI.remoteExplorer.refresh');
    await this.command('notifications.showList');
    const denied = await this.expectText('Permission was denied');
    assert(denied.includes('Check server ownership/mode or Windows file access'));
    for (const action of ['Copy Diagnostics', 'Troubleshoot', 'Show Output', 'Retry']) assert(denied.includes(action));
    await this.expectText('Read failed: Permission was denied');
    assert(!await this.ui.evaluate(`!![...document.querySelectorAll('.notification-list-item')]
      .find(node => /550 Permission denied|Permission denied: \\/qa-folder|An unknown error occurred/.test(node.innerText))`));
    assert.deepEqual((await this.snapshot()).tree, before.tree);
    let diagnostics;
    await this.probe({ op: 'captureClipboard' });
    try {
      await this.click('Copy Diagnostics');
      diagnostics = await waitFor(async () => {
        try { return await this.probe({ op: 'diagnostics' }); } catch { return false; }
      }, 'product Copy Diagnostics');
    } finally {
      await this.probe({ op: 'restoreClipboard' });
    }
    assert.equal(diagnostics.failureId, 'permission.denied');
    assert.equal(diagnostics.retrySafety, 'safe');
    await this.control({ op: 'allow', path: '/qa-folder' });
    await this.command('sftpSyncAI.remoteExplorer.refresh');
    await this.expectText('listed.txt');
    assert(!(await this.text()).includes('Read failed:'));
    const recovered = await this.text();
    const config = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
    await this.command('workbench.view.explorer');
    await this.config({ ...config, name: `${config.name} reloaded` });
    await this.local('after-config-reload.txt', 'upload while remote tree is hidden\n');
    await this.transfer('upload', 'after-config-reload.txt');
    assert.equal(await this.remote('/after-config-reload.txt'), 'upload while remote tree is hidden\n');
    await this.command('workbench.view.extension.sftp');
    await this.command('sftpSyncAI.remoteExplorer.refresh');
    await this.ui.row(`${config.name} reloaded`);
    await this.ui.row('qa-folder');
    await this.expectText('listed.txt');
    await this.assertNoRootErrors();
    await this.record('explorer-error-recovery', 'Actual folder refresh gives categorized redacted actions and persistent failed-read marker; corrected read and hidden config reload recover without detached errors or mutations',
      { denied, diagnostics, remoteReadOnly: true, recovered, hiddenUploadRecovered: true,
        noLazyOrRetiredRootErrors: true, afterReload: await this.text() });
  }
  async transferErrors() {
    const valid = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
    await this.config({ ...valid, ftpReconnectAttempts: 2 });
    await this.local('safe-download.txt', 'old local must survive failed download\n');
    await this.seed('/safe-download.txt', 'new remote after retry\n');
    await this.control({ op: 'disconnect', operation: 'download', mode: 'always' });
    const beforeRead = await this.snapshot();
    await this.transfer('download', 'safe-download.txt');
    assert.equal(await fs.readFile(path.join(this.workspace, 'safe-download.txt'), 'utf8'), 'old local must survive failed download\n');
    const failedRead = await this.snapshot();
    const reads = failedRead.operations.slice(beforeRead.operations.length).filter(op => ['RETR', 'OPEN_READ'].includes(op.operation));
    assert(reads.length >= 1 && reads.length <= 3, 'Safe read retry must be bounded');
    const failedMessage = await this.text();
    await this.control({ op: 'clearFaults' });
    await this.transfer('download', 'safe-download.txt');
    assert.equal(await fs.readFile(path.join(this.workspace, 'safe-download.txt'), 'utf8'), 'new remote after retry\n');
    await this.record('error-download', 'Failed bounded safe-read attempts preserve old local target; explicit retry succeeds',
      { reads, message: failedMessage, oldLocalPreserved: true, retryBytesVerified: true });
    await this.command('notifications.clearAll');
    // Existing agent-upload-failure separately proves writes are attempted once.
    await this.config(valid);
    await this.backupErrors();
  }
  async backupErrors() {
    const valid = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
    await this.local('backup-blocker', 'not a directory\n');
    await this.seed('/backup-failure.txt', 'earlier remote before backup failure\n');
    await this.transfer('download', 'backup-failure.txt');
    await this.config({ ...valid, backup: { ...valid.backup, folder: 'backup-blocker' } });
    await this.local('backup-failure.txt', 'overwrite despite failed backup\n');
    await this.transfer('upload', 'backup-failure.txt');
    assert.equal(await this.remote('/backup-failure.txt'), 'overwrite despite failed backup\n');
    const warning = await this.expectText('Upload completed without an overwrite backup', 10000);
    assert(warning.includes('warnings: 1'));
    await this.config({ ...valid, backup: { ...valid.backup, folder: 'backup-blocker', onDelete: true } });
    const beforeDelete = await this.snapshot();
    const deletion = await this.start('sftpSyncAI.delete.remote', [{ file: 'backup-failure.txt' }]);
    const deleteModal = await this.modal('Delete', 'remote server');
    await this.done(deletion);
    assert.deepEqual((await this.snapshot()).tree, beforeDelete.tree);
    const deleteFailure = await this.text();
    await this.config(valid);
    await this.local('backup-failure.txt', 'backup recovered overwrite\n');
    await this.transfer('upload', 'backup-failure.txt');
    assert.equal(await this.remote('/backup-failure.txt'), 'backup recovered overwrite\n');
    const backupNames = (await fs.readdir(path.join(this.workspace, valid.backup.folder))).filter(name => name.startsWith('backup-failure.txt.'));
    assert(backupNames.length > 0);
    await this.record('error-backup', 'Overwrite backup failure warns but uploads; promised delete backup failure blocks deletion; fixed folder recovers',
      { warning, deleteModal, deleteFailure, deleteUnchanged: true, backupRecovered: true });
    await this.command('workbench.action.closeAllEditors');

    if (this.protocol === 'ftp') {
      await this.control({ op: 'fixture', options: { mdtm: false } });
      await this.config(valid); // clear cached filesystem capability state via real save
      await this.seed('/timestamp.txt', 'timestamp remote must be protected\n');
      await this.transfer('download', 'timestamp.txt');
      await this.local('timestamp.txt', 'timestamp local edit\n');
      const job = await this.start('sftpSyncAI.upload.file', [{ file: 'timestamp.txt' }]);
      await this.expectText('blocked upload of timestamp.txt');
      const message = await this.text();
      await this.ui.pick('Cancel upload');
      await this.done(job);
      assert.equal(await this.remote('/timestamp.txt'), 'timestamp remote must be protected\n');
      await this.control({ op: 'fixture', options: {} });
      await this.config(valid);
      await this.transfer('download', 'timestamp.txt');
      await this.local('timestamp.txt', 'timestamp capability recovered\n');
      await this.transfer('upload', 'timestamp.txt');
      assert.equal(await this.remote('/timestamp.txt'), 'timestamp capability recovered\n');
      await this.record('ftp-timestamp-unavailable', 'Unavailable exact timestamp blocks unsafe overwrite; restored timestamp capability recovers',
        { message, cancelledUnchanged: true, recovered: true });
    }
    const tree = (await this.snapshot()).tree.map(item => item.path);
    assert(!tree.some(file => /\.vscode|conflict\.json|\.pem$|known_hosts|sftp\.json/i.test(file)));
    await this.record('state-isolation', 'Remote listings exclude configuration, secrets, keys and internal conflict state',
      { remotePaths: tree, privateState: 'editor global storage outside workspace' });
  }
  async update() {
    const original = JSON.parse(await fs.readFile(this.configPath, 'utf8'));
    await this.config({ ...original, name: `Custom ${this.protocol.toUpperCase()} update profile`,
      ignore: [...original.ignore, '*.custom-ignore'], backup: { ...original.backup, versions: 37 } });
    const before = sha256(await fs.readFile(this.configPath));
    const knownHosts = path.join(this.root, 'home', '.vscode-sftp', 'known_hosts.json');
    const knownBefore = this.protocol === 'sftp' ? sha256(await fs.readFile(knownHosts)) : undefined;
    await this.backups();
    const backupRoot = path.join(this.workspace, original.backup.folder);
    const backupNames = await fs.readdir(backupRoot);
    const oldBackups = new Map(await Promise.all(backupNames.map(async name => [name, sha256(await fs.readFile(path.join(backupRoot, name)))])));
    const upgrade = await this.control({ op: 'update' });
    this.ui.close();
    this.info = await this.control({ op: 'info' });
    this.ui = await connect(this.info.debugPort);
    assert.equal(this.info.productVersion, '0.1.0');
    assert.equal(sha256(await fs.readFile(this.configPath)), before);
    if (knownBefore) assert.equal(sha256(await fs.readFile(knownHosts)), knownBefore);
    const connection = await this.probeConnection();
    await this.local('after-update.txt', 'post-update credentials and upload\n');
    await this.transfer('upload', 'after-update.txt');
    assert.equal(await this.remote('/after-update.txt'), 'post-update credentials and upload\n');
    for (const [name, hash] of oldBackups) assert.equal(sha256(await fs.readFile(path.join(backupRoot, name))), hash);
    await this.command('workbench.view.extension.sftp');
    await this.command('sftpSyncAI.revealInRemoteExplorer', [{ file: 'restore.txt' }]);
    const restoreName = backupNames.filter(name => name.startsWith('restore.txt.')).sort().at(-1);
    const expected = await fs.readFile(path.join(backupRoot, restoreName), 'utf8');
    await this.backupMenu(restoreName);
    await this.modal('Restore', 'Restore backup from');
    await this.expectText('Restored backup to /restore.txt');
    assert.equal(await this.remote('/restore.txt'), expected);
    await this.assertNoRootErrors();
    await this.record('in-place-update', 'Local synthetic 0.0.0 to canonical 0.1.0 same profile/home/workspace/endpoint; real secrets/config/backups persist',
      { upgrade, configHashBefore: before, configHashAfter: sha256(await fs.readFile(this.configPath)),
        knownHostsHashUnchanged: knownBefore ? true : undefined, connection, credentialPromptsAfterUpdate: 0,
        transferSucceeded: true, preservedBackupCount: oldBackups.size, oldBackupRestored: true, noRootLifecycleErrors: true });
  }
}

async function main() {
  const journey = new Journey(process.argv[2]);
  try {
    await journey.initialize();
    for (const stage of (process.argv[3] || 'configure,connect,transfers').split(',')) {
      console.log(`RUN ${stage}`);
      try {
        await journey[stage]();
      } catch (error) {
        let ui, native, tabs;
        try {
          ui = await journey.text();
          native = await journey.control({ op: 'native', action: 'inspect' });
          tabs = await journey.probe({ op: 'tabs' });
        } catch { /* The owned editor may have exited; preserve the primary failure. */ }
        await fs.appendFile(path.join(journey.root, 'observations.jsonl'), JSON.stringify(journey.sanitize({
          id: `stage-${stage}`, status: 'FAIL', utc: new Date().toISOString(),
          candidateSha256: pin.sha256, source: pin.source,
          observed: { error: error.message, ui, native, tabs },
        })) + '\n');
        throw error;
      }
    }
  } finally {
    if (journey.ui) journey.ui.close();
    if (journey.agentClient) await journey.agentClient.close();
  }
}
module.exports = { Journey };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
