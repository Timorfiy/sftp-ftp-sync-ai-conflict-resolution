// Installed-editor Activity QA. All profiles, credentials and servers are disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Cell } = require('./runner');
const { waitFor, sleep } = require('./cdp');
const { sha256 } = require('./artifacts');

async function run(bundle, root, editors) {
  await fs.mkdir(root, { recursive: false });
  const provenance = JSON.parse(await fs.readFile(path.join(bundle, 'provenance.json')));
  const candidatePin = { file: provenance.artifact.name, sha256: provenance.artifact.sha256,
    bytes: provenance.artifact.bytes, source: provenance.sourceSha, version: provenance.version };
  const report = { platform: `${os.platform()} ${os.release()} ${os.arch()}`, artifact: candidatePin,
    sourceMode: 'working-tree candidate; source is the base commit, not a claim that its commit contains these changes', rows: [] };
  for (const [editor, exe] of Object.entries(editors)) for (const protocol of ['ftp', 'sftp']) {
    const cell = new Cell({ bundle, root: path.join(root, `${editor}-${protocol}`), editor, protocol, exe, candidatePin });
    const row = { editor, protocol, status: 'RUNNING', checks: [] };
    report.rows.push(row);
    const text = expected => waitFor(async () => { const value = await cell.cdp.text(); return value.includes(expected) && value; }, expected, 25000);
    const click = async label => { await sleep(450); await waitFor(() => cell.cdp.click(label), `button ${label}`, 15000); };
    let clipboardCaptured = false;
    try {
      await cell.initialize(); row.version = cell.version;
      assert(cell.info.commands.includes('sftpSyncAI.activity.open'));
      const themes = await cell.probe({ op: 'activityThemes' });
      const dark = themes.find(theme => theme.uiTheme === 'vs-dark');
      const light = themes.find(theme => theme.uiTheme === 'vs');
      assert(dark && light);
      await cell.probe({ op: 'activitySettings', theme: dark.name });
      const configFile = path.join(cell.workspace, '.vscode', 'sftp.json');
      await fs.mkdir(path.dirname(configFile), { recursive: true }); await fs.writeFile(configFile, '{}');
      const config = { name: 'Activity QA', host: '127.0.0.1', port: cell.port, protocol, username: 'test', password: 'test',
        remotePath: '/', uploadOnSave: false, conflictCheck: true, concurrency: 2, connectTimeout: 5000,
        ignore: ['.vscode'], watcher: { files: false, autoUpload: false, autoDelete: false }, backup: { enabled: false } };
      await cell.probe({ op: 'save', file: '.vscode/sftp.json', content: JSON.stringify(config, null, 2) });
      await sleep(1100); await cell.command('workbench.action.closeAllEditors');
      await fs.mkdir(path.join(cell.workspace, 'bundle'));
      await fs.writeFile(path.join(cell.workspace, 'bundle', 'one.txt'), 'one\n');
      await fs.writeFile(path.join(cell.workspace, 'bundle', 'two.txt'), 'two\n');
      const upload = await cell.start('sftpSyncAI.upload.folder', [{ file: 'bundle' }]);
      if (protocol === 'sftp') { await cell.command('notifications.showList'); await text('Accept and connect?'); await click('Accept'); }
      await cell.done(upload);
      assert.equal((await cell.sandbox.read('/bundle/one.txt')).toString(), 'one\n');
      assert.equal((await cell.sandbox.read('/bundle/two.txt')).toString(), 'two\n');
      await cell.command('sftpSyncAI.activity.open'); await text('2/2 files');
      row.checks.push('installed bytes verified; real folder upload, grouped tree and exact remote bytes');
      await cell.command('notifications.clearAll'); await cell.command('notifications.hideList');
      row.themes = [];
      for (const [theme, name, kind] of [[dark.name, 'dark', 2], [light.name, 'light', 1]]) {
        await cell.probe({ op: 'activitySettings', theme });
        await waitFor(async () => (await cell.probe({ op: 'activityThemeKind' })) === kind, `active ${name} theme`);
        await sleep(400); row.themes.push({ name: theme, kind });
        await cell.cdp.screenshot(path.join(cell.root, `${name}.png`));
      }
      row.checks.push('light and dark native rendering captured');
      await cell.start('sftpSyncAI.activity.filter'); await text('Filter Activity');
      await cell.cdp.key('ArrowDown', 'ArrowDown', 40); await cell.cdp.key('Enter', 'Enter', 13); await sleep(250);
      await cell.command('sftpSyncAI.activity.open'); row.checks.push('keyboard-operated native filter');
      await cell.sandbox.seed('/conflict.txt', 'baseline\n');
      await cell.command('sftpSyncAI.download.file', [{ file: 'conflict.txt' }]);
      await cell.sandbox.seed('/conflict.txt', 'remote edit\n', new Date('2026-10-01T12:00:00Z'));
      await cell.probe({ op: 'save', file: 'conflict.txt', content: 'local edit\n' });
      await cell.command('notifications.clearAll'); await cell.command('workbench.action.closeAllEditors');
      const conflictJob = await cell.start('sftpSyncAI.upload.file', [{ file: 'conflict.txt' }]);
      await text('conflict'); await cell.command('sftpSyncAI.activity.open');
      assert.equal(await cell.cdp.evaluate(`!!document.querySelector('.quick-input-widget:not([style*="display: none"])')`), false);
      const stateRoot = path.join(cell.data, 'User', 'globalStorage', 'timorfiy.sftp-sync-ai', 'conflict-state-v2');
      async function records(dir) {
        const result = [];
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) result.push(...await records(full));
          else if (entry.name === 'conflict.json') result.push(JSON.parse(await fs.readFile(full)));
        }
        return result;
      }
      const conflict = await waitFor(async () => {
        const found = (await records(stateRoot)).find(record => path.basename(record.localFile) === 'conflict.txt' && record.status === 'pending');
        return found;
      }, 'pending conflict record');
      const pick = async label => {
        await cell.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
        await cell.cdp.pick(label);
      };
      const details = () => cell.start('sftpSyncAI.activity.details', [{ id: conflict.id, type: 'item', item: { conflict: { id: conflict.id } } }]);
      await details(); await text('Open Diff'); await cell.cdp.key('Escape', 'Escape', 27); await sleep(300);
      assert.equal((await records(stateRoot)).find(record => record.id === conflict.id).status, 'pending');
      assert.equal((await cell.sandbox.read('/conflict.txt')).toString(), 'remote edit\n');
      row.checks.push('conflict has no automatic picker; Escape retains pending state and remote bytes');
      await details(); await pick('Open Diff');
      await waitFor(async () => (await cell.probe({ op: 'tabs' })).some(tab => tab.type === 'textDiff'), 'native diff editor');
      await cell.probe({ op: 'captureClipboard' }); clipboardCaptured = true;
      await details(); await pick('Copy Agent Prompt');
      const prompt = await cell.probe({ op: 'agentPrompt' }); assert.equal(prompt.conflictId, conflict.id); assert(prompt.waitsForUploaded);
      await cell.probe({ op: 'restoreClipboard' }); clipboardCaptured = false;
      await details(); await pick('Cancel upload'); await cell.done(conflictJob);
      assert.equal((await cell.sandbox.read('/conflict.txt')).toString(), 'remote edit\n');
      row.checks.push('native diff, redacted-context agent prompt and explicit cancellation');
      await cell.command('sftpSyncAI.activity.open'); await cell.cdp.screenshot(path.join(cell.root, 'conflicts.png'));
      row.installedEntries = cell.verifiedEntries; row.status = 'PASS';
      console.log(`PASS ${editor} ${protocol}`);
    } catch (error) {
      row.status = 'FAIL'; row.error = error.message;
      if (cell.cdp) await cell.cdp.screenshot(path.join(cell.root, 'failure.png')).catch(() => {});
      throw error;
    } finally {
      if (clipboardCaptured) await cell.probe({ op: 'restoreClipboard' }).catch(() => {});
      await cell.close();
      await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    }
  }
  return report;
}
if (require.main === module) {
  const [bundle, root, code, cursor] = process.argv.slice(2);
  run(path.resolve(bundle), path.resolve(root), { vscode: code, cursor }).then(report => console.log(JSON.stringify({ rows: report.rows.length, artifactSha256: report.artifact.sha256 })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { run };
