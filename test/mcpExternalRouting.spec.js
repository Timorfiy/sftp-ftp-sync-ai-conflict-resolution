const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { publishExternalConnection } = require('../src/mcp/externalConnection');
const { workspaceBucketId } = require('../src/fileHandlers/transfer/conflictStateStore');

const result = value => value.structuredContent;

describe('external multi-window MCP routing from the packaged entry', () => {
  let root, client, transport;
  const sessions = [];
  const serverPath = path.join(__dirname, '..', 'dist', 'mcp-server.js');
  const conflictId = 'same-conflict-id';

  function project(name, withConflict = true) {
    const workspace = path.join(root, name);
    const bucket = workspaceBucketId(workspace);
    const stateRoot = path.join(root, `${name}-state`);
    const directory = path.join(stateRoot, 'workspaces', bucket, conflictId);
    const localFile = path.join(workspace, 'index.txt');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(localFile, name);
    const configuration = {
      version: 1, extensionVersion: '0.9.0-test', stateRoot,
      capability: `${randomUUID()}${randomUUID()}`,
      workspaces: [{ bucket, root: workspace, name }],
    };
    if (withConflict) {
      fs.mkdirSync(path.join(directory, 'requests'), { recursive: true });
      fs.mkdirSync(path.join(directory, 'responses'));
      const reportFile = path.join(directory, 'conflict.json');
      const remoteSnapshot = path.join(directory, 'remote.txt');
      fs.writeFileSync(remoteSnapshot, `remote-${name}`);
      fs.writeFileSync(reportFile, JSON.stringify({
        version: 2, id: conflictId, revision: 1, status: 'pending',
        sessionId: name, detectedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        workspaceRoot: workspace, localFile, remoteFile: '/index.txt', reportFile, remoteSnapshot,
        local: { mtime: 1, size: name.length, sha256: createHash('sha256').update(name).digest('hex') },
        remote: { mtime: 2, size: name.length + 7, sha256: null },
      }));
    }
    const session = publishExternalConnection(root, configuration, serverPath);
    sessions.push(session);
    return { configuration, bucket, workspace, directory, session };
  }

  async function connect(extra = []) {
    const env = { ...process.env };
    delete env.SFTP_SYNC_AI_MCP_CONFIG;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, '..', 'resources', 'mcp', 'launch.cjs'),
        '--external-directory', path.join(root, 'external-mcp'), ...extra],
      env, stderr: 'pipe',
    });
    client = new Client({ name: 'multi-project-agent', version: '1.0.0' });
    await client.connect(transport);
  }
  const call = async (name, args = {}) => result(await client.callTool({ name, arguments: args }));

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-routing-')); });
  afterEach(async () => {
    if (client) await client.close();
    else if (transport) await transport.close();
    client = transport = undefined;
    sessions.splice(0).forEach(session => session.dispose());
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('routes concurrent calls, refuses ambiguous selection, and discovers empty/new projects', async () => {
    const first = project('roomswidget');
    const second = project('domstroy');
    await connect();
    const listed = await call('conflicts_workspaces');
    expect(listed.workspaces.map(w => w.name).sort()).toEqual(['domstroy', 'roomswidget']);
    expect(JSON.stringify(listed)).not.toContain(first.configuration.capability);
    expect((await call('conflicts_list')).ok).toBe(false);
    const reads = await Promise.all([first, second].map(p => call('conflicts_read', {
      workspace: p.bucket, conflictId, side: 'local',
    })));
    expect(reads.map(read => read.content)).toEqual(['roomswidget', 'domstroy']);
    expect((await call('conflicts_list', { workspace: second.workspace })).conflicts[0].workspaceName).toBe('domstroy');
    const empty = project('empty', false);
    expect((await call('conflicts_workspaces')).workspaces).toHaveLength(3);
    expect((await call('conflicts_list', { workspace: empty.bucket })).conflicts).toEqual([]);
    first.session.dispose();
    expect((await call('conflicts_read', { workspace: first.bucket, conflictId, side: 'local' })).ok).toBe(false);
    expect((await call('conflicts_read', { workspace: second.bucket, conflictId, side: 'local' })).content).toBe('domstroy');
  });

  test('uses the selected live capability after reload and refuses duplicate windows', async () => {
    const first = project('roomswidget');
    const second = project('domstroy');
    await connect();
    first.session.dispose();
    const refreshed = { ...first.configuration, capability: `${randomUUID()}${randomUUID()}` };
    sessions.push(publishExternalConnection(root, refreshed, serverPath));
    const cancel = call('conflicts_resolve', { workspace: first.bucket, conflictId, expectedRevision: 1, action: 'cancel' });
    const deadline = Date.now() + 5000;
    let request;
    while (!request && Date.now() < deadline) {
      const names = fs.readdirSync(path.join(first.directory, 'requests'));
      const name = names.find(n => n.endsWith('.json'));
      if (name) request = JSON.parse(fs.readFileSync(path.join(first.directory, 'requests', name), 'utf8'));
      else await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(request.capability).toBe(refreshed.capability);
    expect(fs.readdirSync(path.join(second.directory, 'requests'))).toEqual([]);
    fs.writeFileSync(path.join(first.directory, 'responses', `${request.requestId}.json`), JSON.stringify({
      version: 3, requestId: request.requestId, conflictId, revision: 2,
      status: 'cancelled', accepted: true, respondedAt: new Date().toISOString(),
    }));
    expect((await cancel).status).toBe('cancelled');
    sessions.push(publishExternalConnection(root, refreshed, serverPath));
    expect((await call('conflicts_get', { workspace: first.bucket, conflictId })).ok).toBe(false);
  });

  test('pins an explicit project and never falls back to another open project', async () => {
    const first = project('roomswidget');
    const second = project('domstroy');
    await connect(['--workspace', first.workspace]);
    expect((await call('conflicts_workspaces')).workspaces.map(w => w.name)).toEqual(['roomswidget']);
    expect((await call('conflicts_list')).conflicts[0].workspaceName).toBe('roomswidget');
    expect((await call('conflicts_read', { workspace: second.bucket, conflictId, side: 'local' })).ok).toBe(false);
    first.session.dispose();
    expect((await call('conflicts_list')).ok).toBe(false);
  });

  test('starts before any editor session exists and connects when a project appears', async () => {
    await connect();
    expect((await call('conflicts_workspaces')).ok).toBe(false);
    const first = project('domstroy', false);
    expect((await call('conflicts_workspaces')).workspaces[0].root).toBe(first.workspace);
    expect((await call('conflicts_list', { workspace: path.join(root, 'unopened') })).ok).toBe(false);
    expect((await call('conflicts_list', { workspace: first.bucket })).conflicts).toEqual([]);
  });
});
