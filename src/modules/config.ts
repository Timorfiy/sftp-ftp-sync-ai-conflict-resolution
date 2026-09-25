import * as vscode from 'vscode';
import * as fse from 'fs-extra';
import * as path from 'path';
import { z } from 'zod';
import { CONFIG_PATH } from '../constants';
import { reportError } from '../helper';
import { showTextDocument } from '../host';
import { BASE_IGNORE_PATTERNS, IGNORE_PRESETS } from './ignorePresets';

const nullableString = z.string().optional().nullable();

const configScheme = z.object({
  name: z.string().optional(),
  context: z.string().optional(),
  protocol: z.enum(['sftp', 'ftp', 'local']).optional(),

  host: z.string(),
  port: z.number().int().optional(),
  connectTimeout: z.number().int().optional(),
  username: z.string(),
  password: nullableString,

  agent: nullableString,
  privateKeyPath: nullableString,
  passphrase: z.union([z.string(), z.literal(true)]).optional().nullable(),
  interactiveAuth: z.union([z.boolean(), z.array(z.string())]).optional(),
  algorithms: z.any().optional(),
  sshConfigPath: z.string().optional(),
  sshCustomParams: z.string().optional(),

  secure: z.union([z.boolean(), z.literal('control'), z.literal('implicit')]).optional(),
  secureOptions: z.record(z.string(), z.any()).optional().nullable(),
  passive: z.boolean().optional(),
  networkInterface: z.string().trim().min(1).optional().nullable(),
  ftpKeepAliveInterval: z.number().int().min(0).optional(),
  ftpReconnectAttempts: z.number().int().min(0).optional(),

  remotePath: z.string(),
  uploadOnSave: z.boolean().optional(),
  conflictCheck: z.boolean().optional(),
  useTempFile: z.boolean().optional(),
  openSsh: z.boolean().optional(),
  downloadOnOpen: z.union([z.boolean(), z.literal('confirm')]).optional(),

  ignore: z.array(z.string()).optional(),
  ignoreFile: z.string().optional(),
  watcher: z.object({
    files: z.union([z.string(), z.literal(false), z.null()]).optional(),
    autoUpload: z.boolean().optional(),
    autoDelete: z.boolean().optional(),
    autoRename: z.boolean().optional(),
  }).optional(),
  concurrency: z.number().int().optional(),

  syncOption: z.object({
    delete: z.boolean().optional(),
    skipCreate: z.boolean().optional(),
    ignoreExisting: z.boolean().optional(),
    update: z.boolean().optional(),
  }).optional(),
  backup: z.object({
    enabled: z.boolean().optional(),
    location: z.enum(['local', 'remote']).optional(),
    folder: z.string().optional(),
    versions: z.number().int().min(0).optional(),
    onDelete: z.boolean().optional(),
  }).optional(),
  remoteTimeOffsetInHours: z.number().optional(),

  remoteExplorer: z.object({
    filesExclude: z.array(z.string()).optional(),
    order: z.number().optional(),
    enableDragAndDrop: z.boolean().optional(),
  }).optional(),

  hooks: z.object({
    preUpload: z.string().optional(),
    postUpload: z.string().optional(),
    preDownload: z.string().optional(),
    postDownload: z.string().optional(),
    preSync: z.string().optional(),
    postSync: z.string().optional(),
  }).optional(),

  // Additional fields used in the codebase
  profiles: z.record(z.string(), z.any()).optional(),
  remote: z.string().optional(),
  limitOpenFilesOnRemote: z.union([z.boolean(), z.number()]).optional(),
  filePerm: z.number().optional(),
  dirPerm: z.number().optional(),
}).passthrough();

const defaultConfig = {
  // common
  // name: undefined,
  remotePath: './',
  uploadOnSave: false,
  conflictCheck: false,
  useTempFile: false,
  openSsh: false,
  downloadOnOpen: false,
  ignore: [],
  // ignoreFile: undefined,
  // watcher: {
  //   files: false,
  //   autoUpload: false,
  //   autoDelete: false,
  // },
  concurrency: 4,
  // limitOpenFilesOnRemote: false

  protocol: 'sftp',

  // server common
  // host,
  // port,
  // username,
  // password,
  connectTimeout: 10 * 1000,

  // sftp
  // agent,
  // privateKeyPath,
  // passphrase,
  interactiveAuth: false,
  // algorithms,

  // ftp
  secure: false,
  // secureOptions,
  // passive: false,
  remoteTimeOffsetInHours: 0,

  remoteExplorer: {
    order: 0,
    enableDragAndDrop: false,
  },

  backup: {
    enabled: false,
    location: 'remote',
    folder: '.vscode/sftp-backup',
    versions: 100,
    onDelete: false,
  },
};

export interface ConfigDocument {
  path: string;
  configs: any[];
}

export class ConfigDocumentError extends Error {
  readonly configPath: string;
  readonly field?: string;

  constructor(configPath: string, message: string, field?: string) {
    super(message);
    this.name = 'ConfigDocumentError';
    this.configPath = configPath;
    this.field = field;
  }
}

function mergedDefault(config) {
  return {
    ...defaultConfig,
    ...config,
    backup: {
      ...defaultConfig.backup,
      ...config.backup,
    },
  };
}

export function getConfigPath(basePath: string) {
  return path.join(basePath, CONFIG_PATH);
}

export function validateConfig(config) {
  const result = configScheme.safeParse(config);
  if (!result.success) {
    const messages = result.error.issues.map(
      issue => `${issue.path.join('.')}: ${issue.message}`
    );
    return new Error(messages.join(', '));
  }
  if (config.networkInterface && config.protocol !== 'ftp') {
    return new Error('networkInterface is supported only for FTP connections.');
  }
  return null;
}

function configError(configPath: string, index: number, error: Error): ConfigDocumentError {
  const firstMessage = error.message.split(', ')[0];
  const separator = firstMessage.indexOf(':');
  const field = separator > 0 ? firstMessage.slice(0, separator) : undefined;
  const prefix = index > 0 ? `Connection ${index + 1}: ` : '';
  return new ConfigDocumentError(configPath, `${prefix}${error.message}`, field);
}

export function parseConfigDocument(configPath: string, text: string): ConfigDocument {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigDocumentError(configPath, `Invalid JSON: ${detail}`);
  }

  const rawConfigs = Array.isArray(parsed) ? parsed : [parsed];
  if (rawConfigs.length === 0) {
    throw new ConfigDocumentError(configPath, 'The configuration must contain at least one connection.');
  }

  const configs = rawConfigs.map((rawConfig, index) => {
    const config = mergedDefault(rawConfig);
    const validationError = validateConfig(config);
    if (validationError) {
      throw configError(configPath, index, validationError);
    }
    return config;
  });
  return { path: configPath, configs };
}

export async function loadConfigDocument(configPath: string): Promise<ConfigDocument> {
  let text: string;
  try {
    text = await fse.readFile(configPath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigDocumentError(configPath, `Unable to read configuration: ${detail}`);
  }
  return parseConfigDocument(configPath, text);
}

export async function readConfigsFromFile(configPath): Promise<any[]> {
  return (await loadConfigDocument(configPath)).configs;
}

export function tryLoadConfigs(workspace): Promise<any[]> {
  const configPath = getConfigPath(workspace);
  return fse.pathExists(configPath).then(
    exist => {
      if (exist) {
        return readConfigsFromFile(configPath);
      }
      return [];
    },
    _ => []
  );
}

// export function getConfig(activityPath: string) {
//   const config = configTrie.findPrefix(normalizePath(activityPath));
//   if (!config) {
//     throw new Error(`(${activityPath}) config file not found`);
//   }

//   return normalizeConfig(config);
// }

export function createNewConfigTemplate(ignore: string[] = BASE_IGNORE_PATTERNS) {
  return {
    name: 'My Server',
    host: 'localhost',
    protocol: 'sftp',
    port: 22,
    username: 'username',
    remotePath: '/',
    uploadOnSave: false,
    conflictCheck: true,
    useTempFile: false,
    openSsh: false,
    concurrency: 4,
    watcher: {
      files: false,
      autoUpload: false,
      autoDelete: false,
      autoRename: false,
    },
    syncOption: {
      delete: false,
      skipCreate: false,
      ignoreExisting: false,
      update: false,
    },
    ignore: [...ignore],
    backup: {
      enabled: true,
      location: 'local',
      folder: '.vscode/sftp-backup',
      versions: 100,
      onDelete: false,
    },
  };
}

export function newConfig(basePath) {
  const configPath = getConfigPath(basePath);

  return fse
    .pathExists(configPath)
    .then(async exist => {
      if (exist) {
        return showTextDocument(vscode.Uri.file(configPath));
      }

      const preset = await vscode.window.showQuickPick(IGNORE_PRESETS.map(item => ({
        ...item, detail: item.patterns.join(', '),
      })), { placeHolder: 'Choose an ignore template for the new configuration', matchOnDescription: true });
      if (!preset) return;

      // A config created while the picker was open must not be overwritten.
      if (await fse.pathExists(configPath)) {
        return showTextDocument(vscode.Uri.file(configPath));
      }
      return fse
        .outputJson(
          configPath,
          createNewConfigTemplate(preset.patterns),
          { spaces: 4, flag: 'wx' }
        )
        .then(() => showTextDocument(vscode.Uri.file(configPath)));
    })
    .catch(reportError);
}
