import {
  REDACTED,
  RedactionScope,
  redact,
  redactedErrorMessage,
  redactText,
} from '../redaction';

describe('shared secret redaction', () => {
  test('redacts nested sensitive fields without mutating the source', () => {
    const source = {
      host: 'example.com',
      profiles: {
        production: {
          password: 'nested-password-canary',
          hop: {
            passphrase: 'nested-passphrase-canary',
            options: {
              apiToken: 'nested-token-canary',
            },
          },
        },
      },
    };

    expect(redact(source)).toEqual({
      host: 'example.com',
      profiles: {
        production: {
          password: REDACTED,
          hop: {
            passphrase: REDACTED,
            options: {
              apiToken: REDACTED,
            },
          },
        },
      },
    });
    expect(source.profiles.production.password).toBe('nested-password-canary');
  });

  test('redacts active runtime secrets, errors, stacks, and FTP PASS lines', () => {
    const scope = new RedactionScope();
    const password = 'PW-8a751a67-246f-4a51';
    const passphrase = 'PP-8da76fe1-06bf-48b8';
    const answer = 'KI-6df65e87-9839-4737';
    scope.register(password);
    scope.register(passphrase);
    scope.register(answer);

    const error = new Error(
      `Authentication failed for ${password}; ${passphrase}; ${answer}`
    );
    const output = JSON.stringify(redact(error));
    const protocol = redactText(`> PASS ${password}\r\nserver echoed ${answer}`);

    for (const canary of [password, passphrase, answer]) {
      expect(output).not.toContain(canary);
      expect(protocol).not.toContain(canary);
      expect(redactedErrorMessage(error)).not.toContain(canary);
    }
    expect(output).toContain(REDACTED);
    expect(protocol).toContain(`PASS ${REDACTED}`);

    scope.dispose();
    expect(redactText(password)).toBe(password);
  });

  test('registers nested connection and hop authentication values', () => {
    const scope = new RedactionScope();
    scope.registerConnectionOptions({
      password: 'root-password-canary',
      interactiveAuth: ['root-answer-canary'],
      hop: [
        {
          passphrase: 'hop-passphrase-canary',
          interactiveAuth: ['hop-answer-canary'],
        },
      ],
    });

    const output = redactText(
      'root-password-canary root-answer-canary hop-passphrase-canary hop-answer-canary'
    );
    expect(output).toBe(`${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED}`);
    scope.dispose();
  });
});
