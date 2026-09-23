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
  const disconnects = new Map();
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

  return {
    root,
    credentials: { username: 'test', password: 'test' },
    resolve,
    assertAllowed,
    noteConnection() {
      connectionCount += 1;
    },
    get connectionCount() {
      return connectionCount;
    },
    deny(remotePath) {
      denied.add(normalizeRemote(remotePath));
    },
    allow(remotePath) {
      denied.delete(normalizeRemote(remotePath));
    },
    disconnect(operation, mode = 'once') {
      disconnects.set(operation, mode);
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
