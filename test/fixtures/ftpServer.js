// Deterministic loopback FTP/FTPS fixture. Certificates are public test credentials.
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const createProtocolSandbox = require('./protocolSandbox');

function ftpDate(date) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function listLine(name, stat, includeTimestamp) {
  const kind = stat.isDirectory() ? 'd' : '-';
  const size = stat.isDirectory() ? 0 : stat.size;
  const modifiedAt = stat.mtime;
  const time = includeTimestamp
    ? `${String(modifiedAt.getUTCMonth() + 1).padStart(2, '0')}-${String(modifiedAt.getUTCDate()).padStart(2, '0')}-${modifiedAt.getUTCFullYear()} ${String(modifiedAt.getUTCHours()).padStart(2, '0')}:${String(modifiedAt.getUTCMinutes()).padStart(2, '0')}`
    : 'Jan 01 1970';
  return `${kind}rw-r--r-- 1 owner group ${size} ${time} ${name}\r\n`;
}

module.exports = async function startFTPServer({
  secure = false,
  pasvOnly = false,
  mdtm = true,
  sandbox: providedSandbox,
} = {}) {
  const sandbox = providedSandbox || await createProtocolSandbox();
  if (!(await sandbox.exists('/sample.txt'))) {
    await sandbox.seed('/sample.txt', Buffer.from('initial fixture data'));
  }
  const credentials = {
    key: fs.readFileSync(path.join(__dirname, 'ftp-test-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'ftp-test-cert.pem')),
  };
  const sockets = new Set();
  const servers = new Set();
  const peers = [];
  const sessions = new Set();

  function track(socket, kind) {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    peers.push({ kind, address: socket.remoteAddress });
  }

  async function listen(server) {
    servers.add(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
  }

  function statusFor(error) {
    if (error && error.code === 'EACCES') return '550 Permission denied';
    return '550 Path unavailable';
  }

  function onControl(initial) {
    sandbox.noteConnection();
    track(initial, 'control');
    let control = initial;
    let encrypted = secure === 'implicit';
    let buffer = '';
    let cwd = '/';
    let dataSocket;
    let renameFrom;
    const passiveServers = new Set();
    sessions.add(initial);

    function reply(message) {
      if (!control.destroyed) control.write(`${message}\r\n`);
    }

    function absolute(argument = '') {
      const candidate = argument.startsWith('/')
        ? argument
        : path.posix.join(cwd, argument || '.');
      return path.posix.normalize(candidate);
    }

    async function passive(command) {
      let connected;
      dataSocket = new Promise(resolve => { connected = resolve; });
      const handler = socket => {
        track(socket, 'data');
        connected(socket);
      };
      const server = encrypted ? tls.createServer(credentials, handler) : net.createServer(handler);
      passiveServers.add(server);
      const port = await listen(server);
      server.once('close', () => passiveServers.delete(server));
      reply(command === 'EPSV'
        ? `229 Entering Extended Passive Mode (|||${port}|)`
        : `227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`);
    }

    async function withData(operation, argument) {
      reply('150 Transfer starting');
      const data = await dataSocket;
      dataSocket = undefined;
      const remotePath = absolute(argument);
      const disconnect = operation !== 'upload' && sandbox.consumeDisconnect(operation);
      if (disconnect) {
        reply('426 Connection closed; transfer aborted');
        data.destroy();
        setImmediate(() => control.destroy());
        return;
      }
      try {
        if (operation === 'upload') {
          const chunks = [];
          const localPath = sandbox.assertAllowed(remotePath);
          await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
          const interruptUpload = sandbox.consumeDisconnect('upload');
          for await (const chunk of data) {
            if (interruptUpload) {
              await fs.promises.writeFile(localPath, chunk.subarray(0, Math.min(4, chunk.length)));
              reply('426 Connection closed; transfer aborted');
              data.destroy();
              setImmediate(() => control.destroy());
              return;
            }
            chunks.push(chunk);
          }
          await fs.promises.writeFile(localPath, Buffer.concat(chunks));
        } else if (operation === 'download') {
          data.end(await fs.promises.readFile(sandbox.assertAllowed(remotePath)));
          await new Promise(resolve => data.once('close', resolve));
        } else {
          const localPath = sandbox.assertAllowed(remotePath);
          const stat = await fs.promises.stat(localPath);
          const entries = stat.isDirectory()
            ? await fs.promises.readdir(localPath, { withFileTypes: true })
            : [{ name: path.basename(localPath) }];
          const lines = [];
          for (const entry of entries) {
            const entryPath = stat.isDirectory() ? path.join(localPath, entry.name) : localPath;
            lines.push(listLine(entry.name, await fs.promises.stat(entryPath), mdtm));
          }
          data.end(lines.join(''));
          await new Promise(resolve => data.once('close', resolve));
        }
        reply('226 Transfer complete');
      } catch (error) {
        data.destroy();
        reply(statusFor(error));
      } finally {
        for (const server of passiveServers) server.close();
      }
    }

    async function command(line) {
      const space = line.indexOf(' ');
      const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
      const argument = space < 0 ? '' : line.slice(space + 1);
      try {
        if (verb === 'AUTH') {
          reply('234 Proceed with TLS');
          control.removeListener('data', onData);
          control = new tls.TLSSocket(control, {
            isServer: true,
            secureContext: tls.createSecureContext(credentials),
          });
          control.on('error', () => {});
          encrypted = true;
          control.on('data', onData);
        } else if (verb === 'USER') {
          reply(argument === sandbox.credentials.username ? '331 Password required' : '530 Authentication failed');
        } else if (verb === 'PASS') {
          reply(argument === sandbox.credentials.password ? '230 Logged in' : '530 Authentication failed');
        } else if (verb === 'FEAT') {
          reply(`211-Features\r\n UTF8\r\n${mdtm ? ' MDTM\r\n' : ''} MFMT\r\n211 End`);
        } else if (verb === 'OPTS' || verb === 'TYPE' || verb === 'STRU' || verb === 'NOOP') {
          reply('200 OK');
        } else if (verb === 'PWD') {
          reply(`257 "${cwd}"`);
        } else if (verb === 'CWD') {
          const remotePath = absolute(argument);
          const stat = await fs.promises.stat(sandbox.assertAllowed(remotePath));
          if (!stat.isDirectory()) throw Object.assign(new Error('Not a directory'), { code: 'ENOENT' });
          cwd = remotePath;
          reply('250 Directory changed');
        } else if (verb === 'CDUP') {
          cwd = path.posix.dirname(cwd);
          reply('250 Directory changed');
        } else if (verb === 'EPSV' && pasvOnly) {
          reply('502 EPSV not supported');
        } else if (verb === 'EPSV' || verb === 'PASV') {
          await passive(verb);
        } else if (verb === 'STOR') {
          await withData('upload', argument);
        } else if (verb === 'RETR') {
          await withData('download', argument);
        } else if (verb === 'LIST' || verb === 'MLSD') {
          const target = argument.replace(/^-[^\s]+(?:\s+|$)/, '') || cwd;
          await withData('list', target);
        } else if (verb === 'SIZE') {
          const stat = await fs.promises.stat(sandbox.assertAllowed(absolute(argument)));
          reply(`213 ${stat.size}`);
        } else if (verb === 'MDTM') {
          if (!mdtm) return reply('502 MDTM not supported');
          const stat = await fs.promises.stat(sandbox.assertAllowed(absolute(argument)));
          reply(`213 ${ftpDate(stat.mtime)}`);
        } else if (verb === 'MFMT') {
          const [stamp, ...name] = argument.split(' ');
          const date = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`);
          const localPath = sandbox.assertAllowed(absolute(name.join(' ')));
          await fs.promises.utimes(localPath, date, date);
          reply(`213 Modify=${stamp}; ${name.join(' ')}`);
        } else if (verb === 'MKD') {
          await fs.promises.mkdir(sandbox.assertAllowed(absolute(argument)), { recursive: false });
          reply(`257 "${absolute(argument)}" created`);
        } else if (verb === 'DELE') {
          await fs.promises.unlink(sandbox.assertAllowed(absolute(argument)));
          reply('250 Deleted');
        } else if (verb === 'RMD') {
          await fs.promises.rmdir(sandbox.assertAllowed(absolute(argument)));
          reply('250 Removed');
        } else if (verb === 'RNFR') {
          renameFrom = absolute(argument);
          sandbox.assertAllowed(renameFrom);
          reply('350 Ready for destination');
        } else if (verb === 'RNTO') {
          await fs.promises.rename(
            sandbox.assertAllowed(renameFrom),
            sandbox.assertAllowed(absolute(argument))
          );
          renameFrom = undefined;
          reply('250 Renamed');
        } else if (verb === 'SITE') {
          reply('200 OK');
        } else if (verb === 'QUIT') {
          reply('221 Goodbye');
          control.end();
        } else {
          reply('502 Command not implemented');
        }
      } catch (error) {
        reply(statusFor(error));
      }
    }

    function onData(chunk) {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        command(line).catch(error => control.destroy(error));
      }
    }

    control.on('data', onData);
    control.once('close', () => sessions.delete(initial));
    reply('220 Local FTP test server');
  }

  const server = secure === 'implicit'
    ? tls.createServer(credentials, onControl)
    : net.createServer(onControl);
  const port = await listen(server);

  return {
    port,
    peers,
    sandbox,
    async disconnectClients() {
      await Promise.all([...sessions].map(socket => new Promise(resolve => {
        socket.once('close', resolve);
        socket.destroy();
      })));
    },
    close: async () => {
      sockets.forEach(socket => socket.destroy());
      sessions.forEach(socket => socket.destroy());
      await Promise.all([...servers].map(current => new Promise(resolve => {
        if (!current.listening) return resolve();
        current.close(resolve);
      })));
      if (!providedSandbox) await sandbox.close();
    },
  };
};
