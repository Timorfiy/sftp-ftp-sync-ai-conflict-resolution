const showErrorMessage = jest.fn();
const showWarningMessage = jest.fn();
const showInformationMessage = jest.fn();
const executeCommand = jest.fn(async () => undefined);
const registerCommand = jest.fn(() => ({ dispose: jest.fn() }));
const writeText = jest.fn(async () => undefined);

jest.mock('vscode', () => ({
  EventEmitter: class EventEmitter {
    event = jest.fn();
    fire = jest.fn();
  },
  ThemeIcon: class ThemeIcon {
    constructor(readonly id: string) {}
  },
  TreeItemCollapsibleState: { None: 0 },
  StatusBarAlignment: { Left: 1 },
  window: {
    createOutputChannel: jest.fn(() => ({
      show: jest.fn(),
      hide: jest.fn(),
      appendLine: jest.fn(),
    })),
    createStatusBarItem: jest.fn(() => ({
      show: jest.fn(),
      hide: jest.fn(),
    })),
    showErrorMessage,
    showWarningMessage,
    showInformationMessage,
  },
  workspace: {
    getConfiguration: jest.fn(() => ({
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    })),
  },
  commands: {
    executeCommand,
    registerCommand,
  },
  env: {
    clipboard: { writeText },
  },
  Uri: {
    file: jest.fn((fsPath: string) => ({
      fsPath,
      with(change: { fragment?: string }) {
        return { fsPath, fragment: change.fragment };
      },
    })),
  },
}));

import { RedactionScope } from '../../security/redaction';
import {
  initializeErrorReporter,
  reportActionableError,
} from '../reporter';

describe('actionable error reporter', () => {
  beforeEach(() => {
    showErrorMessage.mockReset();
    showWarningMessage.mockReset();
    showInformationMessage.mockReset();
    executeCommand.mockClear();
    registerCommand.mockClear();
    writeText.mockClear();
  });

  test('copies only redacted allowlisted diagnostics', async () => {
    const scope = new RedactionScope();
    scope.register('copy-password-canary');
    showErrorMessage.mockResolvedValue('Copy Diagnostics');

    await reportActionableError(
      Object.assign(new Error('Login incorrect copy-password-canary'), {
        code: 530,
        password: 'object-password-canary',
      }),
      { operation: 'connect', protocol: 'ftp' }
    );

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = (writeText.mock.calls as unknown as string[][])[0][0];
    expect(copied).toContain('"failureId": "authentication.rejected"');
    expect(copied).not.toContain('copy-password-canary');
    expect(copied).not.toContain('object-password-canary');
    expect(copied).not.toContain('stack');
    scope.dispose();
  });

  test('runs a supplied retry only for a safely replayable operation', async () => {
    const retry = jest.fn(async () => undefined);
    showErrorMessage.mockResolvedValue('Retry');

    await reportActionableError(
      Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' }),
      { operation: 'list remote directory', retry }
    );

    expect(showErrorMessage.mock.calls[0]).toContain('Retry');
    expect(retry).toHaveBeenCalledTimes(1);

    showErrorMessage.mockReset();
    showErrorMessage.mockResolvedValue(undefined);
    await reportActionableError(new Error('upload stream failed'), {
      operation: 'upload',
      retry,
      retrySafety: 'unsafe',
    });
    expect(showErrorMessage.mock.calls[0]).not.toContain('Retry');
  });

  test('opens the exact bundled troubleshooting section', async () => {
    const context = {
      extensionPath: 'C:\\extension',
      subscriptions: [],
    } as any;
    initializeErrorReporter(context);
    showErrorMessage.mockResolvedValue('Troubleshoot');

    await reportActionableError(
      Object.assign(new Error('Login incorrect'), { code: 530 }),
      { protocol: 'sftp' }
    );

    expect(registerCommand).toHaveBeenCalledWith(
      'sftpSyncAI.openTroubleshooting',
      expect.any(Function)
    );
    expect(executeCommand).toHaveBeenCalledWith(
      'markdown.showPreview',
      expect.objectContaining({
        fsPath: expect.stringMatching(/docs[\\/]troubleshooting\.md$/),
        fragment: 'authentication',
      })
    );
  });
});
