import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { localPathKey } from '../helper/localPaths';
import { McpLaunchConfiguration, mcpLaunchConfigurationSchema } from './conflictContract';

const MAX_AGE_MS = 45_000;
const MAX_BYTES = 128 * 1024;

interface Connection {
  version: 1;
  processId: number;
  updatedAt: number;
  serverPath: string;
  configuration: McpLaunchConfiguration;
}

function key(value: string): string {
  return localPathKey(value);
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Opt-in, local-user-only discovery. Never put session capabilities in a project. */
export function publishExternalConnection(
  globalStorage: string,
  configuration: McpLaunchConfiguration,
  serverPath: string
): { dispose(): void } {
  const directory = path.join(globalStorage, 'external-mcp');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('External MCP storage must not be a link.');
  const filename = path.join(directory, `${process.pid}-${randomUUID()}.json`);
  const write = () => {
    const value: Connection = { version: 1, processId: process.pid, updatedAt: Date.now(), serverPath, configuration };
    const temporary = `${filename}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    try { fs.renameSync(temporary, filename); }
    finally { fs.rmSync(temporary, { force: true }); }
  };
  write();
  let disposed = false;
  const timer = setInterval(() => {
    try { write(); } catch { dispose(); }
  }, 10_000);
  timer.unref();
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    try { fs.rmSync(filename, { force: true }); } catch { /* Expiry revokes an undeletable record. */ }
  }
  return { dispose };
}

/** Refreshed for every MCP call so an editor reload cannot retain old authority. */
export function listExternalConnections(directory: string): Connection[] {
  if (!fs.existsSync(directory)) throw new Error('No external SFTP MCP connection. Enable sftp.externalMcp.enable in the editor and reload its window.');
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('External MCP storage must not be a link.');
  const found: Connection[] = [];
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const filename = path.join(directory, name);
    try {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) continue;
      const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as Connection;
      if (value.version !== 1 || !Number.isFinite(value.updatedAt) || value.updatedAt > Date.now() + 5_000 || Date.now() - value.updatedAt > MAX_AGE_MS || !alive(value.processId)) continue;
      value.configuration = mcpLaunchConfigurationSchema.parse(value.configuration);
      if (!path.isAbsolute(value.serverPath) || !fs.statSync(value.serverPath).isFile()) continue;
      found.push(value);
    } catch { /* Incomplete or invalid sessions never grant access. */ }
  }
  return found;
}

/** Never infer another project when the caller explicitly selects a workspace. */
export function discoverExternalConnection(directory: string, workspace?: string): Connection {
  const found = listExternalConnections(directory);
  const candidates = workspace
    ? found.filter(value => value.configuration.workspaces.some(w => w.bucket === workspace || key(w.root) === key(workspace)))
    : found;
  if (candidates.length !== 1) throw new Error(candidates.length
    ? 'Multiple SFTP editor sessions. Call conflicts_workspaces and pass workspace explicitly.'
    : 'No live external SFTP MCP session for this workspace. Open the project in the editor.');
  const selected = candidates[0];
  const workspaces = workspace
    ? selected.configuration.workspaces.filter(w => w.bucket === workspace || key(w.root) === key(workspace))
    : selected.configuration.workspaces;
  if (!workspace && workspaces.length !== 1) throw new Error('Multiple SFTP workspaces. Call conflicts_workspaces and pass workspace explicitly.');
  return { ...selected, configuration: { ...selected.configuration, workspaces } };
}
