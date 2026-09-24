const fs = require('fs');
const path = require('path');
const schemaValidator = require('json-schema');
const {
  createNewConfigTemplate,
  parseConfigDocument,
  validateConfig,
} = require('../src/modules/config');

const root = path.resolve(__dirname, '..');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

function shippedMarkdown() {
  const rules = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8')
    .split(/\r?\n/)
    .filter(line => line.startsWith('!'));
  const files = new Set();
  for (const rule of rules) {
    const relative = rule.slice(1).replace(/\//g, path.sep);
    if (relative.endsWith(`${path.sep}**`)) {
      const directory = path.join(root, relative.slice(0, -3));
      if (fs.existsSync(directory)) {
        walk(directory)
          .filter(file => file.endsWith('.md'))
          .forEach(file => files.add(file));
      }
    } else if (relative.endsWith('.md')) {
      files.add(path.join(root, relative));
    }
  }
  return [...files].sort();
}

function jsonFences(markdown) {
  return [...markdown.matchAll(/```json[ \t]*\r?\n([\s\S]*?)```/g)]
    .map(match => match[1]);
}

function headingSlug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function anchors(markdown) {
  const counts = new Map();
  const result = new Set();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = headingSlug(match[1]);
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}

function decodeTarget(target) {
  return decodeURIComponent(target.replace(/^<|>$/g, ''));
}

function resolvePointer(document, pointer) {
  return pointer
    .replace(/^\//, '')
    .split('/')
    .filter(Boolean)
    .reduce(
      (value, segment) =>
        value[segment.replace(/~1/g, '/').replace(/~0/g, '~')],
      document
    );
}

function dereference(value, documents, currentFile) {
  if (Array.isArray(value)) {
    return value.map(item => dereference(item, documents, currentFile));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (value.$ref) {
    const [filePart, pointer = ''] = value.$ref.split('#');
    const targetFile = filePart || currentFile;
    const target = resolvePointer(documents[targetFile], pointer);
    return dereference(target, documents, targetFile);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      dereference(item, documents, currentFile),
    ])
  );
}

function schemaDocuments() {
  return Object.fromEntries(
    ['definitions.json', 'sftp.schema.json', 'ftp.schema.json'].map(file => [
      file,
      JSON.parse(fs.readFileSync(path.join(root, 'schema', file), 'utf8')),
    ])
  );
}

function validateAgainstSchema(config) {
  const file = config.protocol === 'ftp'
    ? 'ftp.schema.json'
    : 'sftp.schema.json';
  const documents = schemaDocuments();
  const schema = dereference(documents[file], documents, file);
  return schemaValidator.validate(config, schema);
}

function documentedCommandLabels(markdown) {
  return [...markdown.matchAll(
    /\*\*((?:SFTP|SFTP\/FTP Sync \+ AI Conflict Resolution): [^*]+)\*\*/g
  )].map(match => match[1].replace(/\s+/g, ' ').trim());
}

describe('first-release documentation surface', () => {
  const markdownFiles = shippedMarkdown();

  test('derives and covers the Markdown surface shipped by the VSIX allowlist', () => {
    expect(markdownFiles.map(file => path.relative(root, file).replace(/\\/g, '/')))
      .toEqual(expect.arrayContaining([
        'README.md',
        'FAQ.md',
        'CHANGELOG.md',
        'docs/options.md',
        'docs/commands.md',
        'docs/troubleshooting.md',
        'resources/mcp/conflict-resolution-instructions.md',
      ]));
    expect(markdownFiles.every(file => fs.existsSync(file))).toBe(true);
  });

  test.each(shippedMarkdown())('%s has only strict, parseable copyable JSON', file => {
    const markdown = fs.readFileSync(file, 'utf8');
    expect(markdown).not.toMatch(/```jsonc\b/);
    for (const example of jsonFences(markdown)) {
      expect(() => JSON.parse(example)).not.toThrow();
    }
  });

  test('validates the canonical SFTP and FTP examples through runtime and schema', () => {
    const examples = jsonFences(fs.readFileSync(path.join(root, 'README.md'), 'utf8'));
    expect(examples).toHaveLength(2);
    for (const example of examples) {
      const config = JSON.parse(example);
      expect(validateConfig(config)).toBeNull();
      expect(() => parseConfigDocument('README.md', example)).not.toThrow();
      expect(validateAgainstSchema(config)).toEqual({ valid: true, errors: [] });
      expect(config).not.toHaveProperty('password');
      expect(config).not.toHaveProperty('passphrase');
      expect(config).toMatchObject({
        conflictCheck: true,
        watcher: {
          files: false,
          autoUpload: false,
          autoDelete: false,
          autoRename: false,
        },
        syncOption: { delete: false },
        backup: {
          enabled: true,
          location: 'local',
          versions: 100,
          onDelete: false,
        },
      });
    }
  });

  test('keeps runtime omission, generated values, schema metadata, and docs matrix aligned', () => {
    const omitted = parseConfigDocument(
      'omitted.json',
      JSON.stringify({ host: 'example.com', username: 'user' })
    ).configs[0];
    const generated = createNewConfigTemplate();
    const definitions = schemaDocuments()['definitions.json'];

    expect(omitted).toMatchObject({
      protocol: 'sftp',
      remotePath: './',
      conflictCheck: false,
      downloadOnOpen: false,
      ignore: [],
      backup: {
        enabled: false,
        location: 'remote',
        folder: '.vscode/sftp-backup',
        versions: 100,
        onDelete: false,
      },
    });
    expect(generated).toMatchObject({
      protocol: 'sftp',
      port: 22,
      remotePath: '/',
      conflictCheck: true,
      backup: {
        enabled: true,
        location: 'local',
        versions: 100,
      },
    });
    expect(definitions.option.properties.conflictCheck.default).toBe(false);
    expect(definitions.option.properties.downloadOnOpen.default).toBe(false);
    expect(definitions.option.properties.ignore.default).toEqual([]);
    expect(definitions.option.properties.backup.default).toEqual({
      enabled: false,
      location: 'remote',
      folder: '.vscode/sftp-backup',
      versions: 100,
      onDelete: false,
    });
    const options = fs.readFileSync(path.join(root, 'docs/options.md'), 'utf8');
    expect(options).toContain('| `conflictCheck` | `true` | `false` | `false` |');
    expect(options).toContain('| `backup.enabled` | `true` | `false` | `false` |');
    expect(options).toContain('| `ignore` | explicit safety list | `[]` plus internal exclusions | `[]` |');
    expect(
      validateAgainstSchema({ host: 'example.com', username: 'user' })
    ).toEqual({ valid: true, errors: [] });
    expect(
      validateAgainstSchema({
        host: 'example.com',
        username: 'user',
        protocol: 'sftp',
        password: null,
        agent: null,
        privateKeyPath: null,
        passphrase: null,
        limitOpenFilesOnRemote: 222,
        hooks: { preUpload: 'npm.cmd test' },
      })
    ).toEqual({ valid: true, errors: [] });
  });

  test('resolves every shipped relative link and Markdown anchor', () => {
    const failures = [];
    for (const file of markdownFiles) {
      const markdown = fs.readFileSync(file, 'utf8');
      for (const match of markdown.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
        const raw = match[1].trim().split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/)[0];
        if (/^(?:https?:|command:|mailto:)/i.test(raw)) {
          continue;
        }
        const [relative, fragment] = decodeTarget(raw).split('#');
        const target = relative
          ? path.resolve(path.dirname(file), relative)
          : file;
        if (!fs.existsSync(target)) {
          failures.push(`${path.relative(root, file)} -> ${raw}`);
          continue;
        }
        if (fragment && target.endsWith('.md')) {
          const targetAnchors = anchors(fs.readFileSync(target, 'utf8'));
          if (!targetAnchors.has(fragment.toLowerCase())) {
            failures.push(`${path.relative(root, file)} -> #${fragment}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('keeps active support links on this product and removes stale upstream help', () => {
    const active = markdownFiles
      .filter(file => path.basename(file) !== 'CHANGELOG.md')
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n');
    expect(active).not.toMatch(/github\.com\/(?:philipdaoud|liximomo|natizyskunk)\//i);
    expect(active).not.toMatch(/sftp-neo\/wiki/i);
    expect(active).toContain(
      'https://github.com/Timorfiy/sftp-ftp-sync-ai-conflict-resolution/issues'
    );
  });

  test('keeps active manifest and conflict notification copy in English', () => {
    const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const conflictBridge = fs.readFileSync(
      path.join(root, 'src/fileHandlers/transfer/conflictBridge.ts'),
      'utf8'
    );
    expect(`${manifest}\n${conflictBridge}`).not.toMatch(/[\u0400-\u04ff]/);
    expect(conflictBridge).toContain('was paused because the remote file changed');
  });

  test('resolves displayed Command Palette labels to manifest contributions', () => {
    const manifest = require('../package.json');
    const contributed = new Set(
      manifest.contributes.commands.map(command =>
        `${command.category || ''}: ${command.title}`
      )
    );
    const documented = markdownFiles.flatMap(file =>
      documentedCommandLabels(fs.readFileSync(file, 'utf8'))
    );

    expect(documented.length).toBeGreaterThan(0);
    expect([...new Set(documented)].filter(label => !contributed.has(label)))
      .toEqual([]);
  });
});
