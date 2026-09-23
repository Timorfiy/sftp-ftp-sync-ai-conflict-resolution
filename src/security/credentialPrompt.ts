import { promptForPassword, showConfirmMessage } from '../host';
import {
  CredentialEndpoint,
  CredentialKind,
  storeCredential,
} from '../modules/secrets';
import {
  SecretRequest,
} from '../core/remote-client/remoteClient';
import { RedactionScope } from './redaction';

interface CredentialPromptDependencies {
  prompt(prompt: string): Promise<string | undefined>;
  confirm(
    message: string,
    confirmLabel: string,
    cancelLabel: string
  ): Promise<boolean>;
  store(
    endpoint: CredentialEndpoint,
    kind: CredentialKind,
    value: string
  ): Promise<void>;
}

const defaultDependencies: CredentialPromptDependencies = {
  prompt: promptForPassword,
  confirm: showConfirmMessage,
  store: storeCredential,
};

export function createCredentialPrompt(
  endpoint: CredentialEndpoint,
  redactionScope: RedactionScope,
  dependencies: CredentialPromptDependencies = defaultDependencies
): (request: SecretRequest) => Promise<string | undefined> {
  return async request => {
    const value = await dependencies.prompt(request.prompt);
    if (value === undefined) {
      return undefined;
    }

    redactionScope.register(value);
    if (!request.persist || request.kind === 'interactive-answer') {
      return value;
    }

    const save = await dependencies.confirm(
      `Save ${request.kind} for ${endpoint.username}@${endpoint.host}:${endpoint.port} (${endpoint.transport}) to Secret Storage?`,
      'Save',
      'Don\'t Save'
    );
    if (save) {
      await dependencies.store(endpoint, request.kind, value);
    }
    return value;
  };
}
