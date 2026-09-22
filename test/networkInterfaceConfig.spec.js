const { getFTPConfigTargets, setNetworkInterface } = require('../src/modules/networkInterfaceConfig');

test('targets FTP entries and inherited FTP profiles in a multi-connection config', () => {
  const text = JSON.stringify([
    { name: 'Site', protocol: 'ftp', host: 'host', networkInterface: 'Ethernet', profiles: {
      dev: {}, ssh: { protocol: 'sftp' }, system: { networkInterface: null },
    } },
    { protocol: 'sftp', profiles: { legacy: { protocol: 'ftp' } } },
  ]);
  const targets = getFTPConfigTargets(text);
  expect(targets.map(t => t.path)).toEqual([[0], [0, 'profiles', 'dev'], [0, 'profiles', 'system'], [1, 'profiles', 'legacy']]);
  expect(targets[1].networkInterface).toBe('Ethernet');
  expect(targets[2].networkInterface).toBeNull();
  const updated = JSON.parse(setNetworkInterface(text, targets[1]));
  expect(updated[0].profiles.dev.networkInterface).toBeNull();
  expect(updated[0].networkInterface).toBe('Ethernet');
  expect(updated[1].profiles.legacy).toEqual({ protocol: 'ftp' });
});

test('edits only the selected property and preserves credentials and CRLF formatting', () => {
  const text = '{\r\n  "protocol": "ftp",\r\n  "password": "unchanged",\r\n  "networkInterface": "Wi-Fi"\r\n}\r\n';
  const target = getFTPConfigTargets(text)[0];
  const updated = setNetworkInterface(text, target, 'Ethernet');
  expect(updated).toBe(text.replace('Wi-Fi', 'Ethernet'));
  const restored = JSON.parse(setNetworkInterface(updated, target));
  expect(restored).toEqual({ protocol: 'ftp', password: 'unchanged' });
});
