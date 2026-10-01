const showWarningMessage = jest.fn(async (_message: string, ..._items: string[]) => undefined);
const showInformationMessage = jest.fn(async (_message: string, ..._items: string[]) => undefined);
const showActivityState = jest.fn();
const commands = new Map<string, (...args: any[]) => any>();
const view = { reveal: jest.fn(async () => undefined), dispose: jest.fn(), badge: undefined as any, description: '' };
let showSuccess = true;
jest.mock('vscode', () => ({
  EventEmitter: class { event = jest.fn(); fire = jest.fn(); dispose = jest.fn(); },
  ThemeIcon: class { constructor(readonly id: string) {} },
  TreeItemCollapsibleState: { None: 0, Expanded: 2, Collapsed: 1 },
  window: { createTreeView: jest.fn(() => view), showWarningMessage, showInformationMessage, showQuickPick: jest.fn(async () => undefined) },
  commands: { registerCommand: jest.fn((id, handler) => { commands.set(id, handler); return { dispose: jest.fn() }; }), executeCommand: jest.fn(async () => undefined) },
  workspace: { getConfiguration: jest.fn(() => ({ get: () => showSuccess })), onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })) },
}));
jest.mock('../../app', () => ({ __esModule: true, default: { state: { profile: 'production' }, sftpBarItem: { showActivityState, dispose: jest.fn() } } }));
jest.mock('../../fileHandlers/transfer/conflictBridge', () => ({ showConflictActions: jest.fn(async () => undefined) }));
jest.mock('../../errors/reporter', () => ({ showErrorDetails: jest.fn(async () => undefined) }));
jest.mock('../../logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));
import { initializeActivityUi } from '../activity';
import { activityStore, withActivityInvocation, withActivityOperation, recordActivityAction } from '../../modules/activity';
import { transferQueueProvider, ACTIVITY_OPEN, ACTIVITY_FILTER } from '../../modules/transferQueue';
import { RedactionScope } from '../../security/redaction';
import * as path from 'path';
const connection = (key = 'production') => ({ key, label: key, workspace: process.cwd(), basePath: process.cwd(), remotePath: '/site', protocol: 'sftp' });
const transfer = (name: string) => recordActivityAction('upload', path.join(process.cwd(), name), `/site/${name}`, async () => undefined);

describe('native Activity presentation', () => {
  let ui: ReturnType<typeof initializeActivityUi>;
  beforeEach(() => {
    jest.useFakeTimers(); activityStore.reset(); showWarningMessage.mockClear(); showInformationMessage.mockClear();
    showActivityState.mockClear(); view.reveal.mockClear(); showSuccess = true;
    ui = initializeActivityUi({ subscriptions: [] } as any);
  });
  afterEach(() => { ui.dispose(); activityStore.reset(); jest.clearAllTimers(); jest.useRealTimers(); });
  test('manual multi-file operation emits one summary and navigates to the same group', async () => {
    await withActivityInvocation('Upload Folder', () => withActivityOperation('upload', connection(), async () => {
      await transfer('one.txt'); await transfer('two.txt');
    }));
    expect(showInformationMessage).toHaveBeenCalledTimes(1);
    expect(showInformationMessage.mock.calls[0][0]).toContain('Uploaded 2 files');
    jest.advanceTimersByTime(100);
    expect(showActivityState.mock.calls[showActivityState.mock.calls.length - 1]?.[0]).toContain('Uploaded 2 files');
    await commands.get(ACTIVITY_OPEN)!(); expect(view.reveal).toHaveBeenCalledWith(expect.objectContaining({ type: 'group' }), expect.any(Object));
    jest.advanceTimersByTime(4200); expect(showActivityState.mock.calls[showActivityState.mock.calls.length - 1]?.[0]).toBe('SFTP: production');
  });
  test('success setting mutes manual success only; automatic saves stay quiet', async () => {
    showSuccess = false;
    await withActivityInvocation('Upload', () => withActivityOperation('upload', connection(), () => transfer('muted.txt')));
    expect(showInformationMessage).not.toHaveBeenCalled();
  });
  test('repeated background failures notify once, a healthy operation resets the episode', async () => {
    const { withActivityOrigin } = await import('../../modules/activity');
    const fail = () => withActivityOrigin('watcher', () => withActivityOperation('upload', connection(), async () => { throw new Error('socket closed'); }));
    await expect(fail()).rejects.toThrow('socket closed');
    await expect(fail()).rejects.toThrow('socket closed');
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    await withActivityOrigin('save', () => withActivityOperation('upload', connection(), () => transfer('healthy.txt')));
    expect(showInformationMessage).not.toHaveBeenCalled();
    await expect(fail()).rejects.toThrow('socket closed'); expect(showWarningMessage).toHaveBeenCalledTimes(2);
  });
  test('badge counts a file once for multiple warnings and clears with terminal history', async () => {
    await withActivityOperation('upload', connection(), async () => {
      await transfer('warning.txt');
      const group = [...activityStore.groups.values()][0];
      const item = [...group.items.values()][0];
      activityStore.update(item, { warnings: ['backup unavailable', 'second warning'] });
    });
    jest.advanceTimersByTime(100); expect(view.badge.value).toBe(1);
    transferQueueProvider.clearCompleted(); jest.advanceTimersByTime(100); expect(view.badge).toBeUndefined();
  });
  test('conflict review uses a warning and does not create an automatic action picker', () => {
    activityStore.registerConflict({ id: 'conflict-one', status: 'pending', revision: 1 }, path.join(process.cwd(), 'one.txt'), '/site/one.txt', process.cwd());
    activityStore.registerConflict({ id: 'conflict-two', status: 'pending', revision: 1 }, path.join(process.cwd(), 'two.txt'), '/site/two.txt', process.cwd());
    jest.advanceTimersByTime(100);
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(showActivityState.mock.calls[showActivityState.mock.calls.length - 1]?.[0]).toContain('2 conflicts');
    expect(view.badge.value).toBe(2);
  });
  test('native filters and labels use relative paths and redact tooltips', async () => {
    const secrets = new RedactionScope(); secrets.register('tooltip-secret');
    await withActivityOperation('upload', connection(), async () => {
      await transfer(path.join('folder', 'safe.txt'));
      const group = [...activityStore.groups.values()][0];
      const item = [...group.items.values()][0];
      activityStore.update(item, { warnings: ['tooltip-secret'] });
    });
    transferQueueProvider.setFilter('Needs Attention');
    const group = transferQueueProvider.getChildren()[0]; const item = transferQueueProvider.getChildren(group)[0];
    const tree = transferQueueProvider.getTreeItem(item);
    expect(tree.label).toBe('safe.txt'); expect(tree.description).toContain('folder'); expect(String(tree.tooltip)).not.toContain('tooltip-secret');
    expect(commands.has(ACTIVITY_FILTER)).toBe(true); secrets.dispose();
  });
});
