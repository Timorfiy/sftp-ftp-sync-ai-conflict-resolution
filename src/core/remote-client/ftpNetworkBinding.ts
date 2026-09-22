import { Socket, TcpNetConnectOpts } from 'net';
import { Client } from 'basic-ftp';
import { hasInterfaceAddress, resolveNetworkInterface } from '../networkInterface';

export interface FTPNetworkBinding {
  name: string;
  address: string;
  isAvailable(): boolean;
  dispose(): void;
}

/** Instance-scoped socket factory shared by basic-ftp's control and PASV/EPSV sockets.
 * Keep basic-ftp pinned: _newSocket is an internal integration point, covered by
 * real socket transfer tests. Never patch net.Socket globally.
 */
export function bindFTPNetworkInterface(client: Client, name: string): FTPNetworkBinding {
  const address = resolveNetworkInterface(name);
  const originalFactory = client.ftp._newSocket;
  const originalFamily = client.ftp.ipFamily;
  const binding = {
    name, address, isAvailable: () => hasInterfaceAddress(name, address),
    dispose: () => {
      client.ftp._newSocket = originalFactory;
      client.ftp.ipFamily = originalFamily;
    },
  };

  class BoundSocket extends Socket {
    connect(...args: any[]): this {
      if (!binding.isAvailable()) {
        throw new Error(`FTP network interface "${name}" lost address ${address}. Reconnect to refresh it.`);
      }
      const [options, listener] = args as [TcpNetConnectOpts, (() => void) | undefined];
      if (!options || typeof options !== 'object' || !('port' in options)) {
        throw new Error('Unsupported FTP socket connection; refusing to use system routing.');
      }
      return super.connect({ ...options, localAddress: address, family: 4 }, listener);
    }
  }

  client.ftp.ipFamily = 4;
  client.ftp._newSocket = () => new BoundSocket();
  return binding;
}
