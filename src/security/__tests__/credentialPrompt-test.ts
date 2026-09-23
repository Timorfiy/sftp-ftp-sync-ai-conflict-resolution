import { createCredentialEndpoint } from '../../modules/secrets';
import { createCredentialPrompt } from '../credentialPrompt';
import { RedactionScope, redactText } from '../redaction';

describe('typed credential prompts', () => {
  const endpoint = createCredentialEndpoint({
    protocol: 'sftp',
    host: 'example.com',
    port: 22,
    username: 'deploy',
  });

  test.each([
    ['password', 'password-canary'],
    ['passphrase', 'passphrase-canary'],
  ] as const)('can save a prompted %s under its own credential kind', async (kind, value) => {
    const scope = new RedactionScope();
    const store = jest.fn(async () => undefined);
    const handler = createCredentialPrompt(endpoint, scope, {
      prompt: jest.fn(async () => value),
      confirm: jest.fn(async () => true),
      store,
    });

    await expect(handler({ kind, prompt: `Enter ${kind}`, persist: true }))
      .resolves.toBe(value);
    expect(store).toHaveBeenCalledWith(endpoint, kind, value);
    expect(redactText(`failure: ${value}`)).toBe('failure: [REDACTED]');
    scope.dispose();
  });

  test('keeps keyboard-interactive answers memory-only', async () => {
    const answer = 'interactive-answer-canary';
    const scope = new RedactionScope();
    const confirm = jest.fn(async () => true);
    const store = jest.fn(async () => undefined);
    const handler = createCredentialPrompt(endpoint, scope, {
      prompt: jest.fn(async () => answer),
      confirm,
      store,
    });

    await expect(
      handler({
        kind: 'interactive-answer',
        prompt: 'Verification code',
        persist: false,
      })
    ).resolves.toBe(answer);
    expect(confirm).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(redactText(answer)).toBe('[REDACTED]');
    scope.dispose();
  });

  test('does not persist a hop password when the request disables persistence', async () => {
    const scope = new RedactionScope();
    const confirm = jest.fn(async () => true);
    const store = jest.fn(async () => undefined);
    const handler = createCredentialPrompt(endpoint, scope, {
      prompt: jest.fn(async () => 'hop-password-canary'),
      confirm,
      store,
    });

    await handler({
      kind: 'password',
      prompt: 'Hop password',
      persist: false,
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    scope.dispose();
  });
});
