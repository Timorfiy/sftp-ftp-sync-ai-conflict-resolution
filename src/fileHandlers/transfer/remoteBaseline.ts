import type { Memento } from 'vscode';
import type { ServiceConfig } from '../../core/fileService';

export interface RemoteBaseline {
  mtime: number;
  size: number;
  savedAt: number;
}

const STORE_KEY = 'sftpNeo.remoteBaseline.v1';
const MAX_ENTRIES = 2000;

let workspaceState: Memento | undefined;
let writeQueue: Promise<void> = Promise.resolve();

export function initRemoteBaselineStore(state: Memento) {
  workspaceState = state;
}

function baselineKey(config: ServiceConfig, remoteFsPath: string): string {
  return [
    config.protocol,
    config.username,
    config.host,
    config.port,
    remoteFsPath,
  ].join('|');
}

function readStore(): Record<string, RemoteBaseline> {
  return workspaceState?.get<Record<string, RemoteBaseline>>(STORE_KEY, {}) || {};
}

export async function getRemoteBaseline(
  config: ServiceConfig,
  remoteFsPath: string
): Promise<RemoteBaseline | undefined> {
  await writeQueue;
  return readStore()[baselineKey(config, remoteFsPath)];
}

export function recordRemoteBaseline(
  config: ServiceConfig,
  remoteFsPath: string,
  metadata: Pick<RemoteBaseline, 'mtime' | 'size'>
): Promise<void> {
  if (!workspaceState) {
    return Promise.resolve();
  }

  const write = async () => {
    const store = {
      ...readStore(),
      [baselineKey(config, remoteFsPath)]: {
        mtime: metadata.mtime,
        size: metadata.size,
        savedAt: Date.now(),
      },
    };

    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => store[a].savedAt - store[b].savedAt)
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach(key => delete store[key]);
    }

    await workspaceState!.update(STORE_KEY, store);
  };

  writeQueue = writeQueue.then(write, write);
  return writeQueue;
}
