import * as vscode from 'vscode';
import { COMMAND_DELETE_SAVED_PASSWORD } from '../constants';
import { showInformationMessage } from '../host';
import { getCredentialMigrationCandidates } from '../modules/serviceManager';
import {
  CredentialEndpoint,
  CredentialKind,
  credentialEndpointId,
  deleteCredential,
  deleteLegacyCredential,
  findLegacyCredentials,
  getCredential,
} from '../modules/secrets';
import { checkCommand } from './abstract/createCommand';

interface CredentialItem extends vscode.QuickPickItem {
  endpoint?: CredentialEndpoint;
  credentialKind: CredentialKind;
  legacyKey?: string;
}

export default checkCommand({
  id: COMMAND_DELETE_SAVED_PASSWORD,

  async handleCommand() {
    const items: CredentialItem[] = [];
    const candidates = getCredentialMigrationCandidates();
    const endpoints = new Map<string, CredentialEndpoint>();

    for (const candidate of candidates) {
      endpoints.set(credentialEndpointId(candidate.endpoint), candidate.endpoint);
    }
    for (const endpoint of endpoints.values()) {
      for (const kind of ['password', 'passphrase'] as const) {
        if ((await getCredential(endpoint, kind)) === undefined) {
          continue;
        }
        items.push({
          endpoint,
          credentialKind: kind,
          label: `${kind === 'password' ? '$(key)' : '$(lock)'} ${kind}`,
          description:
            `${endpoint.transport}://${endpoint.username}@${endpoint.host}:${endpoint.port}`,
        });
      }
    }
    for (const legacy of await findLegacyCredentials(candidates)) {
      items.push({
        credentialKind: legacy.kind,
        legacyKey: legacy.key,
        label: `$(warning) Legacy ${legacy.kind}`,
        description:
          `${legacy.username}@${legacy.host}` +
          (legacy.ambiguous ? ' — ambiguous endpoint; not migrated' : ''),
      });
    }

    if (items.length === 0) {
      showInformationMessage('No saved credentials found in Secret Storage.');
      return;
    }

    const selected = await vscode.window.showQuickPick<CredentialItem>(items, {
      placeHolder: 'Select saved credential(s) to delete',
      canPickMany: true,
    });

    if (!selected || selected.length === 0) {
      return;
    }

    for (const item of selected) {
      if (item.legacyKey) {
        await deleteLegacyCredential(item.legacyKey);
      } else if (item.endpoint) {
        await deleteCredential(item.endpoint, item.credentialKind);
      }
    }

    showInformationMessage(
      `Deleted ${selected.length} saved credential(s) from Secret Storage.`
    );
  },
});
