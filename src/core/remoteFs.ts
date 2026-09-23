import upath from './upath';
import { createHash } from 'crypto';
import { showConfirmMessage } from '../host';
import logger from '../logger';
import app from '../app';
import { ConnectOption } from './remote-client/remoteClient';
import {
  createCredentialEndpoint,
} from '../modules/secrets';
import { checkHostKey } from './remote-client/hostKeyStore';
import { setConnectionState, removeConnection } from '../modules/connectionHealth';
import { RedactionScope } from '../security/redaction';
import { createCredentialPrompt } from '../security/credentialPrompt';
import {
  FileSystem,
  RemoteFileSystem,
  SFTPFileSystem,
  FTPFileSystem,
} from './fs';
import localFs from './localFs';

const SECRET_IDENTITY_FIELDS = new Set([
  'password',
  'passphrase',
]);

function cacheIdentityValue(value: unknown, key?: string): unknown {
  if (key === 'interactiveAuth' && Array.isArray(value)) {
    return {
      mode: 'predefined-answers',
      count: value.length,
    };
  }
  if (key && SECRET_IDENTITY_FIELDS.has(key)) {
    return undefined;
  }
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return undefined;
  }
  if (value === null || typeof value !== 'object') {
    if (key === 'host' || key === 'protocol') {
      return String(value).trim().toLocaleLowerCase('en-US');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => cacheIdentityValue(item))
      .filter(item => item !== undefined);
  }
  const normalized: Record<string, unknown> = {};
  for (const childKey of Object.keys(value).sort()) {
    const childValue = cacheIdentityValue(
      (value as Record<string, unknown>)[childKey],
      childKey
    );
    if (childValue !== undefined) {
      normalized[childKey] = childValue;
    }
  }
  return normalized;
}

export function remoteCacheIdentity(option: Record<string, unknown>): string {
  const canonical = JSON.stringify(cacheIdentityValue(option));
  return createHash('sha256').update(canonical).digest('hex');
}

class KeepAliveRemoteFs {
  private isValid: boolean = false;

  private pendingPromise: Promise<RemoteFileSystem> | null;

  private fs: RemoteFileSystem;

  private _identity: string;
  private readonly redactionScope = new RedactionScope();

  setIdentity(identity: string) {
    this._identity = identity;
  }

  async getFs(
    option: ConnectOption & {
      protocol: string;
      remoteTimeOffsetInHours: number;
    }
  ): Promise<RemoteFileSystem> {
    if (this.isValid && this.fs && this.fs.getClient().isClosed()) {
      logger.debug('Cached remote connection is closed; reconnecting.');
      this.invalid('closed');
    }

    if (this.isValid) {
      this.pendingPromise = null;
      return Promise.resolve(this.fs);
    }

    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    setConnectionState(this._identity, option.host, option.protocol, 'connecting');

    const connectOption = Object.assign({}, option);
    this.redactionScope.registerConnectionOptions(
      connectOption as unknown as Record<string, unknown>
    );
    const credentialEndpoint = createCredentialEndpoint(connectOption);
    // tslint:disable variable-name
    let FsConstructor: typeof SFTPFileSystem | typeof FTPFileSystem;
    if (option.protocol === 'sftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^DEBUG(?:\[SFTP\])?: (.*?): (.*?)$/);

        if (log) {
          if (log[1] === 'Parser') return;
          logger.debug(`${log[1]}: ${log[2]}`);
        } else {
          logger.debug(str);
        }
      };
      FsConstructor = SFTPFileSystem;
    } else if (option.protocol === 'ftp') {
      connectOption.debug = function debug(str) {
        const log = str.match(/^\[connection\] (>|<) (.*?)(\\r\\n)?$/);

        if (!log) return;

        if (log[2].match(/200 NOOP/)) return;

        if (log[2].match(/^PASS /)) log[2] = 'PASS ******';

        logger.debug(`${log[1]} ${log[2]}`);
      };
      FsConstructor = FTPFileSystem;
    } else {
      throw new Error(`unsupported protocol ${option.protocol}`);
    }

    this.fs = new FsConstructor(upath, {
      clientOption: connectOption,
      remoteTimeOffsetInHours: option.remoteTimeOffsetInHours,
    });
    this.fs.onDisconnected(this.invalid.bind(this));

    const requestSecret = createCredentialPrompt(
      credentialEndpoint,
      this.redactionScope
    );

    const verifyHostKey = async (fp: string, host: string, port: number): Promise<boolean> => {
      return checkHostKey(host, port, fp, async (fingerprint, h) => {
        const accepted = await showConfirmMessage(
          `The SSH host key for ${h} is not recognized.\n\nFingerprint (SHA-256):\n${fingerprint}\n\nAccept and connect?`,
          'Accept',
          'Reject'
        );
        return accepted ? 'accept' : 'reject';
      }, option.workspace);
    };

    app.sftpBarItem.showMsg('connecting...', connectOption.connectTimeout);
    this.pendingPromise = this.fs
      .connect(connectOption, {
        requestSecret,
        verifyHostKey,
      })
      .then(
        () => {
          app.sftpBarItem.reset();
          this.isValid = true;
          setConnectionState(this._identity, option.host, option.protocol, 'connected');
          return this.fs;
        },
        err => {
          this.fs.end();
          setConnectionState(this._identity, option.host, option.protocol, 'error');
          this.invalid('error');
          throw err;
        }
      );

    return this.pendingPromise;
  }

  invalid(_reason: string) {
    this.pendingPromise = null;
    this.fs.end();
    this.isValid = false;
    if (this._identity) {
      setConnectionState(this._identity, '', '', 'disconnected');
    }
  }

  end() {
    this.fs.end();
    this.redactionScope.dispose();
    if (this._identity) {
      removeConnection(this._identity);
    }
  }
}

function getLocalFs() {
  return Promise.resolve(localFs);
}

const fsTable: {
  [x: string]: KeepAliveRemoteFs;
} = {};

export function createRemoteIfNoneExist(option): Promise<FileSystem> {
  if (option.protocol === 'local') {
    return getLocalFs();
  }

  const identity = remoteCacheIdentity(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    return fs.getFs(option);
  }

  const fsInstance = new KeepAliveRemoteFs();
  fsInstance.setIdentity(identity);
  fsTable[identity] = fsInstance;
  return fsInstance.getFs(option);
}

export function removeRemoteFs(option) {
  const identity = remoteCacheIdentity(option);
  const fs = fsTable[identity];
  if (fs !== undefined) {
    fs.end();
    delete fsTable[identity];
  }
}

export function getAllRemoteFs(): KeepAliveRemoteFs[] {
  return Object.values(fsTable);
}
