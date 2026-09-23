const { createHash, randomUUID } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { workspaceBucketId } = require('../src/fileHandlers/transfer/conflictStateStore');
const {
  MCP_CONFIG_ENV,
} = require('../src/mcp/conflictContract');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function structured(result) {
  if (!result.structuredContent) {
    throw new Error(`Expected structured MCP result: ${JSON.stringify(result)}`);
  }
  return result.structuredContent;
}

describe('bundled stdio MCP server', () => {
  let tempRoot;
  let transport;
  let client;

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => {});
    } else if (transport) {
      await transport.close().catch(() => {});
    }
    if (tempRoot) {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('initializes with instructions and serves the canonical tools from dist', async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sftp-sync-mcp-stdio-'));
    const workspace = path.join(tempRoot, 'workspace');
    const stateRoot = path.join(tempRoot, 'global', 'conflict-state-v2');
    const bucket = workspaceBucketId(workspace);
    const conflictId = '2026-09-23T12-00-00-000Z-stdio-index.txt';
    const directory = path.join(stateRoot, 'workspaces', bucket, conflictId);
    const localFile = path.join(workspace, 'index.txt');
    const remoteSnapshot = path.join(directory, 'remote.txt');
    const reportFile = path.join(directory, 'conflict.json');
    await fs.promises.mkdir(workspace, { recursive: true });
    await fs.promises.mkdir(path.join(directory, 'requests'), { recursive: true });
    await fs.promises.mkdir(path.join(directory, 'responses'), { recursive: true });
    await fs.promises.writeFile(localFile, 'local');
    await fs.promises.writeFile(remoteSnapshot, 'remote');
    await fs.promises.writeFile(
      reportFile,
      JSON.stringify({
        version: 2,
        id: conflictId,
        revision: 1,
        status: 'pending',
        reason: 'remote-changed',
        detectedAt: '2026-09-23T12:00:00.000Z',
        updatedAt: '2026-09-23T12:00:00.000Z',
        sessionId: 'stdio-test',
        workspaceRoot: workspace,
        batchId: 'batch',
        localFile,
        remoteFile: '/index.txt',
        reportFile,
        remoteSnapshot,
        localSnapshot: null,
        local: { mtime: 1, size: 5, sha256: sha256('local') },
        remote: { mtime: 2, size: 6, sha256: sha256('remote') },
        baseline: null,
      })
    );
    const configuration = {
      version: 1,
      extensionVersion: '0.1.0-test',
      stateRoot,
      capability: `${randomUUID()}${randomUUID()}`,
      workspaces: [{ bucket, root: workspace, name: 'Stdio Fixture' }],
    };

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(__dirname, '..', 'dist', 'mcp-server.js')],
      env: {
        ...process.env,
        [MCP_CONFIG_ENV]: JSON.stringify(configuration),
      },
      stderr: 'pipe',
    });
    client = new Client({ name: 'scripted-fake-agent', version: '1.0.0' });
    await client.connect(transport);

    expect(client.getInstructions()).toContain('conflicts_list');
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual([
      'conflicts_list',
      'conflicts_get',
      'conflicts_read',
      'conflicts_diff',
      'conflicts_submit_local',
      'conflicts_acknowledge_local',
      'conflicts_resolve',
      'conflicts_wait',
    ]);

    const listed = structured(
      await client.callTool({ name: 'conflicts_list', arguments: {} })
    );
    expect(listed.conflicts).toHaveLength(1);
    expect(listed.conflicts[0]).toMatchObject({
      conflictId,
      workspaceName: 'Stdio Fixture',
      path: 'index.txt',
    });

    const read = structured(
      await client.callTool({
        name: 'conflicts_read',
        arguments: { conflictId, side: 'remote' },
      })
    );
    expect(read.content).toBe('remote');
  });
});
