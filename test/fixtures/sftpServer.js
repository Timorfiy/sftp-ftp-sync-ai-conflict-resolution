const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server, utils } = require('ssh2');
const createProtocolSandbox = require('./protocolSandbox');

const { OPEN_MODE, STATUS_CODE, flagsToString } = utils.sftp;
let runtimeHostKey;

function getRuntimeHostKey() {
  if (!runtimeHostKey) {
    runtimeHostKey = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: {
        type: 'sec1',
        format: 'pem',
      },
    }).privateKey;
  }
  return runtimeHostKey;
}

function attrs(stat) {
  return {
    mode: stat.mode,
    uid: 0,
    gid: 0,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  };
}

module.exports = async function startSFTPServer({
  sandbox: providedSandbox,
  hostKey: providedHostKey,
  onSandboxCreated,
} = {}) {
  const sandbox = providedSandbox || await createProtocolSandbox();
  const clients = new Set();
  const streams = new Set();
  const openFiles = new Set();
  let server;
  let listening = false;

  function disconnectClient(client) {
    if (client._sock && !client._sock.destroyed) {
      client._sock.destroy();
    } else {
      client.end();
    }
  }

  async function closeOpenFiles() {
    await Promise.all([...openFiles].map(async fd => {
      openFiles.delete(fd);
      await fd.close().catch(() => {});
    }));
  }

  async function cleanup() {
    streams.forEach(stream => stream.end());
    const serverClosed = server && listening
      ? new Promise(resolve => server.close(resolve))
      : Promise.resolve();
    listening = false;
    clients.forEach(disconnectClient);
    if (server?._srv && typeof server._srv.closeAllConnections === 'function') {
      server._srv.closeAllConnections();
    }
    await closeOpenFiles();
    await serverClosed;
    if (!providedSandbox) {
      await sandbox.close();
    }
  }

  try {
    if (onSandboxCreated) {
      onSandboxCreated(sandbox);
    }
    if (!(await sandbox.exists('/sample.txt'))) {
      await sandbox.seed('/sample.txt', Buffer.from('initial fixture data'));
    }
    const hostKey = providedHostKey || getRuntimeHostKey();

    server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    sandbox.noteConnection();
    client.on('error', () => {});
    client.once('close', () => clients.delete(client));
    client.on('authentication', context => {
      sandbox.noteOperation('AUTH', context.method);
      if (
        context.method === 'password' &&
        context.username === sandbox.credentials.username &&
        context.password === sandbox.credentials.password
      ) {
        context.accept();
      } else {
        context.reject();
      }
    });
    client.on('ready', () => {
      client.on('session', acceptSession => {
        const session = acceptSession();
        session.on('sftp', acceptSftp => {
          const sftp = acceptSftp();
          streams.add(sftp);
          // Pending request cleanup during an injected channel disconnect can
          // surface on the SFTP stream itself in addition to the per-file
          // stream. Keep the fixture deterministic by observing that error.
          sftp.on('error', () => {});
          const handles = new Map();
          let nextHandle = 1;

          sftp.once('close', () => {
            streams.delete(sftp);
            for (const opened of handles.values()) {
              if (opened.fd) {
                openFiles.delete(opened.fd);
                opened.fd.close().catch(() => {});
              }
            }
            handles.clear();
          });

          function status(reqid, error) {
            const code = error && error.code === 'EACCES'
              ? STATUS_CODE.PERMISSION_DENIED
              : error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
                ? STATUS_CODE.NO_SUCH_FILE
                : STATUS_CODE.FAILURE;
            sftp.status(reqid, code, error ? error.message : undefined);
          }

          function createHandle(value) {
            const id = nextHandle++;
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(id, 0);
            handles.set(id, value);
            return handle;
          }

          function lookup(handle) {
            if (!Buffer.isBuffer(handle) || handle.length !== 4) return undefined;
            return handles.get(handle.readUInt32BE(0));
          }

          async function applyAttrs(localPath, values) {
            if (values.mode !== undefined) await fs.promises.chmod(localPath, values.mode);
            if (values.atime !== undefined || values.mtime !== undefined) {
              const stat = await fs.promises.stat(localPath);
              await fs.promises.utimes(
                localPath,
                values.atime === undefined ? stat.atime : values.atime,
                values.mtime === undefined ? stat.mtime : values.mtime
              );
            }
          }

          sftp.on('REALPATH', (reqid, remotePath) => {
            sandbox.noteOperation('REALPATH', remotePath);
            try {
              const normalized = sandbox.resolve(remotePath).normalized;
              sftp.name(reqid, [{ filename: normalized, longname: normalized, attrs: {} }]);
            } catch (error) {
              status(reqid, error);
            }
          });

          for (const event of ['LSTAT', 'STAT']) {
            sftp.on(event, async (reqid, remotePath) => {
              sandbox.noteOperation(event, remotePath);
              try {
                sftp.attrs(reqid, attrs(await fs.promises.stat(sandbox.assertAllowed(remotePath))));
              } catch (error) {
                status(reqid, error);
              }
            });
          }

          sftp.on('OPENDIR', async (reqid, remotePath) => {
            sandbox.noteOperation('OPENDIR', remotePath);
            try {
              if (sandbox.consumeDisconnect('list')) {
                sftp.status(reqid, STATUS_CODE.FAILURE, 'Connection lost by fixture');
                disconnectClient(client);
                return;
              }
              const localPath = sandbox.assertAllowed(remotePath);
              const stat = await fs.promises.stat(localPath);
              if (!stat.isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' });
              sftp.handle(reqid, createHandle({ type: 'dir', localPath, sent: false }));
            } catch (error) {
              status(reqid, error);
            }
          });

          sftp.on('READDIR', async (reqid, handle) => {
            sandbox.noteOperation('READDIR');
            const opened = lookup(handle);
            if (!opened || opened.type !== 'dir') return status(reqid);
            if (opened.sent) return sftp.status(reqid, STATUS_CODE.EOF);
            try {
              opened.sent = true;
              const entries = await fs.promises.readdir(opened.localPath);
              const names = await Promise.all(entries.map(async filename => {
                const stat = await fs.promises.stat(path.join(opened.localPath, filename));
                return { filename, longname: filename, attrs: attrs(stat) };
              }));
              sftp.name(reqid, names);
            } catch (error) {
              status(reqid, error);
            }
          });

          sftp.on('OPEN', async (reqid, remotePath, flags, openAttrs) => {
            sandbox.noteOperation(flags & OPEN_MODE.WRITE ? 'OPEN_WRITE' : 'OPEN_READ', remotePath);
            try {
              const operation = flags & OPEN_MODE.WRITE ? 'upload' : 'download';
              const injectDisconnect =
                operation === 'download' && sandbox.consumeDisconnect(operation);
              if (injectDisconnect) {
                sftp.status(reqid, STATUS_CODE.FAILURE, 'Connection lost by fixture');
                return;
              }
              const localPath = sandbox.assertAllowed(remotePath);
              if (flags & OPEN_MODE.CREAT) {
                await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
              }
              const flag = flagsToString(flags) || (flags & OPEN_MODE.WRITE ? 'w' : 'r');
              const fd = await fs.promises.open(localPath, flag, openAttrs.mode);
              openFiles.add(fd);
              sftp.handle(reqid, createHandle({ type: 'file', fd, localPath }));
            } catch (error) {
              status(reqid, error);
            }
          });

          sftp.on('READ', async (reqid, handle, offset, length) => {
            const opened = lookup(handle);
            if (!opened || opened.type !== 'file') return status(reqid);
            try {
              const buffer = Buffer.alloc(length);
              const result = await opened.fd.read(buffer, 0, length, offset);
              if (!result.bytesRead) return sftp.status(reqid, STATUS_CODE.EOF);
              sftp.data(reqid, buffer.subarray(0, result.bytesRead));
            } catch (error) {
              status(reqid, error);
            }
          });

          sftp.on('WRITE', async (reqid, handle, offset, data) => {
            sandbox.noteOperation('WRITE');
            const opened = lookup(handle);
            if (!opened || opened.type !== 'file') return status(reqid);
            try {
              if (sandbox.consumeDisconnect('upload')) {
                const partial = data.subarray(0, Math.min(4, data.length));
                await opened.fd.write(partial, 0, partial.length, offset);
                client.end();
                return;
              }
              await opened.fd.write(data, 0, data.length, offset);
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (error) {
              status(reqid, error);
            }
          });

          sftp.on('FSTAT', async (reqid, handle) => {
            const opened = lookup(handle);
            if (!opened || opened.type !== 'file') return status(reqid);
            try {
              sftp.attrs(reqid, attrs(await opened.fd.stat()));
            } catch (error) {
              status(reqid, error);
            }
          });

          sftp.on('FSETSTAT', async (reqid, handle, values) => {
            sandbox.noteOperation('FSETSTAT');
            const opened = lookup(handle);
            if (!opened || opened.type !== 'file') return status(reqid);
            try {
              await applyAttrs(opened.localPath, values);
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (error) {
              status(reqid, error);
            }
          });

          sftp.on('CLOSE', async (reqid, handle) => {
            const id = Buffer.isBuffer(handle) && handle.length === 4 ? handle.readUInt32BE(0) : -1;
            const opened = handles.get(id);
            if (!opened) return status(reqid);
            handles.delete(id);
            try {
              if (opened.fd) {
                openFiles.delete(opened.fd);
                await opened.fd.close();
              }
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (error) {
              status(reqid, error);
            }
          });

          sftp.on('SETSTAT', async (reqid, remotePath, values) => {
            sandbox.noteOperation('SETSTAT', remotePath);
            try {
              await applyAttrs(sandbox.assertAllowed(remotePath), values);
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (error) {
              status(reqid, error);
            }
          });

          const simple = (event, operation) => {
            sftp.on(event, async (reqid, ...args) => {
              sandbox.noteOperation(event, args[0]);
              try {
                await operation(...args);
                sftp.status(reqid, STATUS_CODE.OK);
              } catch (error) {
                status(reqid, error);
              }
            });
          };
          simple('MKDIR', remotePath => fs.promises.mkdir(sandbox.assertAllowed(remotePath)));
          simple('REMOVE', remotePath => fs.promises.unlink(sandbox.assertAllowed(remotePath)));
          simple('RMDIR', remotePath => fs.promises.rmdir(sandbox.assertAllowed(remotePath)));
          simple('RENAME', (from, to) => fs.promises.rename(
            sandbox.assertAllowed(from),
            sandbox.assertAllowed(to)
          ));
          sftp.on('EXTENDED', async (reqid, extension, ...args) => {
            sandbox.noteOperation(`EXTENDED:${extension}`, args[0]);
            if (extension !== 'posix-rename@openssh.com') {
              return sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED);
            }
            try {
              await fs.promises.rename(
                sandbox.assertAllowed(args[0]),
                sandbox.assertAllowed(args[1])
              );
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (error) {
              status(reqid, error);
            }
          });
        });
      });
    });
    });
    server.on('error', () => {});
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    listening = true;

    return {
      port: server.address().port,
      sandbox,
      get activeConnections() {
        return clients.size;
      },
      async disconnectClients() {
        await Promise.all([...clients].map(client => new Promise(resolve => {
          client.once('close', resolve);
          client.end();
        })));
      },
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
};
