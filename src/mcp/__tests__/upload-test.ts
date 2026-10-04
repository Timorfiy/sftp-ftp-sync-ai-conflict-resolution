import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createConflictMcpServer } from '../server';
import { initializeUploadBridge } from '../uploadBridge';
import { uploadBridgeRoot, uploadRequestSchema } from '../uploadContract';
import { workspaceBucketId } from '../../fileHandlers/transfer/conflictStateStore';
import type { McpLaunchConfiguration } from '../conflictContract';

describe('explicit MCP uploads through the live extension bridge', () => {
  let root: string;
  let config: McpLaunchConfiguration;
  let client: Client;
  let bridge: { dispose(): void };
  let run: jest.Mock;
  let release: (() => void) | undefined;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sftp-mcp-upload-'));
    const workspace = path.join(root, 'workspace');
    await fs.promises.mkdir(workspace);
    await fs.promises.writeFile(path.join(workspace, 'first.txt'), 'first');
    await fs.promises.writeFile(path.join(workspace, 'second.txt'), 'second');
    config = { version: 1, extensionVersion: '0.9.2', stateRoot: path.join(root, 'state'),
      capability: `${randomUUID()}${randomUUID()}`,
      workspaces: [{ bucket: workspaceBucketId(workspace), root: workspace, name: 'Selected' }] };
    run = jest.fn(async () => ({ status: 'uploaded' }));
    bridge = await initializeUploadBridge(config, run);
    const server = createConflictMcpServer(config, 'Upload saved files.');
    client = new Client({ name: 'upload-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });
  afterEach(async () => {
    release?.(); release = undefined;
    bridge.dispose();
    await client.close();
    // Let an in-flight fixture runner finish its last atomic result write.
    await new Promise(resolve => setTimeout(resolve, 250));
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: { workspace: config.workspaces[0].bucket, ...args } });
    return result.structuredContent as any;
  }

  test('uploads saved paths once, removes duplicate paths and keeps results compact', async () => {
    const result = await call('upload_files', { paths: ['first.txt', path.join(config.workspaces[0].root, 'first.txt'), 'second.txt'] });
    expect(result).toMatchObject({ ok: true, terminal: true, uploaded: 2, total: 2, files: [] });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0].slice(0, 2)).toEqual([config.workspaces[0].root, path.join(config.workspaces[0].root, 'first.txt')]);
    expect(JSON.stringify(result)).not.toContain(config.capability);
    expect(await call('uploads_wait', { operationId: result.operationId })).toEqual(result);
  });
  test.each(['../outside.txt', '.', 'missing.txt'])('rejects unsafe or non-file path %s before submitting any upload', async file => {
    await fs.promises.writeFile(path.join(root, 'outside.txt'), 'outside');
    const result = await call('upload_files', { paths: ['first.txt', file] });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    expect(run).not.toHaveBeenCalled();
  });
  test('refuses symlinked files and directory junctions', async () => {
    const outside = path.join(root, 'outside');
    await fs.promises.mkdir(outside);
    await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.promises.symlink(outside, path.join(config.workspaces[0].root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await call('upload_files', { paths: ['linked/secret.txt'] })).toMatchObject({ ok: false, error: { code: 'invalid_path' } });
    expect(run).not.toHaveBeenCalled();
  });
  test('returns partial failure, exclusions and warnings without claiming all files uploaded', async () => {
    run.mockImplementationOnce(async () => ({ status: 'skipped', message: 'Excluded.' }))
      .mockImplementationOnce(async () => { throw new Error('Network failure'); });
    const result = await call('upload_files', { paths: ['first.txt', 'second.txt'] });
    expect(result).toMatchObject({ terminal: true, uploaded: 0, files: [
      { path: 'first.txt', status: 'skipped' }, { path: 'second.txt', status: 'failed', message: 'Network failure' },
    ] });
    run.mockResolvedValueOnce({ status: 'uploaded', warnings: ['Backup unavailable.'] });
    const warning = await call('upload_files', { paths: ['first.txt'] });
    expect(warning.files).toEqual([{ path: 'first.txt', status: 'uploaded', warnings: ['Backup unavailable.'] }]);
  });
  test('returns conflict immediately, keeps the operation live and waits for its eventual upload', async () => {
    run.mockImplementationOnce(async (_workspace, _file, update) => {
      await update({ status: 'conflict', conflictId: 'pending-conflict', revision: 1 });
      await new Promise<void>(resolve => { release = resolve; });
      return { status: 'uploaded' };
    });
    const result = await call('upload_files', { paths: ['first.txt', 'second.txt'] });
    expect(result).toMatchObject({ terminal: false, uploaded: 0, files: [
      { path: 'first.txt', status: 'conflict', conflictId: 'pending-conflict', revision: 1 },
      { path: 'second.txt', status: 'pending' },
    ] });
    release!();
    expect(await call('uploads_wait', { operationId: result.operationId })).toMatchObject({ terminal: true, uploaded: 2, files: [] });
  });
  test('timeout returns an operation ID and wait does not resubmit the file', async () => {
    run.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { status: 'uploaded' };
    });
    const result = await call('upload_files', { paths: ['first.txt'], timeoutSeconds: 1 });
    expect(result).toMatchObject({ terminal: false, timedOut: true, uploaded: 0 });
    release!();
    expect(await call('uploads_wait', { operationId: result.operationId })).toMatchObject({ terminal: true, uploaded: 1 });
    expect(run).toHaveBeenCalledTimes(1);
  });
  test('workspace selection cannot upload to or read results from another project', async () => {
    expect(await call('upload_files', { workspace: path.join(root, 'other'), paths: ['first.txt'] })).toMatchObject({ ok: false, error: { code: 'wrong_workspace' } });
    expect(run).not.toHaveBeenCalled();
  });
  test('bridge rejects an invalid capability and validates file paths independently', async () => {
    const requests = path.join(uploadBridgeRoot(config), 'requests');
    for (const [capability, file] of [['x'.repeat(64), 'first.txt'], [config.capability, '../outside.txt']]) {
      const operationId = randomUUID();
      await fs.promises.writeFile(path.join(requests, `${operationId}.json`), JSON.stringify(uploadRequestSchema.parse({
        version: 1, operationId, capability, workspace: config.workspaces[0].bucket,
        paths: [file], createdAt: new Date().toISOString(),
      })));
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(run).not.toHaveBeenCalled();
  });
  test('does not fall back when the upload bridge is unavailable', async () => {
    bridge.dispose();
    await fs.promises.rm(uploadBridgeRoot(config), { recursive: true, force: true });
    expect(await call('upload_files', { paths: ['first.txt'] })).toMatchObject({ ok: false, error: { code: 'extension_unavailable' } });
    expect(run).not.toHaveBeenCalled();
  });
});
