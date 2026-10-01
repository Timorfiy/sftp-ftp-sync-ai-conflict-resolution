import * as vscode from 'vscode';
import app from '../app';
import { activityStore, ActivityGroup, activityCounts, activityResultMessage, groupIsActive,
  groupAttentionCount, relativeActivityPath } from '../modules/activity';
import { ACTIVITY_OPEN, ACTIVITY_DETAILS, ACTIVITY_FILTER, ACTIVITY_CANCEL, QueueItem, transferQueueProvider } from '../modules/transferQueue';
import { showConflictActions } from '../fileHandlers/transfer/conflictBridge';
import { showErrorDetails } from '../errors/reporter';
import { redactText } from '../security/redaction';
import logger from '../logger';

export function initializeActivityUi(context: vscode.ExtensionContext): vscode.Disposable {
  const view = vscode.window.createTreeView('transferQueue', { treeDataProvider: transferQueueProvider });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let successUntil = 0;
  let lastSuccess: ActivityGroup | undefined;
  const episodes = new Set<string>();
  const announcedConflicts = new Set<string>();
  const disposables: vscode.Disposable[] = [view];
  const open = async (id?: string, issues = false) => {
    transferQueueProvider.setFilter(issues ? 'Needs Attention' : 'All');
    const groups = [...activityStore.groups.values()];
    const group = id ? activityStore.groups.get(id) : groups.find(candidate => groupAttentionCount(candidate) > 0)
      || groups.find(groupIsActive) || groups[groups.length - 1];
    if (group) await view.reveal({ id: group.id, type: 'group', group }, { select: true, focus: true, expand: true });
    else await vscode.commands.executeCommand('transferQueue.focus');
  };
  const notify = async (group: ActivityGroup) => {
    const counts = activityCounts(group);
    const message = activityResultMessage(group);
    let choice: string | undefined;
    if (counts.issues) {
      const keys = [...group.connections.keys()].map(key => `${key}:${group.issues[0]?.id || [...group.items.values()].find(item => item.error)?.error?.id || 'transfer.failed'}`);
      if (group.origin !== 'manual' && keys.every(key => episodes.has(key))) return;
      keys.forEach(key => episodes.add(key));
      choice = await vscode.window.showWarningMessage(message, 'View Issues');
    } else {
      for (const key of [...episodes]) if ([...group.connections.keys()].some(connection => key.startsWith(`${connection}:`))) episodes.delete(key);
      if (group.origin !== 'manual') return;
      if (!group.cancelRequested && counts.cancelled === 0 && !vscode.workspace.getConfiguration('sftp.notifications').get('showSuccess', true)) return;
      choice = await vscode.window.showInformationMessage(message, 'Open Activity');
    }
    if (choice) await open(group.id, counts.issues > 0);
  };
  const render = () => {
    const groups = [...activityStore.groups.values()];
    const active = groups.filter(groupIsActive);
    const conflicts = groups.reduce((sum, group) => sum + activityCounts(group).conflicts, 0);
    const issues = groups.reduce((sum, group) => sum + groupAttentionCount(group), 0);
    view.badge = issues ? { value: issues, tooltip: `${issues} files or operations need attention` } : undefined;
    view.description = transferQueueProvider.filter;
    let text = app.state.profile ? `SFTP: ${app.state.profile}` : 'SFTP';
    let tooltip = 'Open SFTP/FTP Activity';
    if (conflicts) text = `$(warning) ${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'}`;
    else if (active.length > 1) text = `$(sync~spin) ${active.length} operations`;
    else if (active.length === 1) {
      const group = active[0];
      const counts = activityCounts(group);
      const label = [...group.connections.values()].map(connection => connection.label).join(', ');
      const downloading = [...group.items.values()].some(item => item.kind === 'download') && ![...group.items.values()].some(item => item.kind === 'upload');
      const uploading = [...group.items.values()].some(item => item.kind === 'upload') && !downloading;
      text = group.preparing > 0 ? `$(sync~spin) Preparing ${downloading ? 'download' : uploading ? 'upload' : 'transfer'} · ${label}`
        : `$(sync~spin) ${downloading ? 'Downloading' : uploading ? 'Uploading' : 'Transferring'} ${counts.completed}/${counts.total} · ${label}`;
      tooltip = [group.label, label, `${counts.completed}/${counts.total} files`,
        [...group.items.values()].find(item => item.status === 'running')?.localPath].filter(Boolean).join('\n');
    } else if (issues) text = `$(warning) ${issues} ${issues === 1 ? 'issue' : 'issues'}`;
    else if (lastSuccess && Date.now() < successUntil) text = `$(${lastSuccess.cancelRequested || activityCounts(lastSuccess).cancelled ? 'close' : 'check'}) ${activityResultMessage(lastSuccess)}`;
    app.sftpBarItem.showActivityState(redactText(text), redactText(tooltip), ACTIVITY_OPEN);
    for (const group of groups) if (activityCounts(group).conflicts && !announcedConflicts.has(group.id)) {
      announcedConflicts.add(group.id);
      void vscode.window.showWarningMessage(`Upload paused: files in ${[...group.connections.values()].map(connection => connection.label).join(', ')} need conflict review.`, 'Review Conflicts')
        .then(choice => choice ? open(group.id, true) : undefined);
    }
  };
  const schedule = () => {
    if (!timer) { timer = setTimeout(() => { timer = undefined; render(); }, 100); timer.unref?.(); }
  };
  const unsubscribe = activityStore.onChange(schedule);
  const finish = activityStore.onFinish(group => {
    if (!activityCounts(group).issues) {
      lastSuccess = group; successUntil = Date.now() + 4000;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(schedule, 4000); resetTimer.unref?.();
    }
    void notify(group).catch(error => logger.warn(redactText(String(error)), 'Activity notification'));
  });
  disposables.push(vscode.commands.registerCommand(ACTIVITY_OPEN, (id?: string) => open(id)));
  disposables.push(vscode.commands.registerCommand(ACTIVITY_CANCEL, (node: QueueItem) => {
    if (node.type === 'group' || node.type === 'connection') activityStore.cancel(node.group.id);
  }));
  disposables.push(vscode.commands.registerCommand(ACTIVITY_FILTER, async () => {
    const choice = await vscode.window.showQuickPick(['All', 'Active', 'Needs Attention'], { title: 'Filter Activity' });
    if (choice) { transferQueueProvider.setFilter(choice as 'All' | 'Active' | 'Needs Attention'); render(); }
  }));
  disposables.push(vscode.commands.registerCommand(ACTIVITY_DETAILS, async (node: QueueItem) => {
    if (node.type === 'item') {
      const item = node.item;
      if (item.conflict) await showConflictActions(item.conflict.id);
      else if (item.error) await showErrorDetails(item.error, { operation: redactText(`${item.connection.label} · ${relativeActivityPath(item)}`) });
      else {
        const choice = await vscode.window.showQuickPick([{ label: item.connection.label, description: item.kind },
          { label: redactText(relativeActivityPath(item)), description: `${item.status} · ${item.attempts} attempts` },
          { label: 'Show Output', description: [...item.warnings].join('; ') }], { title: 'Transfer Details' });
        if (choice?.label === 'Show Output') await vscode.commands.executeCommand('sftpSyncAI.toggleOutputPanel');
      }
    } else if (node.type === 'issue') {
      const issue = node.group.issues[node.index];
      const connection = node.group.issueConnections.get(issue);
      await showErrorDetails(issue, { ...node.group.issueContexts.get(issue), operation: connection?.label });
    }
  }));
  disposables.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('sftp.notifications')) render(); }));
  render();
  const disposable = { dispose() {
    unsubscribe(); finish(); if (timer) clearTimeout(timer); if (resetTimer) clearTimeout(resetTimer);
    disposables.forEach(item => item.dispose());
    transferQueueProvider.dispose();
    app.sftpBarItem.dispose();
  } };
  context.subscriptions.push(disposable);
  return disposable;
}
