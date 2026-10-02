// Start the bundled router; project selection happens on each MCP tool call.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

function fail(message) {
  process.stderr.write(`SFTP Sync MCP: ${message}\n`);
  process.exitCode = 1;
}

function installedServer(extension) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'package.json'), 'utf8'));
    const server = path.join(extension, 'dist', 'mcp-server.js');
    if (manifest.publisher === 'Timorfiy' && manifest.name === 'sftp-sync-ai' &&
        manifest.contributes?.configuration?.properties?.['sftp.externalMcp.enable'] &&
        fs.statSync(server).isFile()) return { server, version: manifest.version };
  } catch { /* Ignore incomplete installations. */ }
}

function launch() {
  const directoryIndex = process.argv.indexOf('--external-directory');
  const explicitDirectory = directoryIndex >= 0 ? process.argv[directoryIndex + 1] : undefined;
  if (directoryIndex >= 0 && (!explicitDirectory || !path.isAbsolute(explicitDirectory))) {
    throw new Error('Pass an absolute path after --external-directory.');
  }
  const own = installedServer(path.resolve(__dirname, '..', '..'));
  let selected = own;
  // A copy in the client's private config can locate an installed extension.
  if (!selected) {
    const extensions = path.join(os.homedir(), '.cursor', 'extensions');
    const candidates = fs.readdirSync(extensions)
      .filter(name => name.startsWith('timorfiy.sftp-sync-ai-'))
      .map(name => installedServer(path.join(extensions, name))).filter(Boolean);
    candidates.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }));
    selected = candidates[0];
  }
  if (!selected) throw new Error('Install an SFTP Sync AI build with external MCP support.');
  const userData = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const registry = explicitDirectory || path.join(userData, 'Cursor', 'User', 'globalStorage', 'timorfiy.sftp-sync-ai', 'external-mcp');
  const args = [selected.server, '--external-directory', registry];
  const workspaceIndex = process.argv.indexOf('--workspace');
  if (workspaceIndex >= 0) {
    const workspace = process.argv[workspaceIndex + 1];
    if (!workspace || !path.isAbsolute(workspace)) throw new Error('Pass an absolute path after --workspace.');
    args.push('--workspace', workspace);
  }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.SFTP_SYNC_AI_MCP_CONFIG;
  const child = spawn(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
  child.on('error', () => fail('The bundled MCP server could not be started.'));
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
}

try { launch(); } catch (error) { fail(error.message); }
