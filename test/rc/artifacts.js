// RC qualification helpers never build or alter the candidate.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const yauzl = require('yauzl');
const yazl = require('yazl');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function readArchive(file) {
  const entries = new Map();
  let total = 0;
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const fail = error => { zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('entry', entry => {
        const name = entry.fileName;
        if (entries.has(name) || /(^\/|\\|(^|\/)\.\.(\/|$))/.test(name)) {
          return fail(new Error('Unsafe or duplicate archive entry'));
        }
        total += entry.uncompressedSize;
        if (total > 50 * 1024 * 1024 || entries.size >= 1000) {
          return fail(new Error('QA archive budget exceeded'));
        }
        if (name.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            entries.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(entries));
      zip.readEntry();
    });
  });
}

async function writeArchive(file, entries) {
  const zip = new yazl.ZipFile();
  for (const [name, content] of entries) {
    zip.addBuffer(content, name, { mtime: new Date('2026-01-01T00:00:00Z'), mode: 0o100644 });
  }
  const output = pipeline(zip.outputStream, createWriteStream(file, { flags: 'wx' }));
  zip.end();
  await output;
}

async function verifyCandidate(bundle, pin) {
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  assert.match(pin.source, /^[a-f0-9]{40}$/);
  const file = path.join(bundle, pin.file);
  assert.equal(path.basename(pin.file), pin.file, 'Candidate filename must be a basename');
  const bytes = await fs.readFile(file);
  assert.equal(sha256(bytes), pin.sha256, 'Canonical candidate checksum mismatch');
  assert.equal(bytes.length, pin.bytes, 'Canonical candidate size mismatch');
  const provenance = JSON.parse(await fs.readFile(path.join(bundle, 'provenance.json')));
  assert.equal(provenance.sourceSha, pin.source, 'Candidate source mismatch');
  const entries = await readArchive(file);
  const manifest = JSON.parse(entries.get('extension/package.json'));
  assert.equal(`${manifest.publisher}.${manifest.name}`, 'Timorfiy.sftp-sync-ai');
  assert.equal(manifest.version, '0.1.0');
  return { file, entries, manifest };
}

function predecessorEntries(candidate) {
  const entries = new Map(candidate.entries);
  const before = entries.get('extension/package.json').toString();
  const manifest = JSON.parse(before);
  assert.equal(manifest.version, '0.1.0');
  // Only replace the top-level version token, preserving every other byte.
  const after = before.replace(/("version"\s*:\s*)"0\.1\.0"/, '$1"0.0.0"');
  assert.notEqual(before, after);
  const parsed = JSON.parse(after);
  assert.deepEqual({ ...parsed, version: '0.1.0' }, manifest);
  entries.set('extension/package.json', Buffer.from(after));
  const xml = entries.get('extension.vsixmanifest').toString();
  const identity = /(<Identity\b[^>]*\bVersion=)"0\.1\.0"/;
  assert.match(xml, identity);
  entries.set('extension.vsixmanifest', Buffer.from(xml.replace(identity, '$1"0.0.0"')));
  return entries;
}

async function verifyPredecessor(candidate, output) {
  const expected = predecessorEntries(candidate);
  const actual = await readArchive(output);
  assert.equal(actual.size, expected.size, 'Unexpected predecessor archive entries');
  for (const [name, bytes] of expected) {
    assert(bytes.equals(actual.get(name)), `Predecessor recipe mismatch: ${name}`);
  }
  const changed = [...candidate.entries].filter(([name, bytes]) => !bytes.equals(actual.get(name))).map(([name]) => name);
  assert.deepEqual(changed.sort(), ['extension.vsixmanifest', 'extension/package.json']);
  const bytes = await fs.readFile(output);
  return { file: path.basename(output), sha256: sha256(bytes), bytes: bytes.length, changed };
}

async function createPredecessor(candidate, output) {
  const entries = predecessorEntries(candidate);
  await writeArchive(output, entries);
  return verifyPredecessor(candidate, output);
}

async function verifyInstalled(candidate, directory) {
  const checked = [];
  for (const [name, bytes] of candidate.entries) {
    if (!name.startsWith('extension/')) continue;
    const relative = name.slice('extension/'.length);
    const installed = await fs.readFile(path.join(directory, relative));
    if (relative === 'package.json') {
      // Editors add installation metadata, not runtime code.
      const parsed = JSON.parse(installed);
      delete parsed.__metadata;
      assert.deepEqual(parsed, JSON.parse(bytes), 'Installed manifest mismatch');
    } else {
      assert.equal(sha256(installed), sha256(bytes), `Installed bytes differ: ${relative}`);
    }
    checked.push(relative);
  }
  return checked;
}

module.exports = { sha256, readArchive, writeArchive, verifyCandidate, createPredecessor, verifyPredecessor, verifyInstalled };
