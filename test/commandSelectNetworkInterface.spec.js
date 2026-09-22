jest.mock('../src/commands/abstract/createCommand', () => ({ checkCommand: option => option }));
jest.mock('../src/core/networkInterface', () => ({ listNetworkInterfaces: () => [
  { name: 'Ethernet', addresses: ['192.168.1.20'] },
] }));
jest.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ name: 'Site', uri: { fsPath: '/site' } }],
    fs: { stat: jest.fn(async () => ({})) }, openTextDocument: jest.fn(), applyEdit: jest.fn(async () => true) },
  window: { showQuickPick: jest.fn(), showInformationMessage: jest.fn(), showWarningMessage: jest.fn() },
  Uri: { joinPath: (_base, path) => ({ fsPath: '/site/' + path }) },
  Range: class {},
  WorkspaceEdit: class { replace(...args) { this.replacement = args[2]; } },
}));
const vscode = require('vscode');
const command = require('../src/commands/commandSelectNetworkInterface').default;
let document;
beforeEach(() => {
  jest.clearAllMocks();
  document = { version: 1, isDirty: false, uri: {},
    getText: () => '{"protocol":"ftp","password":"preserved"}',
    positionAt: position => position, save: jest.fn(async () => true) };
  vscode.workspace.openTextDocument.mockResolvedValue(document);
});

test('saves the selected adapter through the editor without changing other fields', async () => {
  vscode.window.showQuickPick.mockImplementation(async choices => choices.find(choice => choice.value === 'Ethernet'));
  await command.handleCommand();
  const edit = vscode.workspace.applyEdit.mock.calls[0][0];
  expect(JSON.parse(edit.replacement)).toEqual({ protocol: 'ftp', password: 'preserved', networkInterface: 'Ethernet' });
  expect(document.save).toHaveBeenCalledTimes(1);
});

test('cancel does not save or modify the document', async () => {
  vscode.window.showQuickPick.mockResolvedValue(undefined);
  await command.handleCommand();
  expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  expect(document.save).not.toHaveBeenCalled();
});

test('a concurrent document edit is preserved', async () => {
  vscode.window.showQuickPick.mockImplementation(async choices => { document.version++; return choices[1]; });
  await command.handleCommand();
  expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  expect(vscode.window.showWarningMessage).toHaveBeenCalled();
});

test('unsaved configuration is not implicitly saved', async () => {
  document.isDirty = true;
  await command.handleCommand();
  expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  expect(document.save).not.toHaveBeenCalled();
});
