const EventEmitter = require('node:events');
class TestUri {
  static parse(text) {
    const parsed = new URL(text);
    return Object.assign(new TestUri(), { scheme: parsed.protocol.slice(0, -1), authority: parsed.host,
      path: decodeURIComponent(parsed.pathname), query: decodeURIComponent(parsed.search.slice(1)) });
  }
  static file(file) { return TestUri.parse(`file:///${file.replace(/\\/g, '/')}`); }
  get fsPath() { return this.path; }
  with(changes) { return Object.assign(new TestUri(), this, changes); }
  toString() { return `${this.scheme}://${this.authority}${this.path}?${encodeURIComponent(this.query)}`; }
}
const registered = new Map();
let selection = [];
let services = [];
const showErrorMessage = jest.fn(async () => undefined);
const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), trace: jest.fn() };

jest.mock('vscode', () => ({
  Uri: TestUri,
  EventEmitter: class {
    constructor() {
      const emitter = new EventEmitter();
      this.fire = value => emitter.emit('change', value);
      this.event = fn => { emitter.on('change', fn); return { dispose: () => emitter.off('change', fn) }; };
    }
  },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  workspace: { registerTextDocumentContentProvider: jest.fn(() => ({ dispose() {} })) },
  window: {
    showErrorMessage,
    showWarningMessage: jest.fn(async () => undefined),
    showInformationMessage: jest.fn(async () => undefined),
    createTreeView: jest.fn(() => ({ selection, reveal: jest.fn(), dispose() {} })),
  },
  env: { clipboard: { writeText: jest.fn() } },
  commands: { executeCommand: jest.fn() },
}));
jest.mock('../src/host', () => ({
  showTextDocument: jest.fn(),
  registerCommand: (_context, id, callback) => registered.set(id, callback),
  setContextValue: jest.fn(),
}));
jest.mock('../src/logger', () => ({ __esModule: true, default: logger }));
jest.mock('../src/ui/output', () => ({ show: jest.fn() }));
jest.mock('../src/modules/serviceManager', () => ({
  getAllFileService: () => services,
  getFileService: jest.fn(),
}));
jest.mock('../src/modules/ext', () => ({ getExtensionSetting: () => ({}) }));
jest.mock('../src/modules/remoteExplorer/dragAndDrop', () => ({ __esModule: true, default: class {} }));
jest.mock('../src/helper', () => ({
  ...jest.requireActual('../src/helper/paths'),
  reportError: (...args) => require('../src/errors').reportActionableError(...args),
}));
jest.mock('../src/core', () => ({
  upath: require('../src/core/upath').default,
  UResource: require('../src/core/uResource').default,
  FileType: { File: 0, Directory: 1 },
  Ignore: class { ignores() { return false; } },
}));

const { UResource } = require('../src/core');
const Tree = require('../src/modules/remoteExplorer/treeDataProvider').default;
const Explorer = require('../src/modules/remoteExplorer/explorer').default;
const { COMMAND_REMOTEEXPLORER_REFRESH } = require('../src/constants');
const { RedactionScope } = require('../src/security/redaction');

function service(id = 1, protocol = 'ftp') {
  const config = { name: 'Fixture', protocol, host: '127.0.0.1', port: 12345,
    remotePath: '/', remoteExplorer: { order: 0 }, backup: { enabled: false } };
  const remote = { list: jest.fn(async () => [{ fspath: '/folder', type: 1 }]) };
  return { id, name: 'Fixture', getConfig: () => config, remote,
    getRemoteFileSystem: jest.fn(async () => remote) };
}
function item(id = 1, fsPath = '/folder/file.txt', isDirectory = false) {
  return { resource: UResource.makeResource({ remote: { host: '127.0.0.1', port: 12345 }, remoteId: id, fsPath }), isDirectory };
}

beforeEach(() => {
  jest.clearAllMocks(); registered.clear(); selection = []; services = [service()];
  showErrorMessage.mockResolvedValue(undefined);
});

test.each([
  ['ftp', Object.assign(new Error('550 Permission denied'), { code: 550 }), 'Permission was denied'],
  ['sftp', Object.assign(new Error('Permission denied: /folder'), { code: 3 }), 'Permission was denied'],
  ['ftp', Object.assign(new Error('Connection closed'), { code: 'ECONNRESET' }), 'Server could not be reached'],
  ['sftp', Object.assign(new Error('No such file'), { code: 'ENOENT' }), 'Remote path is unavailable'],
])('%s failed tree read is actionable and explicitly marked, then recovers', async (protocol, error, title) => {
  services = [service(1, protocol)];
  const tree = new Tree();
  const [root] = await tree.getChildren();
  const [folder] = await tree.getChildren(root);
  services[0].remote.list.mockRejectedValue(error);
  const events = [];
  tree.onDidChangeTreeData(value => events.push(value));
  await expect(tree.getChildren(folder)).resolves.toEqual([]);
  expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining(title),
    'Retry', 'Open Config', 'Copy Diagnostics', 'Troubleshoot', 'Show Output');
  expect(tree.getTreeItem(folder)).toMatchObject({
    iconPath: { id: 'error' }, description: `Read failed: ${title}`,
    tooltip: expect.stringContaining('Refresh this folder'),
  });
  const count = services[0].remote.list.mock.calls.length;
  await tree.getChildren(folder);
  expect(services[0].remote.list).toHaveBeenCalledTimes(count);
  expect(showErrorMessage).toHaveBeenCalledTimes(1);
  expect(events).toEqual([folder]);
  services[0].remote.list.mockResolvedValue([{ fspath: '/folder/restored.txt', type: 0 }]);
  await tree.refresh(folder);
  expect(services[0].remote.list).toHaveBeenCalledTimes(count); // notification only, no duplicate I/O
  const children = await tree.getChildren(folder);
  expect(children[0].resource.fsPath).toBe('/folder/restored.txt');
  expect(tree.getTreeItem(folder).description).toBeUndefined();
});

test('listing does not hang waiting for the user to choose a notification action', async () => {
  const tree = new Tree();
  const [root] = await tree.getChildren();
  showErrorMessage.mockImplementation(() => new Promise(() => {}));
  services[0].getRemoteFileSystem.mockRejectedValue(new Error('Authentication failed'));
  await expect(tree.getChildren(root)).resolves.toEqual([]);
  expect(tree.getTreeItem(root).description).toContain('failed');
});

test('tree diagnostics and tooltip redact registered credential values', async () => {
  const scope = new RedactionScope();
  scope.register('TREE_PASSWORD_CANARY');
  try {
    const tree = new Tree();
    const [root] = await tree.getChildren();
    services[0].remote.list.mockRejectedValue(new Error('Permission denied TREE_PASSWORD_CANARY'));
    await tree.getChildren(root);
    expect(JSON.stringify(showErrorMessage.mock.calls)).not.toContain('TREE_PASSWORD_CANARY');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('TREE_PASSWORD_CANARY');
    expect(tree.getTreeItem(root).tooltip).not.toContain('TREE_PASSWORD_CANARY');
  } finally { scope.dispose(); }
});

test('first hidden upload resolves parents locally without listing or missing-root rejection', async () => {
  const tree = new Tree();
  const changed = [];
  tree.onDidChangeTreeData(value => changed.push(value));
  await tree.refresh(item());
  expect(changed[0].resource.fsPath).toBe('/folder');
  expect(services[0].getRemoteFileSystem).not.toHaveBeenCalled();
  expect(showErrorMessage).not.toHaveBeenCalled();
  const [root] = await tree.getChildren();
  await expect(tree.getParent(root)).resolves.toBeUndefined();
});

test('hidden config replacement cancels stale nodes and initializes new roots', async () => {
  const tree = new Tree();
  const [oldRoot] = await tree.getChildren();
  services = [service(2)];
  await tree.refresh();
  await expect(tree.getParent(item(1))).resolves.toBeUndefined();
  await expect(tree.getChildren(oldRoot)).resolves.toEqual([]);
  await expect(tree.refresh(item(1))).resolves.toBeUndefined();
  await tree.refresh(item(2));
  expect(services[0].getRemoteFileSystem).not.toHaveBeenCalled();
  expect(showErrorMessage).not.toHaveBeenCalled();
});

test('a rejected read from a retired root does not report against a replacement config', async () => {
  const tree = new Tree();
  const [root] = await tree.getChildren();
  let reject;
  services[0].remote.list.mockImplementation(() => new Promise((_resolve, failure) => { reject = failure; }));
  const pending = tree.getChildren(root);
  await Promise.resolve();
  services = [service(2)];
  await tree.refresh();
  reject(new Error('Permission denied'));
  await expect(pending).resolves.toEqual([]);
  expect(showErrorMessage).not.toHaveBeenCalled();
});

test('a successful read from a retired root cannot repopulate the replacement cache', async () => {
  const tree = new Tree();
  const [root] = await tree.getChildren();
  let resolve;
  services[0].remote.list.mockImplementation(() => new Promise(success => { resolve = success; }));
  const pending = tree.getChildren(root);
  await Promise.resolve();
  services = [service(2)];
  await tree.refresh();
  resolve([{ fspath: '/old.txt', type: 0 }]);
  await expect(pending).resolves.toEqual([]);
  const [replacement] = await tree.getChildren();
  expect(replacement.resource.remoteId).toBe(2);
});

test('refresh command awaits selected refresh completion and observes rejection', async () => {
  selection = [item()];
  const spy = jest.spyOn(Tree.prototype, 'refresh');
  let reject;
  spy.mockImplementation(() => new Promise((_resolve, failure) => { reject = failure; }));
  try {
    new Explorer({ subscriptions: [] });
    const command = registered.get(COMMAND_REMOTEEXPLORER_REFRESH);
    let done = false;
    const pending = command().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    reject(new Error('Permission denied'));
    await pending;
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Permission was denied'),
      'Open Config', 'Copy Diagnostics', 'Troubleshoot', 'Show Output');
  } finally { spy.mockRestore(); }
});
