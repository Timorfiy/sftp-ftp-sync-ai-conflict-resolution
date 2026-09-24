import * as vscode from 'vscode';
import { registerCommand, setContextValue } from '../../host';
import {
  COMMAND_REMOTEEXPLORER_REFRESH,
  COMMAND_REMOTEEXPLORER_VIEW_CONTENT,
  COMMAND_SYNC_REMOTE_TO_LOCAL,
  VIEW_REMOTE_EXPLORER,
} from '../../constants';
import { UResource } from '../../core';
import { reportError, toRemotePath } from '../../helper';
import logger from '../../logger';
import { REMOTE_SCHEME } from '../../constants';
import { getFileService } from '../serviceManager';
import RemoteTreeDataProvider, { ExplorerItem } from './treeDataProvider';
import RemoteExplorerDragAndDropController from './dragAndDrop';

const REMOTE_TO_LOCAL_COMMAND_URI = `file:///\${command:${COMMAND_SYNC_REMOTE_TO_LOCAL}}`;

export default class RemoteExplorer {
  private _explorerView: vscode.TreeView<ExplorerItem>;
  private _treeDataProvider: RemoteTreeDataProvider;

  constructor(context: vscode.ExtensionContext) {
    this._treeDataProvider = new RemoteTreeDataProvider();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, this._treeDataProvider)
    );

    // The controller is always attached; it no-ops for any config that hasn't
    // opted in via remoteExplorer.enableDragAndDrop, which is per-config.
    this._explorerView = vscode.window.createTreeView(VIEW_REMOTE_EXPLORER, {
      showCollapseAll: true,
      treeDataProvider: this._treeDataProvider,
      canSelectMany: true,
      dragAndDropController: new RemoteExplorerDragAndDropController(this._treeDataProvider),
    });

    registerCommand(context, COMMAND_REMOTEEXPLORER_REFRESH, () => this._refreshSelection());
    registerCommand(context, COMMAND_REMOTEEXPLORER_VIEW_CONTENT, (item: ExplorerItem) =>
      this._treeDataProvider.showItem(item)
    );

    setContextValue('hasRemoteFilter', false);
  }

  async refresh(item?: ExplorerItem): Promise<void> {
    try {
      await this._refresh(item);
    } catch (error) {
      void reportError(error, {
        operation: 'refresh Remote Explorer',
        pathKind: 'remote',
        retrySafety: 'safe',
        openConfig: true,
      }).catch(actionError => logger.error(actionError, 'Remote Explorer recovery action'));
    }
  }

  private async _refresh(item?: ExplorerItem): Promise<void> {
    if (item && !UResource.isRemote(item.resource.uri)) {
      const uri = item.resource.uri;
      const fileService = getFileService(uri);
      if (!fileService) {
        if (uri.toString(true) === REMOTE_TO_LOCAL_COMMAND_URI) {
          throw '';
        } else {
          throw new Error(`Config Not Found. (${uri.toString(true)})`);
        }
      }
      const config = fileService.getConfig();
      const localPath = item.resource.fsPath;
      const remotePath = toRemotePath(localPath, config.context, config.remotePath);
      item.resource = UResource.makeResource({
        remote: {
          host: config.host,
          port: config.port,
        },
        fsPath: remotePath,
        remoteId: fileService.id,
      });
    }

    await this._treeDataProvider.refresh(item);
  }

  purge(remoteUri: vscode.Uri) {
    this._treeDataProvider.purge(remoteUri);
  }

  get onDidChangeSelection(): vscode.Event<vscode.TreeViewSelectionChangeEvent<ExplorerItem>> {
    return this._explorerView.onDidChangeSelection;
  }

  reveal(item: ExplorerItem): Thenable<void> {
    return item ? this._explorerView.reveal(item) : Promise.resolve();
  }

  findRoot(remoteUri: vscode.Uri) {
    return this._treeDataProvider.findRoot(remoteUri);
  }

  setFilter(query: string): void {
    this._treeDataProvider.setFilter(query);
    const normalizedQuery = query.toLowerCase().trim();
    setContextValue('hasRemoteFilter', Boolean(normalizedQuery));
    this._explorerView.description = normalizedQuery ? `Filter: ${normalizedQuery}` : undefined;
  }

  getFilter(): string {
    return this._treeDataProvider.getFilter();
  }

  private async _refreshSelection(): Promise<void> {
    if (this._explorerView.selection.length) {
      await Promise.all(this._explorerView.selection.map(item => this.refresh(item)));
    } else {
      await this.refresh();
    }
  }
}
