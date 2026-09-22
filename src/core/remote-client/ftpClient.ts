import { Client } from 'basic-ftp';
import RemoteClient, { ConnectOption } from './remoteClient';
import logger from '../../logger';
import { bindFTPNetworkInterface, FTPNetworkBinding } from './ftpNetworkBinding';

/**
 * basic-ftp does not support concurrent commands on a single control connection.
 * Wrap the client so every method call is queued and executed one at a time.
 */
function createSerializedClient(client: Client): Client {
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
          return enqueue(() => value.apply(target, args));
        };
      }
      return value;
    },
  }) as Client;
}

export default class FTPClient extends RemoteClient {
  private _keepaliveTimer?: ReturnType<typeof setInterval>;
  private _onDisconnectedCb?: (reason: string) => void;
  private _socketListenersAttached = false;
  private _networkBinding?: FTPNetworkBinding;

  _initClient() {
    const client = new Client(this._option.connectTimeout || 10000);
    return createSerializedClient(client);
  }

  _hasProvideAuth(connectOption: ConnectOption) {
    return connectOption.password != undefined;
  }

  isClosed() {
    return this._client.closed || !!(this._networkBinding && !this._networkBinding.isAvailable());
  }

  onDisconnected(cb: (reason: string) => void) {
    this._onDisconnectedCb = cb;
    this._attachSocketListeners();
  }

  async _doConnect(connectOption: ConnectOption): Promise<void> {
    const client = this._client as Client;
    this._socketListenersAttached = false;
    this._networkBinding?.dispose();
    this._networkBinding = undefined;
    if (connectOption.networkInterface) {
      this._networkBinding = bindFTPNetworkInterface(client, connectOption.networkInterface);
      logger.info(`FTP via ${this._networkBinding.name} (${this._networkBinding.address})`);
    }

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
      // Implicit TLS creates its own control socket instead of using _newSocket.
      // Explicit TLS upgrades an already bound socket; PASV/EPSV use the factory.
      secureOptions: this._networkBinding ? {
        ...connectOption.secureOptions,
        localAddress: this._networkBinding.address,
        family: 4,
      } : connectOption.secureOptions as any,
    });

    this._attachSocketListeners();
    this._startKeepalive(
      connectOption.ftpKeepAliveInterval ?? connectOption.keepalive
    );
  }

  end() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = undefined;
    }
    this._client.close();
  }

  getFsClient() {
    return this._client;
  }

  private _attachSocketListeners() {
    const socket = this._client.ftp.socket;
    if (!socket || this._socketListenersAttached) {
      return;
    }

    this._socketListenersAttached = true;
    const notify = (reason: string) => {
      if (this._onDisconnectedCb) {
        this._onDisconnectedCb(reason);
      }
    };

    socket.once('end', () => notify('end'));
    socket.once('close', () => notify('close'));
    socket.once('error', () => notify('error'));
  }

  private _startKeepalive(keepalive?: number) {
    // FTP keepalive is opt-in. Some shared hosts react badly to unsolicited
    // NOOP commands, and a default timer can amplify a degraded connection.
    if (!keepalive || keepalive <= 0) {
      return;
    }

    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
    }

    this._keepaliveTimer = setInterval(() => {
      if (this._client.closed) {
        return;
      }

      // Fire-and-forget NOOP to keep the control connection alive.
      this._client.sendIgnoringError('NOOP').catch((err: unknown) => {
        logger.debug(`FTP keepalive NOOP failed: ${(err as Error).message || err}`);
      });
    }, keepalive);
    this._keepaliveTimer.unref();
  }
}
