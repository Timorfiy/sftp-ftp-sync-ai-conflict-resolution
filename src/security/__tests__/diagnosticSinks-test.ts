const mockAppendLine = jest.fn();
const mockShowErrorMessage = jest.fn(async () => undefined);

jest.mock('vscode', () => {
  class EventEmitter {
    event = jest.fn();
    fire = jest.fn();
  }
  return {
    EventEmitter,
    ThemeIcon: class ThemeIcon {
      constructor(readonly id: string) {}
    },
    TreeItemCollapsibleState: { None: 0 },
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
  };
});

import { reportError } from '../../helper/error';
import { transferQueueProvider } from '../../modules/transferQueue';
import * as output from '../../ui/output';
import { RedactionScope } from '../redaction';

describe('diagnostic sink redaction', () => {
  beforeEach(() => {
    mockAppendLine.mockClear();
    mockShowErrorMessage.mockClear();
  });

  test('redacts logger/output arguments and Error stacks', () => {
    const scope = new RedactionScope();
    scope.register('output-password-canary');
    scope.register('output-answer-canary');

    const error = new Error('SFTP failed with output-answer-canary');
    error.stack =
      'Error: SFTP failed with output-answer-canary\n    at stable-stack';
    output.print(
      '[hook] stdout: output-password-canary',
      {
        endpoint: 'example.com',
        nested: { passphrase: 'field-passphrase-canary' },
      },
      error
    );

    const line = mockAppendLine.mock.calls[0][0];
    expect(line).toMatchInlineSnapshot(`
"[hook] stdout: [REDACTED] {"endpoint":"example.com","nested":{"passphrase":"[REDACTED]"}} Error: SFTP failed with [REDACTED]
    at stable-stack"
`);
    for (const canary of [
      'output-password-canary',
      'output-answer-canary',
      'field-passphrase-canary',
    ]) {
      expect(line).not.toContain(canary);
    }
    scope.dispose();
  });

  test('redacts displayed errors while preserving the original Error', () => {
    const scope = new RedactionScope();
    const canary = 'display-password-canary';
    scope.register(canary);
    const error = new Error(`Authentication rejected ${canary}`);

    reportError(error, 'connect');

    expect(error.message).toContain(canary);
    expect(mockShowErrorMessage).toHaveBeenCalledWith(
      'Authentication was rejected: The server did not accept the configured or prompted credentials. Verify the username and credential source, then reconnect.',
      'Copy Diagnostics',
      'Troubleshoot',
      'Show Output'
    );
    expect(
      mockAppendLine.mock.calls.flat().join('\n')
    ).not.toContain(canary);
    scope.dispose();
  });

  test('redacts transfer queue tooltip data before it is retained', () => {
    jest.useFakeTimers();
    const scope = new RedactionScope();
    const canary = 'queue-passphrase-canary';
    scope.register(canary);
    const task = {
      transferType: 'upload',
      localFsPath: 'C:\\workspace\\index.js',
      cancel: jest.fn(),
    };

    const id = transferQueueProvider.add(task as any);
    transferQueueProvider.start(id);
    transferQueueProvider.done(id, new Error(`Upload failed: ${canary}`));
    const item = transferQueueProvider.getChildren().find(value => value.id === id)!;
    const treeItem = transferQueueProvider.getTreeItem(item);

    expect(treeItem.tooltip).toBe('Upload failed: [REDACTED]');
    expect(String(treeItem.tooltip)).not.toContain(canary);
    scope.dispose();
    jest.runOnlyPendingTimers();
    expect(
      transferQueueProvider.getChildren().some(value => value.id === id)
    ).toBe(true);
    transferQueueProvider.clearCompleted();
    jest.useRealTimers();
  });
});
