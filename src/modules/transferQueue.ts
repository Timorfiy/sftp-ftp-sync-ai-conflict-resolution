import * as vscode from 'vscode';
import * as path from 'path';
import { activityStore, ActivityGroup, ActivityItem, activityCounts, groupAttentionCount,
  groupIsActive, itemNeedsAttention, relativeActivityPath } from './activity';
import { redactText } from '../security/redaction';
import { COMMAND_ACTIVITY_OPEN, COMMAND_ACTIVITY_DETAILS, COMMAND_ACTIVITY_FILTER, COMMAND_ACTIVITY_CANCEL } from '../constants';

export const ACTIVITY_OPEN = COMMAND_ACTIVITY_OPEN;
export const ACTIVITY_DETAILS = COMMAND_ACTIVITY_DETAILS;
export const ACTIVITY_FILTER = COMMAND_ACTIVITY_FILTER;
export const ACTIVITY_CANCEL = COMMAND_ACTIVITY_CANCEL;
export type ActivityFilter = 'All' | 'Active' | 'Needs Attention';
export type QueueItem = { id: string; type: 'group'; group: ActivityGroup }
  | { id: string; type: 'connection'; group: ActivityGroup; connectionKey: string }
  | { id: string; type: 'item'; item: ActivityItem }
  | { id: string; type: 'issue'; group: ActivityGroup; index: number };

export class TransferQueueProvider implements vscode.TreeDataProvider<QueueItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<QueueItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  filter: ActivityFilter = 'All';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribe: () => void;
  constructor() {
    this.unsubscribe = activityStore.onChange(() => {
      if (!this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; this.changed.fire(undefined); }, 100);
        this.timer.unref?.();
      }
    });
  }
  setFilter(filter: ActivityFilter): void { this.filter = filter; this.changed.fire(undefined); }
  clearCompleted(): void { activityStore.clearCompleted(); }
  cancel(id: string): void {
    for (const group of activityStore.groups.values()) {
      for (const item of group.items.values()) if (item.id === id) {
        if (item.status === 'conflict') activityStore.cancel(group.id);
        else {
          item.cancel?.();
          if (item.status === 'pending') activityStore.update(item, { status: 'cancelled' });
        }
        return;
      }
    }
    activityStore.cancel(id);
  }
  getParent(node: QueueItem): QueueItem | undefined {
    if (node.type === 'group') return undefined;
    const group = node.type === 'item' ? activityStore.groups.get(node.item.groupId) : node.group;
    if (!group) return undefined;
    if (node.type === 'item' && group.connections.size > 1) return { id: `${group.id}:${node.item.connection.key}`, type: 'connection', group, connectionKey: node.item.connection.key };
    if (node.type === 'issue' && group.connections.size > 1) {
      const connection = group.issueConnections.get(group.issues[node.index]);
      if (connection) return { id: `${group.id}:${connection.key}`, type: 'connection', group, connectionKey: connection.key };
    }
    return { id: group.id, type: 'group', group };
  }
  getChildren(node?: QueueItem): QueueItem[] {
    if (!node) return [...activityStore.groups.values()]
      .filter(group => group.entered && (this.filter === 'All' || (this.filter === 'Active' ? groupIsActive(group) : groupAttentionCount(group) > 0)))
      .sort((a, b) => Number(groupIsActive(b) || groupAttentionCount(b) > 0) - Number(groupIsActive(a) || groupAttentionCount(a) > 0) || b.startedAt - a.startedAt)
      .map(group => ({ id: group.id, type: 'group', group }));
    if (node.type === 'item' || node.type === 'issue') return [];
    const group = node.group;
    const issues: QueueItem[] = group.issues.flatMap((issue, index) => {
      const key = group.issueConnections.get(issue)?.key;
      const matches = node.type === 'connection' ? key === node.connectionKey : group.connections.size <= 1 || !key;
      return matches ? [{ type: 'issue' as const, id: `${group.id}:issue:${index}`, group, index }] : [];
    });
    if (node.type === 'group' && group.connections.size > 1) return [...issues, ...[...group.connections.keys()]
      .filter(key => this.filter !== 'Needs Attention' || group.issues.some(issue => group.issueConnections.get(issue)?.key === key)
        || [...group.items.values()].some(item => item.connection.key === key && itemNeedsAttention(item)))
      .map(connectionKey => ({ type: 'connection' as const, id: `${group.id}:${connectionKey}`, group, connectionKey }))];
    return [...issues, ...[...group.items.values()]
      .filter(item => (node.type !== 'connection' || item.connection.key === node.connectionKey) && (this.filter !== 'Needs Attention' || itemNeedsAttention(item)))
      .filter(item => item.kind !== 'mkdir' || item.status !== 'completed' || activityCounts(group).total === 0)
      .map(item => ({ id: item.id, type: 'item' as const, item }))];
  }
  getTreeItem(node: QueueItem): vscode.TreeItem {
    if (node.type === 'group') {
      const group = node.group;
      const count = activityCounts(group);
      return { id: node.id, label: redactText(`${group.label} · ${[...group.connections.values()].map(connection => connection.label).join(', ')} · ${new Date(group.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`),
        description: `${count.completed}/${count.total} files${count.issues ? ` · ${count.issues} issues` : ''}`,
        iconPath: new vscode.ThemeIcon(count.conflicts || count.issues ? 'warning' : groupIsActive(group) ? 'sync~spin' : group.cancelRequested ? 'close' : 'check'),
        contextValue: groupIsActive(group) ? 'activeOperation' : 'activityOperation',
        collapsibleState: groupIsActive(group) || count.issues ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed };
    }
    if (node.type === 'connection') return { id: node.id, label: redactText(node.group.connections.get(node.connectionKey)?.label || ''),
      collapsibleState: vscode.TreeItemCollapsibleState.Expanded };
    if (node.type === 'issue') {
      const issue = node.group.issues[node.index];
      return { id: node.id, label: issue.title, description: issue.summary, iconPath: new vscode.ThemeIcon('warning'),
        collapsibleState: vscode.TreeItemCollapsibleState.None, command: { command: ACTIVITY_DETAILS, title: 'View Details', arguments: [node] } };
    }
    const item = node.item;
    const relative = relativeActivityPath(item);
    const icon = item.status === 'conflict' || itemNeedsAttention(item) ? 'warning'
      : item.status === 'running' ? 'sync~spin' : item.status === 'completed' ? 'check'
        : item.status === 'cancelled' || item.status === 'not-started' ? 'close' : 'clock';
    return { id: node.id, label: redactText(path.basename(item.localPath)),
      description: redactText(`${path.dirname(relative) === '.' ? '' : `${path.dirname(relative)} · `}${item.conflict?.status || item.status}`),
      tooltip: redactText([item.connection.description || item.connection.label, item.kind, item.localPath, item.remotePath,
        item.error?.summary, ...item.warnings, item.conflict?.staleReason].filter(Boolean).join('\n')),
      iconPath: new vscode.ThemeIcon(icon), contextValue: item.status === 'conflict' ? 'activityConflict'
        : item.status === 'running' || item.status === 'pending' ? 'activeTransfer' : 'transfer',
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      command: { command: ACTIVITY_DETAILS, title: 'View Details', arguments: [node] } };
  }
  dispose(): void { this.unsubscribe(); if (this.timer) clearTimeout(this.timer); this.changed.dispose?.(); }
}
export const transferQueueProvider = new TransferQueueProvider();
