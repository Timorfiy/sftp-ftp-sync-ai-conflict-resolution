const { classifyWarning, logRecords } = require('./collect-warnings');

test('keeps the origin stack with its log entry', () => {
  const records = logRecords(
    '2026-09-24 18:00:00.123 [error] Error: read ENOTCONN\n' +
    '    at ChildProcess.spawn (node:child_process:5:1)\n' +
    '    at Git.getRepositoryRoot (c:/editor/extensions/git/dist/main.js:2:3)\n' +
    '2026-09-24 18:00:00.124 [error] An unknown error occurred.'
  );
  expect(records).toHaveLength(2);
  expect(classifyWarning(records[0], 'exthost.log')[0]).toBe('editor-git-process');
  expect(classifyWarning(records[1], 'renderer.log')[0]).toBe('generic-editor-error');
});

test('does not infer fixture or Git causality from ENOTCONN alone', () => {
  expect(classifyWarning('Error: read ENOTCONN', '1-sftp.log')[0]).toBe('unattributed-connection-error');
  expect(classifyWarning('Error: read ENOTCONN\n at ChildProcess.spawn', 'exthost.log')[0]).toBe('unattributed-connection-error');
});

test('explicit loopback failure and editor Git errors remain distinct', () => {
  expect(classifyWarning('[error] 426 Connection closed; transfer aborted', '1-sftp.log')[0]).toBe('fixture-protocol-failure');
  expect(classifyWarning('[error] Connection lost by fixture', '1-sftp.log')[0]).toBe('fixture-protocol-failure');
  expect(classifyWarning('[error] 426 Connection closed; transfer aborted', 'editor.log')).toBeUndefined();
});

test('root lookup error does not assert every instance follows config replacement', () => {
  const result = classifyWarning('Error: Can\'t find config for remote resource remote://fixture/file', 'exthost.log');
  expect(result[0]).toBe('extension-root-lifecycle');
  expect(result[1]).toContain('lazy/uninitialized or retired');
  expect(result[1]).toContain('does not prove config replacement');
});
