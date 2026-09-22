const os = require('os');
const { listNetworkInterfaces, resolveNetworkInterface, hasInterfaceAddress } = require('../../src/core/networkInterface');

const ipv4 = address => ({ address, family: 'IPv4', internal: false });
afterEach(() => jest.restoreAllMocks());

test('lists named IPv4 adapters without loopback or unconfigured link-local addresses', () => {
  jest.spyOn(os, 'networkInterfaces').mockReturnValue({
    Ethernet: [ipv4('192.168.1.20'), ipv4('192.168.1.20')],
    WiFi: [ipv4('169.254.1.2')],
    tun0: [ipv4('10.0.0.1')],
    loopback: [{ ...ipv4('127.0.0.1'), internal: true }],
    IPv6: [{ address: '::1', family: 'IPv6', internal: false }],
  });
  expect(listNetworkInterfaces()).toEqual([
    { name: 'Ethernet', addresses: ['192.168.1.20'] },
    { name: 'tun0', addresses: ['10.0.0.1'] },
  ]);
  expect(resolveNetworkInterface('Ethernet')).toBe('192.168.1.20');
  expect(() => resolveNetworkInterface('Missing')).toThrow('unavailable');
});

test('resolves DHCP changes on reconnect and invalidates the previous address', () => {
  const snapshot = jest.spyOn(os, 'networkInterfaces').mockReturnValue({ Ethernet: [ipv4('192.168.1.20')] });
  expect(resolveNetworkInterface('Ethernet')).toBe('192.168.1.20');
  snapshot.mockReturnValue({ Ethernet: [ipv4('192.168.1.21')] });
  expect(hasInterfaceAddress('Ethernet', '192.168.1.20')).toBe(false);
  expect(resolveNetworkInterface('Ethernet')).toBe('192.168.1.21');
  snapshot.mockReturnValue({});
  expect(hasInterfaceAddress('Ethernet', '192.168.1.21')).toBe(false);
  expect(() => resolveNetworkInterface('Ethernet')).toThrow('unavailable');
});
