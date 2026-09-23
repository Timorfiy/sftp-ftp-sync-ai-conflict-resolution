const showWarningMessage = jest.fn();
const showInformationMessage = jest.fn();
const clearConflictState = jest.fn();

jest.mock('vscode', () => ({
  window: { showWarningMessage },
}));

jest.mock('../../host', () => ({
  getWorkspaceFolders: jest.fn(() => [
    { uri: { fsPath: 'C:\\workspace-one' } },
    { uri: { fsPath: 'C:\\workspace-two' } },
  ]),
  showInformationMessage,
}));

jest.mock('../../fileHandlers/transfer/conflictBridge', () => ({
  clearConflictState,
}));

jest.mock('../abstract/createCommand', () => ({
  checkCommand: (value: unknown) => value,
}));

import command from '../commandClearConflictState';

describe('clear conflict state command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('cancel performs no state write', async () => {
    showWarningMessage.mockResolvedValue(undefined);

    await (command.handleCommand as any)();

    expect(clearConflictState).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  test('confirmed clear covers all open roots and reports retained active decisions', async () => {
    showWarningMessage.mockResolvedValue('Clear Conflict State');
    clearConflictState.mockResolvedValue({
      clearedRecords: 3,
      retainedActiveRecords: 2,
      clearedBytes: 2048,
      legacyRootsCleared: 1,
    });

    await (command.handleCommand as any)();

    expect(clearConflictState).toHaveBeenCalledWith([
      'C:\\workspace-one',
      'C:\\workspace-two',
    ]);
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('preserved 2 active decision')
    );
  });
});
