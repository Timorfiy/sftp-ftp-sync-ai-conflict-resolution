const REDACTED = '[REDACTED]';
const MAX_SECRETS_PER_SCOPE = 64;

const activeScopes = new Set<RedactionScope>();

function isSensitiveField(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLocaleLowerCase('en-US');
  return (
    /password|passwd|passphrase|secret|token|apikey/.test(normalized) ||
    [
      'privatekey',
      'key',
      'cert',
      'certificate',
      'pfx',
      'interactiveauth',
      'interactiveanswer',
      'interactiveanswers',
      'answer',
      'answers',
    ].includes(normalized)
  );
}

function replaceAllLiteral(value: string, search: string): string {
  return value.split(search).join(REDACTED);
}

function runtimeSecrets(): string[] {
  const values = new Set<string>();
  for (const scope of activeScopes) {
    for (const value of scope.values()) {
      values.add(value);
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

export function redactText(value: string): string {
  let result = value.replace(/\bPASS\s+[^\r\n]*/gi, `PASS ${REDACTED}`);
  for (const secret of runtimeSecrets()) {
    result = replaceAllLiteral(result, secret);
  }
  return result;
}

function sanitizeObject(
  value: Record<string, unknown>,
  seen: WeakMap<object, unknown>
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = isSensitiveField(key) && item !== undefined
      ? REDACTED
      : redact(item, seen);
  }
  return copy;
}

export function redact(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap()
): unknown {
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }
  if (value instanceof Error) {
    const copy: Record<string, unknown> = {
      name: value.name,
      message: redactText(value.message),
      stack: value.stack ? redactText(value.stack) : undefined,
    };
    seen.set(value, copy);
    for (const [key, item] of Object.entries(value)) {
      copy[key] = isSensitiveField(key)
        ? REDACTED
        : redact(item, seen);
    }
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    value.forEach(item => copy.push(redact(item, seen)));
    return copy;
  }
  return sanitizeObject(value as Record<string, unknown>, seen);
}

export function redactedErrorMessage(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
}

export class RedactionScope {
  private readonly secrets = new Set<string>();
  private disposed = false;

  constructor() {
    activeScopes.add(this);
  }

  register(value: unknown): void {
    if (
      this.disposed ||
      typeof value !== 'string' ||
      value.length === 0 ||
      this.secrets.has(value)
    ) {
      return;
    }
    if (this.secrets.size >= MAX_SECRETS_PER_SCOPE) {
      throw new Error(
        `A connection attempted to register more than ${MAX_SECRETS_PER_SCOPE} secret values.`
      );
    }
    this.secrets.add(value);
  }

  registerConnectionOptions(options: Record<string, unknown>): void {
    this.register(options.password);
    this.register(options.passphrase);
    const interactiveAuth = options.interactiveAuth;
    if (Array.isArray(interactiveAuth)) {
      interactiveAuth.forEach(value => this.register(value));
    }
    const hop = options.hop;
    if (Array.isArray(hop)) {
      hop.forEach(value => {
        if (value && typeof value === 'object') {
          this.registerConnectionOptions(value as Record<string, unknown>);
        }
      });
    } else if (hop && typeof hop === 'object') {
      this.registerConnectionOptions(hop as Record<string, unknown>);
    }
  }

  values(): Iterable<string> {
    return this.secrets.values();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.secrets.clear();
    activeScopes.delete(this);
  }
}

export { REDACTED };
