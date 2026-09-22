import * as os from 'os';

export interface NetworkInterfaceChoice {
  name: string;
  addresses: string[];
}

/** Use adapter names, not DHCP addresses, in saved connection profiles. */
export function listNetworkInterfaces(): NetworkInterfaceChoice[] {
  return Object.entries(os.networkInterfaces())
    .map(([name, entries]) => ({
      name,
      addresses: [...new Set((entries || [])
        .filter(entry => !entry.internal && entry.family === 'IPv4' &&
          !entry.address.startsWith('169.254.') && entry.address !== '0.0.0.0')
        .map(entry => entry.address))].sort(),
    }))
    .filter(entry => entry.addresses.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveNetworkInterface(name: string): string {
  const adapter = listNetworkInterfaces().find(entry => entry.name === name);
  if (!adapter) {
    throw new Error(`FTP network interface "${name}" is unavailable or has no usable IPv4 address. ` +
      'Reconnect it or run SFTP: Select Network Interface.');
  }
  return adapter.addresses[0];
}

export function hasInterfaceAddress(name: string, address: string): boolean {
  return listNetworkInterfaces().some(entry =>
    entry.name === name && entry.addresses.includes(address));
}
