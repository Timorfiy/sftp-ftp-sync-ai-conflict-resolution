import { Client } from 'basic-ftp';
import RemoteClient, { ConnectOption } from './remoteClient';

const DEFAULT_KEEPALIVE_INTERVAL = 0;
const DEFAULT_RECONNECT_ATTEMPTS = 1;
const RETRYABLE_METHODS = new Set([
  'cd',
  'cdup',
  'ensureDir',
  'features',
  'lastMod',
  'list',
  'pwd',
  'size',
]);

type Reconnect = () => Promise<void>;

function canRetry(methodName: string, args: any[]): boolean {
  return RETRYABLE_METHODS.has(methodName) || (methodName === 'send' && args[0] === 'NOOP');
}

/**
 * basic-ftp does not support concurrent commands on a single control connection.
 * Wrap the client so every method call is queued and executed one at a time. If
 * the control connection is already closed, reconnect before starting the next
 * operation. Only retry operations that are safe to repeat after a mid-command
 * disconnect; streams and mutating file operations are deliberately excluded.
 */
function createSerializedClient(client: Client, reconnect: Reconnect): Client {
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(
      () => task(),
      () => task()
    );
    queue = next.then(
      () => {},
      () => {}
    );
    return next;
  };

  return new Proxy(client, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value === 'function') {
        return function (...args: any[]) {
          return enqueue(async () => {
            const methodName = String(prop);
            const manageConnection = methodName !== 'access' && methodName !== 'close';

            if (manageConnection && target.closed) {
              await reconnect();
            }

            try {
              return await value.apply(target, args);
            } catch (error) {
              if (!manageConnection || !target.closed) {
                throw error;
              }

              await reconnect();
              if (!canRetry(methodName, args)) {
                throw error;
              }

              return value.apply(target, args);
            }
          });
        };
      }
      return value;
    },
  }) as Client;
}

export default class FTPClient extends RemoteClient {
  private _rawClient: Client;
  private _connectOption?: ConnectOption;
  private _keepAliveTimer?: ReturnType<typeof setInterval>;
  private _disconnectHandlers: Array<(reason: string) => void> = [];
  private _ending: boolean = false;
  private _disconnectedNotified: boolean = false;

  _initClient() {
    this._rawClient = new Client(this._option.connectTimeout || 10000);
    return createSerializedClient(this._rawClient, () => this._reconnect());
  }

  _hasProvideAuth(connectOption: ConnectOption) {
    return connectOption.password != undefined;
  }

  onDisconnected(cb: (reason: string) => void) {
    this._disconnectHandlers.push(cb);
  }

  async _doConnect(connectOption: ConnectOption): Promise<void> {
    this._ending = false;
    this._connectOption = { ...connectOption };
    await this._access(this._connectOption);
    this._disconnectedNotified = false;
    this._startKeepAlive();
  }

  private async _access(connectOption: ConnectOption): Promise<void> {
    const client = this._rawClient;

    // Map secure option
    let secure: boolean | 'implicit' = false;
    if (connectOption.secure === true) {
      secure = true;
    } else if (connectOption.secure === 'implicit') {
      secure = 'implicit';
    } else if (connectOption.secure === 'control') {
      // basic-ftp does not support control-only TLS; use full TLS as safest fallback
      secure = true;
    }

    // Set up debug logging
    const originalDebug = connectOption.debug;
    client.ftp.log = (message: string) => {
      if (typeof message === 'string') {
        // Mask password in logs
        if (message.includes('PASS ')) {
          message = message.replace(/PASS .*/, 'PASS ******');
        }
        originalDebug(message);
      }
    };

    await client.access({
      host: connectOption.host,
      port: connectOption.port,
      user: connectOption.username,
      password: connectOption.password,
      secure,
      secureOptions: connectOption.secureOptions as any,
    });
  }

  private _startKeepAlive() {
    this._stopKeepAlive();

    const interval = this._connectOption?.ftpKeepAliveInterval ?? DEFAULT_KEEPALIVE_INTERVAL;
    if (!Number.isFinite(interval) || interval <= 0) {
      return;
    }

    this._keepAliveTimer = setInterval(() => {
      void this._sendKeepAlive();
    }, interval);
    this._keepAliveTimer.unref?.();
  }

  private _stopKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = undefined;
    }
  }

  private async _sendKeepAlive(): Promise<void> {
    if (this._ending || !this._connectOption) {
      return;
    }

    try {
      await (this._client as Client).send('NOOP');
    } catch {
      if (!this._rawClient.closed) {
        this._logStatus('FTP server rejected NOOP; keepalive disabled.');
        this._stopKeepAlive();
      }
    }
  }

  private async _reconnect(): Promise<void> {
    if (this._ending || !this._connectOption) {
      throw new Error('FTP client cannot reconnect after it has been closed.');
    }

    const configuredAttempts = this._connectOption.ftpReconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    const attempts = Number.isFinite(configuredAttempts)
      ? Math.max(0, Math.floor(configuredAttempts))
      : DEFAULT_RECONNECT_ATTEMPTS;
    let lastError: unknown = new Error('FTP reconnect is disabled.');

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        this._logStatus(`reconnecting FTP session (${attempt}/${attempts})...`);
        await this._access(this._connectOption);
        this._disconnectedNotified = false;
        this._logStatus('FTP session reconnected.');
        return;
      } catch (error) {
        lastError = error;
      }
    }

    this._notifyDisconnected('reconnect-failed');
    throw lastError;
  }

  private _notifyDisconnected(reason: string) {
    if (this._disconnectedNotified) {
      return;
    }

    this._disconnectedNotified = true;
    this._stopKeepAlive();
    this._disconnectHandlers.forEach(handler => handler(reason));
  }

  private _logStatus(message: string) {
    this._connectOption?.debug(`[connection] > ${message}`);
  }

  end() {
    this._ending = true;
    this._stopKeepAlive();
    this._rawClient.close();
  }

  getFsClient() {
    return this._client;
  }
}
