import * as fs from 'fs';
import * as path from 'path';
import { requireSafeLocalPath } from '../helper/safeLocalPath';
import { redactedErrorMessage } from '../security/redaction';
import { atomicWriteJson } from '../fileHandlers/transfer/conflictStateStore';
import type { McpLaunchConfiguration } from './conflictContract';
import {
  uploadBridgeRoot, uploadRequestSchema, uploadSession, UploadItem, UploadJob,
} from './uploadContract';

export type UploadRunner = (
  workspace: string, file: string, update: (item: Partial<UploadItem>) => Promise<void>,
  signal: AbortSignal
) => Promise<Partial<UploadItem>>;

export async function initializeUploadBridge(config: McpLaunchConfiguration, run: UploadRunner): Promise<{ dispose(): void }> {
  const root = uploadBridgeRoot(config);
  await fs.promises.mkdir(config.stateRoot, { recursive: true });
  await requireSafeLocalPath(config.stateRoot, root, { allowMissingLeaf: true, type: 'directory' });
  await fs.promises.mkdir(root, { recursive: true });
  const requests = path.join(root, 'requests');
  const results = path.join(root, 'results');
  for (const directory of [requests, results]) {
    await requireSafeLocalPath(root, directory, { allowMissingLeaf: true, type: 'directory' });
    await fs.promises.mkdir(directory, { recursive: true });
  }
  const controller = new AbortController();
  let scanning = false;
  const seen = new Set<string>();
  let queue = Promise.resolve();

  async function processRequest(file: string): Promise<void> {
    await requireSafeLocalPath(requests, file, { type: 'file' });
    if ((await fs.promises.stat(file)).size > 512 * 1024) return;
    const parsed = uploadRequestSchema.safeParse(JSON.parse(await fs.promises.readFile(file, 'utf8')));
    if (!parsed.success) return;
    const request = parsed.data;
    if (path.basename(file) !== `${request.operationId}.json` || request.capability !== config.capability) return;
    const workspace = config.workspaces.find(item => item.bucket === request.workspace);
    if (!workspace || Math.abs(Date.now() - Date.parse(request.createdAt)) > 120_000) return;
    const job: UploadJob = {
      version: 1, operationId: request.operationId, session: uploadSession(config),
      workspace: workspace.bucket, terminal: false,
      files: request.paths.map(filePath => ({ path: filePath, status: 'pending' })),
    };
    const resultFile = path.join(results, `${request.operationId}.json`);
    const save = async () => {
      await requireSafeLocalPath(results, resultFile, { allowMissingLeaf: true, type: 'file' });
      await atomicWriteJson(resultFile, job);
    };
    await save();
    // Requests are accepted once, before entering the serial transfer queue.
    await fs.promises.rm(file, { force: true });
    queue = queue.then(async () => {
      for (const item of job.files) {
        if (controller.signal.aborted) { item.status = 'cancelled'; continue; }
        try {
          const localFile = path.resolve(workspace.root, item.path);
          await requireSafeLocalPath(workspace.root, localFile, { type: 'file' });
          item.path = path.relative(workspace.root, localFile).replace(/\\/g, '/');
          item.status = 'uploading';
          await save();
          Object.assign(item, await run(workspace.root, localFile, async changes => {
            Object.assign(item, changes);
            await save();
          }, controller.signal));
        } catch (error) {
          item.status = controller.signal.aborted ? 'cancelled' : 'failed';
          item.message = redactedErrorMessage(error).slice(0, 800);
        }
        await save();
      }
      job.terminal = true;
      await save();
    }).catch(() => undefined);
  }

  async function scan(): Promise<void> {
    if (scanning || controller.signal.aborted) return;
    scanning = true;
    try {
      await requireSafeLocalPath(root, requests, { type: 'directory' });
      for (const entry of await fs.promises.readdir(requests)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(entry) || seen.has(entry)) continue;
        seen.add(entry);
        await processRequest(path.join(requests, entry)).catch(() => undefined);
      }
    } finally { scanning = false; }
  }
  const timer = setInterval(() => { void scan().catch(() => undefined); }, 200);
  timer.unref?.();
  return { dispose() { clearInterval(timer); controller.abort(); } };
}
