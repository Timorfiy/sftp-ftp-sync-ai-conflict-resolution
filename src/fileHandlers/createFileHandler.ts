import { Uri } from 'vscode';
import app from '../app';
import { UResource, FileService, ServiceConfig } from '../core';
import logger from '../logger';
import { getFileService } from '../modules/serviceManager';
import { COMMAND_SYNC_REMOTE_TO_LOCAL } from '../constants';
import { isConflictStatePath } from './transfer/conflictStateIsolation';
import { withActivityOperation, recordActivityAction } from '../modules/activity';
import { localPathKey } from '../helper/localPaths';
import * as path from 'path';

const REMOTE_TO_LOCAL_COMMAND_URI = `file:///\${command:${COMMAND_SYNC_REMOTE_TO_LOCAL}}`;

interface FileHandlerConfig {
  _?: boolean;
}

export interface FileHandlerContext {
  target: UResource;
  fileService: FileService;
  config: ServiceConfig;
  connectionLabel: string;
  profile?: string | null;
}

type FileHandlerContextMethod<R = void> = (this: FileHandlerContext) => R;
type FileHandlerContextMethodArg1<A, R = void> = (this: FileHandlerContext, a: A) => R;

interface FileHandlerOption<T> {
  name: string;
  handle: FileHandlerContextMethodArg1<T, Promise<any>>;
  beforeHandle?: FileHandlerContextMethodArg1<T, Promise<boolean>>;
  afterHandle?: FileHandlerContextMethod;
  config?: FileHandlerConfig;
  transformOption?: FileHandlerContextMethod<T>;
}

export function handleCtxFromUri(uri: Uri): FileHandlerContext {
  const fileService = getFileService(uri);
  if (!fileService) {
    if (uri.toString(true) === REMOTE_TO_LOCAL_COMMAND_URI) {
      throw '';
    } else {
      throw new Error(`Config Not Found. (${uri.toString(true)})`);
    }
  }
  const config = fileService.getConfig();
  const target = UResource.from(uri, {
    localBasePath: fileService.baseDir,
    remoteBasePath: config.remotePath,
    remoteId: fileService.id,
    remote: {
      host: config.host,
      port: config.port,
    },
  });

  return {
    fileService,
    config,
    target,
    connectionLabel: fileService.getConnectionLabel(),
    profile: app.state.profile,
  };
}

export function allHandleCtxFromUri(uri: Uri): Array<FileHandlerContext> {
  const fileService = getFileService(uri);
  if (!fileService) {
    if (uri.toString(true) === REMOTE_TO_LOCAL_COMMAND_URI) {
      throw '';
    } else {
      throw new Error(`Config Not Found. (${uri.toString(true)})`);
    }
  }

  return fileService.getAvailableProfiles().map(profile => {
    const config = fileService.getConfig(profile);
    const target = UResource.from(uri, {
      localBasePath: fileService.baseDir,
      remoteBasePath: config.remotePath,
      remoteId: fileService.id,
      remote: {
        host: config.host,
        port: config.port,
      },
    });

    return {
      fileService,
      config,
      target,
      connectionLabel: fileService.getConnectionLabel(profile),
      profile,
    };
  });
}

export default function createFileHandler<T>(
  handlerOption: FileHandlerOption<T>
): (ctx: FileHandlerContext | Uri, option?: Partial<T>) => Promise<void> {
  async function fileHandle(ctx: Uri | FileHandlerContext, option?: T) {
    const handleCtx = ctx instanceof Uri ? handleCtxFromUri(ctx) : ctx;
    const { target } = handleCtx;
    if (isConflictStatePath(target.localFsPath)) {
      logger.warn(`Blocked transfer access to private conflict state: ${target.localFsPath}`);
      return;
    }

    const invokeOption = handlerOption.transformOption
      ? handlerOption.transformOption.call(handleCtx)
      : {};
    if (option) {
      Object.assign(invokeOption, option);
    }

    if (invokeOption.ignore && invokeOption.ignore(target.localFsPath)) {
      return;
    }

    if (
      handlerOption.beforeHandle &&
      !(await handlerOption.beforeHandle.call(handleCtx, invokeOption))
    ) {
      return;
    }

    logger.trace(`handle ${handlerOption.name} for`, target.localFsPath);

    const tracked = /^(upload|download|sync|removeRemote|rename|create)/.test(handlerOption.name);
    const execute = async () => {
      const action = handlerOption.name === 'removeRemote' ? 'delete' : handlerOption.name === 'rename' ? 'rename'
        : handlerOption.name.startsWith('create') ? 'mkdir' : undefined;
      if (action) {
        await recordActivityAction(action, target.localFsPath, target.remoteFsPath,
          () => handlerOption.handle.call(handleCtx, invokeOption));
      } else {
        await handlerOption.handle.call(handleCtx, invokeOption);
      }
    // } catch (error) {
    //   reportError(error, `when ${handlerOption.name} ${target.localFsPath}`);
    //   Object.defineProperty(error, 'reported', {
    //     configurable: false,
    //     enumerable: false,
    //     value: true,
    //   });
    //   throw error;
    };
    if (tracked) {
      const config = handleCtx.config;
      await withActivityOperation(handlerOption.name, {
        key: JSON.stringify([localPathKey(handleCtx.fileService.workspace), localPathKey(handleCtx.fileService.baseDir),
          config.protocol, config.host, config.port, config.username, config.remotePath, handleCtx.connectionLabel]),
        label: handleCtx.profile || handleCtx.fileService.name || path.basename(handleCtx.fileService.workspace),
        description: handleCtx.connectionLabel, workspace: handleCtx.fileService.workspace,
        basePath: handleCtx.fileService.baseDir, remotePath: config.remotePath, protocol: config.protocol,
      }, execute);
    } else {
      app.sftpBarItem.startSpinner();
      try { await execute(); } finally { app.sftpBarItem.stopSpinner(); }
    }
    if (handlerOption.afterHandle) {
      handlerOption.afterHandle.call(handleCtx);
    }
  }

  return fileHandle;
}
