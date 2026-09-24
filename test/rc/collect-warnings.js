const fs = require('node:fs/promises');
const path = require('node:path');
const { Journey } = require('./journey');
const { assertPublicEvidence } = require('./export-evidence');
const { sha256 } = require('./artifacts');

const categories = [
  ['editor-deprecation', /DEP0169|DEP0005|DeprecationWarning/, 'Editor/CLI dependency deprecation; installations and all assertions passed.'],
  ['optional-ssh-config', /ENOENT.*\.ssh.*config/, 'Empty isolated home has no optional SSH config; configured SFTP and saved credentials still passed.'],
  ['extension-root-lifecycle', /Can't find config for remote resource/, 'Extension Remote Explorer root lookup failed. A root may be lazy/uninitialized or retired; this message alone does not prove config replacement. Independent review reproduced both lifecycle paths as log-only, and separately reproduced a visible raw permission toast.'],
  ['generic-editor-error', /An unknown error occurred/, 'Generic renderer log entry: origin is not assigned from this message alone. Independent review observed no matching generic text in UI during two sampled existing clean journeys. This does not waive the separately reproduced raw Remote Explorer permission toast.'],
  ['windows-jump-list', /updateWindowsJumpList/, 'Editor integration with Windows jump list; no observed effect on tested extension behavior.'],
  ['cursor-fresh-state', /Missing property .*oldValue.*initValue/, 'Cursor initializes its own fresh-profile application settings; no personal profile was used.'],
];

function logRecords(text) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\d{4}-\d\d-\d\d[ T]|\[\d\d-\d\d \d\d:|\(node:\d+\).*DeprecationWarning/.test(line) || !records.length) {
      records.push(line);
    } else {
      records[records.length - 1] += `\n${line}`;
    }
  }
  return records;
}

function classifyWarning(record, log) {
  if (/read ENOTCONN/.test(record)) {
    if (/extensions[\\/]git[\\/]dist[\\/]main\.js/i.test(record)) {
      return ['editor-git-process', 'Stack identifies the editor-owned Git extension ChildProcess/getRepositoryRoot path. ENOTCONN is not evidence of a loopback FTP/SFTP fault; no product change is requested for this Git error.'];
    }
    return ['unattributed-connection-error', 'ENOTCONN has no recognized origin stack in this record. Do not infer fixture causality from the errno.'];
  }
  if (/sftp.*\.log$/i.test(log) && /Connection lost by fixture|426 Connection closed; transfer aborted/.test(record)) {
    return ['fixture-protocol-failure', 'Product diagnostic includes the deterministic loopback fixture failure text; distinct from editor Git errors. The corresponding transfer/failure scenario verifies the result and recovery.'];
  }
  const category = categories.find(([, pattern]) => pattern.test(record));
  return category ? [category[0], category[2]] : undefined;
}

async function files(root) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (file.endsWith('.log')) result.push(file);
  }
  return result;
}

async function collect(root, output) {
  const matrix = JSON.parse(await fs.readFile(path.join(root, 'matrix.json')));
  const warnings = [];
  for (const row of matrix.rows) {
    const cell = path.join(root, row.attempts.at(-1).directory);
    const sanitizer = new Journey(cell);
    const logs = [path.join(cell, 'install.log'), ...await files(path.join(cell, 'user-data/logs'))];
    const groups = new Map();
    for (const log of logs) {
      for (const record of logRecords(await fs.readFile(log, 'utf8'))) {
        const category = classifyWarning(record, log);
        if (!category) continue;
        const [id, impact] = category;
        const group = groups.get(id) || { id, impact, count: 0, samples: [] };
        group.count++;
        if (group.samples.length < 2) group.samples.push(sanitizer.sanitize({
          log: path.relative(cell, log).replace(/\\/g, '/'),
          line: record.split('\n')[0],
          originStack: record.split('\n').filter(line =>
            /extensions[\\/]git[\\/]dist[\\/]main\.js|ChildProcess|getRepositoryRoot/.test(line)
          ).slice(0, 4),
        }));
        groups.set(id, group);
      }
    }
    warnings.push({ row: row.id, groups: [...groups.values()] });
  }
  const text = JSON.stringify({ candidate: matrix.candidate,
    note: 'Selected runtime warnings; sample log timestamps are editor local time UTC+05. Raw logs remain private.',
    warnings,
  }, null, 2) + '\n';
  assertPublicEvidence(text);
  const file = path.join(output, 'runtime-warnings.json');
  await fs.writeFile(file, text, { flag: 'wx' });
  await fs.appendFile(path.join(output, 'SHA256SUMS'), `${sha256(Buffer.from(text))}  runtime-warnings.json\n`);
}

module.exports = { classifyWarning, logRecords };
if (require.main === module) collect(path.resolve(process.argv[2]), path.resolve(process.argv[3]))
  .catch(error => { console.error(error); process.exitCode = 1; });
