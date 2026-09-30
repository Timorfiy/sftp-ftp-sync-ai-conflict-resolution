const path = require('path');
const os = require('os');
jest.mock('../src/modules/serviceManager', () => ({ getAllFileService: jest.fn() }));
jest.mock('../src/commands/abstract/createCommand', () => ({ checkCommand: value => value }));
const { buildSshCommand, quotePosixArgument } = require('../src/commands/commandOpenSshConnection');

describe('SSH terminal commands', () => {
  const config = { host: 'example.test', username: 'user', port: 22 };
  test('bash/zsh quote metacharacters, Unicode and apostrophes as literal arguments', () => {
    expect(quotePosixArgument("O'Reilly $() `cmd` Привет")).toBe("'O'\"'\"'Reilly $() `cmd` Привет'");
    expect(buildSshCommand({ ...config, privateKeyPath: "~/ключ с пробелами/O'Reilly" }, false))
      .toBe(`ssh -t 'user@example.test' -p '22' -i ${quotePosixArgument(path.join(os.homedir(), "ключ с пробелами/O'Reilly"))}`);
  });
  test('agent takes precedence and custom shell parameters retain interpolation', () => {
    expect(buildSshCommand({ ...config, agent: '/tmp/socket', privateKeyPath: '/key', remotePath: '/site', sshCustomParams: '-o RemoteCommand="cd ${remotePath}"' }, false))
      .toBe('ssh -t \'user@example.test\' -p \'22\' -o RemoteCommand="cd /site"');
  });
  test('Windows keeps the existing command format', () => {
    expect(buildSshCommand({ ...config, privateKeyPath: 'C:\\keys\\file key' }, true))
      .toBe('ssh -t user@example.test -p 22 -i "C:\\keys\\file key"');
  });
});
