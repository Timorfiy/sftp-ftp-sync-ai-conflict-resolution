// Local-only FTP/FTPS fixture. Certificates here are public test credentials.
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

module.exports = async function startFTPServer({ secure = false, pasvOnly = false } = {}) {
  const credentials = {
    key: fs.readFileSync(path.join(__dirname, 'ftp-test-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'ftp-test-cert.pem')),
  };
  const sockets = new Set();
  const servers = new Set();
  const peers = [];
  let payload = Buffer.from('initial fixture data');
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
  function onControl(initial) {
    track(initial, 'control');
    let control = initial;
    let encrypted = secure === 'implicit';
    let buffer = '';
    let dataSocket;
    function reply(message) { control.write(message + '\r\n'); }
    async function passive(command) {
      let connected;
      dataSocket = new Promise(resolve => { connected = resolve; });
      const handler = socket => { track(socket, 'data'); connected(socket); };
      const server = encrypted ? tls.createServer(credentials, handler) : net.createServer(handler);
      const port = await listen(server);
      reply(command === 'EPSV' ? `229 Entering Extended Passive Mode (|||${port}|)` :
        `227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`);
    }
    async function command(line) {
      const verb = line.split(' ')[0];
      if (verb === 'AUTH') {
        reply('234 Proceed with TLS');
        control.removeListener('data', onData);
        control = new tls.TLSSocket(control, { isServer: true, secureContext: tls.createSecureContext(credentials) });
        control.on('error', () => {});
        encrypted = true;
        control.on('data', onData);
      } else if (verb === 'USER') reply('331 Password required');
      else if (verb === 'PASS') reply('230 Logged in');
      else if (verb === 'FEAT') reply('211 No additional features');
      else if (verb === 'PWD') reply('257 "/"');
      else if (verb === 'EPSV' && pasvOnly) reply('502 EPSV not supported');
      else if (verb === 'EPSV' || verb === 'PASV') await passive(verb);
      else if (['STOR', 'RETR', 'LIST'].includes(verb)) {
        reply('150 Transfer starting');
        const data = await dataSocket;
        if (verb === 'STOR') {
          const chunks = [];
          data.on('data', chunk => chunks.push(chunk));
          data.once('end', () => { payload = Buffer.concat(chunks); reply('226 Transfer complete'); });
        } else {
          data.end(verb === 'LIST' ? '-rw-r--r-- 1 owner group 42 Jan 01 2026 sample.txt\r\n' : payload);
          data.once('close', () => reply('226 Transfer complete'));
        }
      } else if (verb === 'QUIT') { reply('221 Goodbye'); control.end(); }
      else reply('200 OK');
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
    reply('220 Local FTP test server');
  }
  const server = secure === 'implicit' ? tls.createServer(credentials, onControl) : net.createServer(onControl);
  const port = await listen(server);
  return {
    port, peers,
    close: async () => {
      sockets.forEach(socket => socket.destroy());
      await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
    },
  };
};
