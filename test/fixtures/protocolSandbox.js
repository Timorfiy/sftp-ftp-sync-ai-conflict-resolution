const fs = require('fs');
const os = require('os');
const path = require('path');

function normalizeRemote(remotePath) {
  const raw = String(remotePath || '').replace(/\\/g, '/');
  if (raw.split('/').includes('..')) {
    throw Object.assign(new Error('Path traversal is not allowed'), { code: 'EACCES' });
  }
  const normalized = path.posix.normalize(`/${raw}`);
  return normalized;
}

module.exports = async function createProtocolSandbox() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sftp-sync-protocol-'));
  const denied = new Set();
  const writeDenied = new Set();
  const disconnects = new Map();
  const operations = [];
  let connectionCount = 0;

  function resolve(remotePath) {
    const normalized = normalizeRemote(remotePath);
    const localPath = path.resolve(root, `.${normalized}`);
    const relative = path.relative(root, localPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw Object.assign(new Error('Path traversal is not allowed'), { code: 'EACCES' });
    }
    return { normalized, localPath };
  }

  function assertAllowed(remotePath) {
    const { normalized, localPath } = resolve(remotePath);
    for (const deniedPath of denied) {
      if (normalized === deniedPath || normalized.startsWith(`${deniedPath}/`)) {
        throw Object.assign(new Error(`Permission denied: ${normalized}`), { code: 'EACCES' });
      }
    }
    return localPath;
  }

  async function snapshot() {
    const entries = [];
    async function walk(localPath, remotePath) {
      const dirents = await fs.promises.readdir(localPath, { withFileTypes: true });
      for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
        const childLocal = path.join(localPath, dirent.name);
        const childRemote = path.posix.join(remotePath, dirent.name);
        if (dirent.isDirectory()) {
          entries.push({ path: childRemote, type: 'directory' });
          await walk(childLocal, childRemote);
        } else {
          entries.push({
            path: childRemote,
            type: 'file',
            content: (await fs.promises.readFile(childLocal)).toString('base64'),
          });
        }
      }
    }
    await walk(root, '/');
    return entries;
  }

  return {
    root,
    credentials: { username: 'test', password: 'test' },
    resolve,
    assertAllowed,
    assertWritable(remotePath) {
      const localPath = assertAllowed(remotePath);
      const { normalized } = resolve(remotePath);
      for (const deniedPath of writeDenied) {
        if (normalized === deniedPath || normalized.startsWith(`${deniedPath}/`)) {
          throw Object.assign(new Error(`Write permission denied: ${normalized}`), { code: 'EACCES' });
        }
      }
      return localPath;
    },
    noteConnection() {
      connectionCount += 1;
    },
    get connectionCount() {
      return connectionCount;
    },
    noteOperation(operation, target = '') {
      operations.push({ operation, target });
    },
    get operations() {
      return operations.slice();
    },
    clearOperations() {
      operations.length = 0;
    },
    snapshot,
    deny(remotePath) {
      denied.add(normalizeRemote(remotePath));
    },
    allow(remotePath) {
      denied.delete(normalizeRemote(remotePath));
    },
    denyWrite(remotePath) {
      writeDenied.add(normalizeRemote(remotePath));
    },
    allowWrite(remotePath) {
      writeDenied.delete(normalizeRemote(remotePath));
    },
    disconnect(operation, mode = 'once') {
      disconnects.set(operation, mode);
    },
    clearDisconnects() {
      disconnects.clear();
    },
    consumeDisconnect(operation) {
      const mode = disconnects.get(operation);
      if (!mode) return false;
      if (mode === 'once') disconnects.delete(operation);
      return true;
    },
    async seed(remotePath, content, mtime = new Date('2026-09-23T12:00:00.000Z')) {
      const localPath = assertAllowed(remotePath);
      await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
      await fs.promises.writeFile(localPath, content);
      await fs.promises.utimes(localPath, mtime, mtime);
    },
    async mkdir(remotePath) {
      await fs.promises.mkdir(assertAllowed(remotePath), { recursive: true });
    },
    async read(remotePath) {
      return fs.promises.readFile(assertAllowed(remotePath));
    },
    async stat(remotePath) {
      return fs.promises.stat(assertAllowed(remotePath));
    },
    async exists(remotePath) {
      try {
        await fs.promises.access(assertAllowed(remotePath));
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
};
