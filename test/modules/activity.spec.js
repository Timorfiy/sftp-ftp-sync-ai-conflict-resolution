const path = require('path');
const { ActivityStore, activityStore, activityCounts, groupIsActive, groupAttentionCount,
  withActivityInvocation, withActivityOperation, currentActivity, recordActivityAction,
  settleActivityChildren, relativeActivityPath } = require('../../src/modules/activity');
const { TransferOperation, TransferBatchFailure } = require('../../src/core/transferOperation');
const { localPathKey, registerLocalPathRoot } = require('../../src/helper/localPaths');
const connection = (key = 'one') => ({ key, label: key, workspace: process.cwd(), basePath: process.cwd(), remotePath: '/site', protocol: 'sftp' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const file = name => path.join(process.cwd(), name);
const task = name => ({ localFsPath: file(name), srcFsPath: file(name), targetFsPath: `/site/${name}`,
  transferType: 'local ➞ remote', fileType: 2, getWarnings: () => [], isCancelled: () => false, cancel: jest.fn() });

describe('Activity operation model', () => {
  let release;
  beforeEach(() => { activityStore.reset(); release = registerLocalPathRoot(process.cwd()); });
  afterEach(() => { activityStore.reset(); release(); });
  test('one manual invocation groups files and immutable connections until every child ends', async () => {
    const first = deferred(); const second = deferred(); const completed = [];
    const unsubscribe = activityStore.onFinish(group => completed.push(group));
    const operation = withActivityInvocation('Upload Changed Files', () => Promise.all([
      withActivityOperation('upload', connection('dev'), async () => { await first.promise; await recordActivityAction('upload', file('a.txt'), '/site/a.txt', async () => {}); }),
      withActivityOperation('upload', connection('prod'), async () => { await second.promise; await recordActivityAction('upload', file('b.txt'), '/site/b.txt', async () => {}); }),
    ]));
    const group = [...activityStore.groups.values()][0];
    expect(activityStore.groups.size).toBe(1);
    expect(group.connections.size).toBe(2);
    first.resolve(); await new Promise(done => setImmediate(done));
    expect(groupIsActive(group)).toBe(true); expect(completed).toHaveLength(0);
    second.resolve(); await operation;
    expect(completed).toHaveLength(1); expect(activityCounts(group)).toMatchObject({ total: 2, uploaded: 2, issues: 0 });
    unsubscribe();
  });
  test('retry attempts retain one logical file and ignore an obsolete callback', async () => {
    await withActivityOperation('upload', connection(), async () => {
      const operation = new TransferOperation(); const first = task('retry.txt'); const retry = task('retry.txt');
      const observations = []; operation.onChange(item => observations.push(item.status));
      operation.add(first); operation.start(first); operation.finish(first, new Error('socket closed'));
      operation.add(retry); operation.start(retry); operation.finish(first, new Error('late failure'));
      operation.finish(retry);
      expect(operation.result()).toMatchObject({ completed: 1, failed: 0 });
      expect(operation.result().items).toHaveLength(1); expect(operation.result().items[0].attempts).toBe(2);
      expect(observations).toContain('running');
    });
    expect(activityCounts([...activityStore.groups.values()][0])).toMatchObject({ total: 1, uploaded: 1 });
  });
  test('identical failures in different profiles remain separate issues', async () => {
    await withActivityInvocation('Upload All Profiles', () => Promise.all(['dev', 'prod'].map(key =>
      withActivityOperation('upload', connection(key), async () => { throw new Error('Permission denied'); }).catch(() => {}))));
    const group = [...activityStore.groups.values()][0];
    expect(group.issues).toHaveLength(2);
    expect([...group.issueConnections.values()].map(value => value.label).sort()).toEqual(['dev', 'prod']);
  });
  test('cancelled discovery cannot publish another item or report full success', async () => {
    await expect(withActivityOperation('upload', connection(), async () => {
      const group = currentActivity().group;
      await recordActivityAction('upload', file('done.txt'), '/site/done.txt', async () => {});
      activityStore.cancel(group.id);
      await recordActivityAction('upload', file('cancelled.txt'), '/site/cancelled.txt', async () => {});
    })).rejects.toThrow('cancelled');
    const group = [...activityStore.groups.values()][0];
    expect(group.cancelRequested).toBe(true); expect(activityCounts(group).uploaded).toBe(1);
    expect(group.items.size).toBe(1); expect(group.endedAt).toBeDefined();
  });
  test('background display grouping uses a quiet interval without delaying work', () => {
    let time = 100; const store = new ActivityStore(() => time);
    const first = store.begin('upload', 'watcher', connection());
    time += 900; expect(store.begin('upload', 'watcher', connection())).toBe(first);
    expect(store.begin('upload', 'watcher', connection('other'))).not.toBe(first);
    time += 1001; expect(store.begin('upload', 'watcher', connection())).not.toBe(first);
  });
  test('a user-cancelled partial batch does not become an issue', () => {
    const store = new ActivityStore(); const group = store.begin('upload', 'manual', connection());
    store.recordError(group, new TransferBatchFailure({ operationId: 'cancel', completed: 1, failed: 0,
      cancelled: 1, notStarted: 0, warnings: 0, items: [], isPartial: true }));
    expect(groupAttentionCount(group)).toBe(0);
  });
  test('operation cancellation reaches overlapping tasks even when their logical file is the same', async () => {
    await withActivityOperation('upload', connection(), async () => {
      const first = task('same.txt'); const second = task('same.txt');
      const one = new TransferOperation(); const two = new TransferOperation();
      one.add(first); one.start(first); two.add(second); two.start(second);
      activityStore.cancel(currentActivity().group.id);
      expect(first.cancel).toHaveBeenCalled(); expect(second.cancel).toHaveBeenCalled();
      one.finish(first); two.finish(second);
    });
  });
  test('a failed episode is not reused for the next healthy background operation', () => {
    const store = new ActivityStore(); const first = store.begin('upload', 'watcher', connection());
    store.recordError(first, new Error('socket closed'));
    expect(store.begin('upload', 'watcher', connection())).not.toBe(first);
  });
  test('a slow transfer completing does not extend the incoming-request grouping window', () => {
    let time = 0; const store = new ActivityStore(() => time);
    const first = store.begin('upload', 'watcher', connection());
    const item = store.discover(first, connection(), 'upload', file('slow.txt'), '/site/slow.txt');
    time = 10000; store.update(item, { status: 'completed' }); store.finish(first);
    time = 10500; expect(store.begin('upload', 'watcher', connection())).not.toBe(first);
  });
  test('retention and clearing protect pending conflicts, but clear terminal issues', () => {
    const store = new ActivityStore(); const active = store.begin('upload', 'manual', connection());
    const conflict = store.discover(active, connection(), 'upload', file('waiting.txt'), '/site/waiting.txt');
    store.update(conflict, { status: 'conflict' });
    for (let index = 0; index < 110; index++) store.finish(store.begin('upload', 'manual', connection()));
    expect(store.groups.size).toBe(101); store.clearCompleted();
    expect([...store.groups.values()]).toEqual([active]);
    store.update(conflict, { status: 'failed', warnings: ['one', 'two'] });
    expect(groupAttentionCount(active)).toBe(1); store.clearCompleted(); expect(store.groups.size).toBe(0);
  });
  test('shared path identity determines duplicates and keeps display spelling', () => {
    const store = new ActivityStore(); const group = store.begin('upload', 'manual', connection());
    const upper = store.discover(group, connection(), 'upload', file('Case.txt'), '/site/shared');
    const lower = store.discover(group, connection(), 'upload', file('case.txt'), '/site/shared');
    expect(upper === lower).toBe(localPathKey(file('Case.txt')) === localPathKey(file('case.txt')));
    expect(relativeActivityPath(upper)).toBe('Case.txt');
    expect(store.discover(group, connection('different-workspace'), 'upload', file('Case.txt'), '/site/shared')).not.toBe(upper);
  });
  test('joined traversal waits for siblings before surfacing failure', async () => {
    const sibling = deferred(); let settled = false;
    const joined = settleActivityChildren([Promise.reject(new Error('failed')), sibling.promise]);
    joined.catch(() => { settled = true; });
    await new Promise(done => setImmediate(done)); expect(settled).toBe(false);
    sibling.resolve(); await expect(joined).rejects.toThrow('failed');
  });
});
