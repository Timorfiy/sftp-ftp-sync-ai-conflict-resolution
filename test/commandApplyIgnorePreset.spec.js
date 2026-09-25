jest.mock('../src/commands/abstract/createCommand', () => ({ checkCommand: option => option }));
jest.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ name: 'Site', uri: { fsPath: '/site' } }],
    fs: { stat: jest.fn() }, openTextDocument: jest.fn(), applyEdit: jest.fn(),
  },
  window: { showQuickPick: jest.fn(), showInformationMessage: jest.fn(), showWarningMessage: jest.fn(), showTextDocument: jest.fn() },
  Uri: { joinPath: (base, path) => ({ fsPath: base.fsPath + '/' + path }) },
  Range: class {},
  WorkspaceEdit: class { replace(_uri, _range, text) { this.replacement = text; } },
}));
const vscode = require('vscode');
const command = require('../src/commands/commandApplyIgnorePreset').default;
let document;
beforeEach(() => {
  jest.resetAllMocks();
  document = { version: 1, isDirty: false, uri: {},
    getText: () => '{"protocol":"ftp","password":"preserved","ignore":["custom"]}',
    positionAt: position => position, save: jest.fn(async () => true) };
  vscode.workspace.openTextDocument.mockResolvedValue(document);
  vscode.workspace.fs.stat.mockResolvedValue({});
  vscode.workspace.applyEdit.mockResolvedValue(true);
  vscode.window.showQuickPick.mockImplementation(async choices => choices.find(choice => choice.label === 'Bitrix'));
});

test('saves the selected template and opens the configuration for review', async () => {
  await command.handleCommand();
  const result = JSON.parse(vscode.workspace.applyEdit.mock.calls[0][0].replacement);
  expect(result).toMatchObject({ protocol: 'ftp', password: 'preserved' });
  expect(result.ignore).toEqual(expect.arrayContaining(['custom', '/bitrix', '/upload']));
  expect(document.save).toHaveBeenCalledTimes(1);
  expect(vscode.window.showTextDocument).toHaveBeenCalledWith(document);
});

test('supports choosing a profile from an array of connections', async () => {
  document.getText = () => '[{"protocol":"ftp"},{"protocol":"sftp","profiles":{"dev":{}}}]';
  vscode.window.showQuickPick.mockImplementationOnce(async choices => choices.find(choice => choice.target?.path.includes('dev')));
  await command.handleCommand();
  const result = JSON.parse(vscode.workspace.applyEdit.mock.calls[0][0].replacement);
  expect(result[0]).toEqual({ protocol: 'ftp' });
  expect(result[1].ignore).toBeUndefined();
  expect(result[1].profiles.dev.ignore).toContain('/bitrix');
});

test('cancel changes nothing', async () => {
  vscode.window.showQuickPick.mockResolvedValue(undefined);
  await command.handleCommand();
  expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  expect(document.save).not.toHaveBeenCalled();
});

test('does not overwrite a concurrent editor change', async () => {
  vscode.window.showQuickPick.mockImplementation(async choices => { document.version++; return choices[0]; });
  await command.handleCommand();
  expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  expect(vscode.window.showWarningMessage).toHaveBeenCalled();
});

test('does not save unrelated unsaved changes', async () => {
  document.isDirty = true;
  await command.handleCommand();
  expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  expect(document.save).not.toHaveBeenCalled();
});

test('missing configuration offers setup without editing anything', async () => {
  vscode.workspace.fs.stat.mockRejectedValue({ code: 'FileNotFound' });
  await command.handleCommand();
  expect(vscode.workspace.applyEdit).not.toHaveBeenCalled();
  expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('SFTP: Config'));
});

test.each(['apply', 'save'])('reports a failed %s without announcing success', async stage => {
  if (stage === 'apply') vscode.workspace.applyEdit.mockResolvedValue(false);
  else document.save.mockResolvedValue(false);
  await expect(command.handleCommand()).rejects.toThrow('Could not save');
  expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
});
