const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const exec = promisify(execFile);

async function connectAgent(info) {
  // Read only the capability injected by the real editor into its owned MCP
  // process, then use the official SDK on identical installed stdio bytes.
  // This avoids lm.invokeTool's per-write confirmation outside a chat request;
  // it does not emulate registration, the bridge, SecretStorage or product UI.
  let output;
  try {
    output = await exec('powershell.exe', ['-NoProfile', '-File', path.join(__dirname, 'mcp-launch.ps1'),
      '-EditorPid', String(info.pid), '-ExtensionPath', info.extensionPath], {
      timeout: 15000, maxBuffer: 256 * 1024,
    });
  } catch {
    // exec errors can carry stdout; never propagate the captured capability.
    throw new Error('Could not obtain the owned editor MCP launch; check startup and process ownership');
  }
  const launch = JSON.parse(output.stdout.replace(/^\uFEFF/, ''));
  output = undefined;
  const configuration = JSON.parse(launch.configuration);
  assert.equal(configuration.extensionVersion, info.productVersion);
  assert.equal(configuration.workspaces.length, 1);
  assert.equal(path.resolve(configuration.workspaces[0].root).toLowerCase(),
    path.resolve(info.workspace).toLowerCase());
  const client = new Client({ name: 'rc-scripted-agent', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: launch.command, args: launch.args,
    env: { ELECTRON_RUN_AS_NODE: '1', SFTP_SYNC_AI_MCP_CONFIG: launch.configuration },
    stderr: 'pipe',
  });
  const warnings = [];
  if (transport.stderr) transport.stderr.on('data', () => { warnings.push('MCP stderr emitted (raw output withheld)'); });
  try {
    await client.connect(transport, { timeout: 15000 });
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    assert(client.getInstructions().includes('conflicts_wait'));
    return {
      names: tools.tools.map(tool => tool.name),
      editorMcpPid: launch.pid,
      warnings,
      async call(name, input) {
        const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 20000 });
        assert(result.structuredContent, 'Packaged MCP must return structured content');
        return result.structuredContent;
      },
      async close() { await client.close(); await transport.close(); },
    };
  } catch (error) {
    await client.close(); await transport.close(); throw error;
  }
}

module.exports = { connectAgent };
