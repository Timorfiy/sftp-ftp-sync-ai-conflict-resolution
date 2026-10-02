import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverExternalConnection, publishExternalConnection } from '../externalConnection';
import { McpLaunchConfiguration } from '../conflictContract';

describe('external editor MCP sessions', () => {
  let directory: string;
  let serverPath: string;
  let configuration: McpLaunchConfiguration;
  const disposables: Array<{ dispose(): void }> = [];
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-external-mcp-'));
    serverPath = path.join(directory, 'mcp-server.js');
    fs.writeFileSync(serverPath, '');
    configuration = {
      version: 1, extensionVersion: '0.8.3', stateRoot: path.join(directory, 'state'),
      capability: 'a'.repeat(64), workspaces: [{ bucket: 'b'.repeat(64), root: path.join(directory, 'project'), name: 'project' }],
    };
  });
  afterEach(() => {
    disposables.splice(0).forEach(d => d.dispose());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function publish(config = configuration) {
    const disposable = publishExternalConnection(directory, config, serverPath);
    disposables.push(disposable);
    return disposable;
  }
  const registry = () => path.join(directory, 'external-mcp');

  test('publishes a private live connection and removes it when disposed', () => {
    const disposable = publish();
    expect(discoverExternalConnection(registry(), configuration.workspaces[0].root).configuration).toEqual(configuration);
    expect(fs.existsSync(configuration.workspaces[0].root)).toBe(false);
    if (process.platform !== 'win32') {
      const filename = path.join(registry(), fs.readdirSync(registry())[0]);
      expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    }
    disposable.dispose();
    expect(() => discoverExternalConnection(registry())).toThrow('No live');
  });

  test('does not grant access to a different workspace', () => {
    publish();
    expect(() => discoverExternalConnection(registry(), path.join(directory, 'other-project'))).toThrow('No live');
  });

  test('rejects expired sessions, even while their editor process is alive', () => {
    publish();
    const filename = path.join(registry(), fs.readdirSync(registry())[0]);
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    value.updatedAt -= 60_000;
    fs.writeFileSync(filename, JSON.stringify(value));
    expect(() => discoverExternalConnection(registry())).toThrow('No live');
  });

  test('rejects dead process, malformed and unsupported connection records', () => {
    publish();
    const filename = path.join(registry(), fs.readdirSync(registry())[0]);
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    for (const data of ['{broken', JSON.stringify({ ...value, version: 99 }), JSON.stringify({ ...value, processId: -1 }), JSON.stringify({ ...value, configuration: {} })]) {
      fs.writeFileSync(filename, data);
      expect(() => discoverExternalConnection(registry())).toThrow('No live');
    }
  });

  test('fails on ambiguous windows and picks up the fresh capability after reload', () => {
    const first = publish();
    const next = { ...configuration, capability: 'c'.repeat(64) };
    publish(next);
    expect(() => discoverExternalConnection(registry(), configuration.workspaces[0].root)).toThrow('Multiple');
    first.dispose();
    expect(discoverExternalConnection(registry()).configuration.capability).toBe(next.capability);
  });

  test('does not follow a redirected registry', () => {
    const outside = path.join(directory, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, registry(), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => discoverExternalConnection(registry())).toThrow('must not be a link');
    expect(() => publish()).toThrow('must not be a link');
  });
});
