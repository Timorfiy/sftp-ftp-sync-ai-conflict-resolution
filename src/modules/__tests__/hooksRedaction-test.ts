const mockAppendLine = jest.fn();
const mockShowErrorMessage = jest.fn(async () => undefined);
let mockStdout = '';
let mockStderr = '';
let mockExecError: Error | null = null;

jest.mock('child_process', () => ({
  exec: jest.fn(
    (
      _command: string,
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(mockExecError, mockStdout, mockStderr);
      return {};
    }
  ),
}));

jest.mock('vscode', () => ({
  StatusBarAlignment: { Left: 1 },
  window: {
    createOutputChannel: jest.fn(() => ({
      show: jest.fn(),
      hide: jest.fn(),
      appendLine: mockAppendLine,
    })),
    createStatusBarItem: jest.fn(() => ({
      show: jest.fn(),
      hide: jest.fn(),
    })),
    showErrorMessage: mockShowErrorMessage,
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    })),
  },
  commands: {
    executeCommand: jest.fn(async () => undefined),
  },
}));

import { runHook } from '../hooks';
import { RedactionScope } from '../../security/redaction';

const hookContext = {
  localPath: 'C:\\workspace\\index.js',
  remotePath: '/index.js',
  host: 'example.com',
  protocol: 'sftp',
};

describe('hook diagnostic redaction', () => {
  beforeEach(() => {
    mockAppendLine.mockClear();
    mockShowErrorMessage.mockClear();
    mockStdout = '';
    mockStderr = '';
    mockExecError = null;
  });

  test('redacts hook stdout and stderr at the output sink', async () => {
    const scope = new RedactionScope();
    const canary = 'hook-answer-canary-1856b7';
    scope.register(canary);
    mockStdout = `stdout ${canary}`;
    mockStderr = `stderr ${canary}`;

    await runHook(
      'preUpload',
      { preUpload: 'echo hook output' },
      hookContext
    );

    const output = mockAppendLine.mock.calls.flat().join('\n');
    expect(output).toContain('[hook] stdout: stdout [REDACTED]');
    expect(output).toContain('[hook] stderr: stderr [REDACTED]');
    expect(output).not.toContain(canary);
    scope.dispose();
  });

  test('redacts hook errors in output and displayed messages', async () => {
    const scope = new RedactionScope();
    const canary = 'hook-password-canary-f03a9e';
    scope.register(canary);
    mockExecError = new Error(`command rejected ${canary}`);

    await expect(
      runHook(
        'postDownload',
        { postDownload: 'failing hook' },
        hookContext
      )
    ).rejects.toBe(mockExecError);

    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      'Hook "postDownload" failed: command rejected [REDACTED]'
    );
    expect(mockAppendLine.mock.calls.flat().join('\n')).not.toContain(canary);
    scope.dispose();
  });
});
