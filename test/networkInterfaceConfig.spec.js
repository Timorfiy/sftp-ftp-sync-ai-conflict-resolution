const { getNetworkConfigTargets, setNetworkInterface } = require('../src/modules/networkInterfaceConfig');

test('targets FTP and SFTP entries and their inherited profiles in a multi-connection config', () => {
  const text = JSON.stringify([
    { name: 'Site', protocol: 'ftp', host: 'host', networkInterface: 'Ethernet', profiles: {
      dev: {}, ssh: { protocol: 'sftp' }, system: { networkInterface: null },
    } },
    { protocol: 'sftp', profiles: { legacy: { protocol: 'ftp' } } },
  ]);
  const targets = getNetworkConfigTargets(text);
  expect(targets.map(t => t.path)).toEqual([[0], [0, 'profiles', 'dev'], [0, 'profiles', 'ssh'], [0, 'profiles', 'system'], [1], [1, 'profiles', 'legacy']]);
  expect(targets.map(t => t.protocol)).toEqual(['ftp', 'ftp', 'sftp', 'ftp', 'sftp', 'ftp']);
  expect(targets[1].networkInterface).toBe('Ethernet');
  expect(targets[3].networkInterface).toBeNull();
  const updated = JSON.parse(setNetworkInterface(text, targets[1]));
  expect(updated[0].profiles.dev.networkInterface).toBeNull();
  expect(updated[0].networkInterface).toBe('Ethernet');
  expect(updated[1].profiles.legacy).toEqual({ protocol: 'ftp' });
});

test('edits only the selected property and preserves credentials and CRLF formatting', () => {
  const text = '{\r\n  "protocol": "ftp",\r\n  "password": "unchanged",\r\n  "networkInterface": "Wi-Fi"\r\n}\r\n';
  const target = getNetworkConfigTargets(text)[0];
  const updated = setNetworkInterface(text, target, 'Ethernet');
  expect(updated).toBe(text.replace('Wi-Fi', 'Ethernet'));
  const restored = JSON.parse(setNetworkInterface(updated, target));
  expect(restored).toEqual({ protocol: 'ftp', password: 'unchanged' });
});

test('default SFTP and inherited SFTP profiles can select an adapter or disable inheritance', () => {
  const text = JSON.stringify({ host: 'host', networkInterface: 'Ethernet', profiles: {
    dev: {}, local: { protocol: 'local' },
  } });
  const targets = getNetworkConfigTargets(text);
  expect(targets.map(target => target.path)).toEqual([[], ['profiles', 'dev']]);
  expect(targets.every(target => target.protocol === 'sftp')).toBe(true);
  expect(targets[1].networkInterface).toBe('Ethernet');
  const updated = JSON.parse(setNetworkInterface(text, targets[1]));
  expect(updated.profiles.dev.networkInterface).toBeNull();
  expect(updated.networkInterface).toBe('Ethernet');
  expect(JSON.parse(setNetworkInterface(text, targets[0], 'Wi-Fi')).networkInterface).toBe('Wi-Fi');
});
