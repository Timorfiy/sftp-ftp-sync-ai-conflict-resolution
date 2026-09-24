const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { sha256 } = require('./artifacts');
const { assertRow } = require('./matrix');
const pin = require('./candidate.json');

function assertPublicEvidence(text) {
  assert(!/[A-Z]:[\\/]+Users[\\/]+|[A-Z]:\\\\Users\\\\|(?:^|[\s"'(]|file:\/\/)\/(?:home|Users)\/[^/<\s]+/i.test(text), 'Personal absolute path in evidence');
  assert(!/-----BEGIN [^-]*PRIVATE KEY|SFTP_SYNC_AI_MCP_CONFIG|"token"\s*:|"capability"\s*:/i.test(text), 'Private capability/key in evidence');
  assert(!/"password"\s*:\s*"[^"]+|"passphrase"\s*:\s*"[^"]+/i.test(text), 'Credential value in evidence');
}

async function exportEvidence(root, output) {
  const matrix = JSON.parse(await fs.readFile(path.join(root, 'matrix.json'), 'utf8'));
  assert.deepEqual(matrix.candidate, pin);
  assert.equal(matrix.rows.length, 8);
  assert.deepEqual(matrix.rows.map(row => row.id).sort(),
    ['vscode', 'cursor'].flatMap(editor => ['ftp', 'sftp'].flatMap(protocol =>
      ['clean', 'update'].map(mode => `${editor}-${protocol}-${mode}`))).sort(), 'Unexpected or duplicate matrix rows');
  assert(matrix.rows.every(row => row.status === 'PASS'), 'Do not sign an incomplete matrix');
  try { await fs.mkdir(output, { recursive: false }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert.deepEqual(await fs.readdir(output), [], 'Evidence output must be new or empty');
  }
  const hashes = {};
  const rows = [];
  for (const row of matrix.rows) {
    const attempt = row.attempts.at(-1);
    assert.equal(attempt.status, 'PASS');
    assert.equal(path.basename(attempt.directory), attempt.directory, 'Evidence attempt must remain within matrix root');
    const records = (await fs.readFile(path.join(root, attempt.directory, 'observations.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line));
    const scenarios = assertRow(records, row.protocol, row.mode);
    const text = JSON.stringify({ row: row.id, records }, null, 2) + '\n';
    assertPublicEvidence(text);
    const file = `${row.id}.json`;
    await fs.writeFile(path.join(output, file), text, { flag: 'wx' });
    hashes[file] = sha256(Buffer.from(text));
    rows.push({
      id: row.id, status: 'PASS', scenarios, evidence: file,
      startedAt: attempt.startedAt, endedAt: attempt.endedAt,
      earlierAttempts: row.attempts.slice(0, -1).map(({ status, startedAt, endedAt, error }) =>
        ({ status, startedAt, endedAt, error })),
    });
  }
  const summary = {
    candidate: pin, predecessor: matrix.predecessor,
    operator: 'gpt-6-astra implementation agent', signedAt: new Date().toISOString(),
    scope: 'Windows installed editor / native UI / loopback FTP+SFTP / scripted MCP, no publication',
    humanUsability: 'NOT RUN: owner deferred until before first publication (2026-09-24)',
    rows,
  };
  const text = JSON.stringify(summary, null, 2) + '\n';
  assertPublicEvidence(text);
  await fs.writeFile(path.join(output, 'matrix.json'), text, { flag: 'wx' });
  hashes['matrix.json'] = sha256(Buffer.from(text));
  await fs.writeFile(path.join(output, 'SHA256SUMS'), Object.entries(hashes)
    .map(([file, hash]) => `${hash}  ${file}\n`).join(''), { flag: 'wx' });
  return summary;
}

module.exports = { assertPublicEvidence, exportEvidence };
if (require.main === module) {
  exportEvidence(path.resolve(process.argv[2]), path.resolve(process.argv[3]))
    .then(result => console.log(`Exported ${result.rows.length} verified rows; review evidence before accepting signature.`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
