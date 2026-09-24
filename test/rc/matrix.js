const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { waitFor } = require('./cdp');
const request = require('./control');
const pin = require('./candidate.json');
const { verifyCandidate, createPredecessor, verifyPredecessor } = require('./artifacts');

const cleanScenarios = [
  'installed', 'configuration', 'connection', 'first-transfer', 'primary-sync',
  'bulk-warning', 'manual-conflict', 'mcp-registration', 'agent-stale-upload',
  'agent-acknowledge-cancel', 'agent-upload-failure', 'backup-restore',
  'error-configuration', 'error-authentication', 'error-network', 'error-path',
  'error-permission', 'error-download', 'error-backup', 'state-isolation', 'bulk-partial-result',
  'explorer-error-recovery',
];
const updateScenarios = ['installed', 'configuration', 'connection', 'backup-restore', 'in-place-update'];

function assertRow(records, protocol, mode) {
  const required = [...(mode === 'update' ? updateScenarios : cleanScenarios),
    ...(protocol === 'ftp' ? ['ftp-warning-cancel'] : ['sftp-first-key']),
    ...(mode !== 'update' ? [protocol === 'ftp' ? 'ftp-timestamp-unavailable' : 'sftp-changed-key'] : []),
  ];
  assert(!records.some(record => record.status !== 'PASS'), 'A failed attempt cannot be signed');
  for (const id of required) {
    const found = records.filter(record => record.id === id);
    assert.equal(found.length, 1, `Expected exactly one successful scenario: ${id}`);
    assert.equal(found[0].candidateSha256, pin.sha256, 'Mixed candidate evidence');
    assert.equal(found[0].source, pin.source, 'Mixed source evidence');
  }
  return required;
}

async function execute(file, args, cwd, log) {
  const child = spawn(process.execPath, [file, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  let bytes = 0;
  const collect = chunk => {
    bytes += chunk.length;
    if (bytes < 2 * 1024 * 1024) output.push(chunk);
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const timer = setTimeout(() => child.kill(), 8 * 60 * 1000);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Scenario driver exited ${code ?? signal}`)));
    });
  } finally {
    clearTimeout(timer);
    await fs.writeFile(log, Buffer.concat(output));
  }
}

async function runMatrix({ bundle, root, vscode, cursor, resume = false }) {
  const file = path.join(root, 'matrix.json');
  const candidate = await verifyCandidate(bundle, pin);
  const predecessorFile = path.join(root, 'sftp-sync-ai-0.0.0.vsix');
  let matrix;
  if (resume) {
    matrix = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(matrix.candidate, pin, 'Resume refuses a different candidate');
    assert.deepEqual(await verifyPredecessor(candidate, predecessorFile), matrix.predecessor);
  } else {
    await fs.mkdir(root, { recursive: false });
    matrix = { schema: 1, candidate: pin, predecessor: await createPredecessor(candidate, predecessorFile),
      startedAt: new Date().toISOString(), rows: [] };
    for (const editor of ['vscode', 'cursor']) {
      for (const protocol of ['ftp', 'sftp']) {
        for (const mode of ['clean', 'update']) {
          matrix.rows.push({ id: `${editor}-${protocol}-${mode}`, editor, protocol, mode, status: 'PENDING', attempts: [] });
        }
      }
    }
    await fs.writeFile(file, JSON.stringify(matrix, null, 2));
  }
  for (const row of matrix.rows) {
    if (row.status === 'PASS') continue;
    const attempt = `${row.id}-${row.attempts.length + 1}`;
    const cellRoot = path.join(root, attempt);
    const controller = spawn(process.execPath, [path.join(__dirname, 'runner.js'),
      bundle, cellRoot, row.editor, row.protocol, row.editor === 'vscode' ? vscode : cursor, row.mode, predecessorFile,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const controllerOutput = [];
    controller.stdout.on('data', chunk => controllerOutput.push(chunk));
    controller.stderr.on('data', chunk => controllerOutput.push(chunk));
    row.status = 'RUNNING';
    const result = { directory: attempt, startedAt: new Date().toISOString(), status: 'RUNNING' };
    row.attempts.push(result);
    await fs.writeFile(file, JSON.stringify(matrix, null, 2));
    console.log(`RUN ${row.id}`);
    try {
      await waitFor(async () => {
        if (controller.exitCode !== null) throw new Error(`Controller failed ${controller.exitCode}`);
        try { await fs.access(path.join(cellRoot, 'control.json')); return true; } catch { return false; }
      }, 'isolated controller', 120000);
      const stages = row.mode === 'update' ? 'configure,connect,update' :
        'configure,connect,transfers,manual,agent,backups,errors,partialSync,explorerErrors';
      await execute(path.join(__dirname, 'journey.js'), [cellRoot, stages], process.cwd(), path.join(cellRoot, 'driver.log'));
      const records = (await fs.readFile(path.join(cellRoot, 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      result.scenarios = assertRow(records, row.protocol, row.mode);
      result.status = row.status = 'PASS';
      console.log(`PASS ${row.id}: ${result.scenarios.length} scenarios`);
    } catch (error) {
      result.status = row.status = 'FAIL';
      result.error = error.message;
      throw error;
    } finally {
      result.endedAt = new Date().toISOString();
      await fs.writeFile(file, JSON.stringify(matrix, null, 2));
      try { await request(cellRoot, { op: 'close' }); } catch {
        // A failed startup cleans itself up; preserve output and wait below.
      }
      await waitFor(() => controller.exitCode !== null, 'owned controller cleanup', 20000);
      await fs.writeFile(path.join(root, `${attempt}-controller.log`), Buffer.concat(controllerOutput));
    }
  }
  return matrix;
}

module.exports = { assertRow, cleanScenarios, updateScenarios, runMatrix };
if (require.main === module) {
  const [bundle, root, vscode, cursor, mode] = process.argv.slice(2);
  runMatrix({ bundle: path.resolve(bundle), root: path.resolve(root), vscode, cursor, resume: mode === '--resume' })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
