const fs = require('fs');
const path = require('path');
const manifest = require('../package.json');
const constants = require('../src/constants');

const COMMAND_PREFIX = 'sftpSyncAI.';
const root = path.resolve(__dirname, '..');

function collectMenuCommandReferences() {
  return Object.values(manifest.contributes.menus)
    .flat()
    .flatMap(item => [item.command, item.alt])
    .filter(Boolean);
}

function collectWelcomeCommandReferences() {
  return manifest.contributes.viewsWelcome.flatMap(item =>
    [...item.contents.matchAll(/\(command:([^)]+)\)/g)].map(match => match[1])
  );
}

function collectWhenClauses(value, clauses = []) {
  if (Array.isArray(value)) {
    value.forEach(item => collectWhenClauses(item, clauses));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (key === 'when' && typeof item === 'string') {
        clauses.push(item);
      } else {
        collectWhenClauses(item, clauses);
      }
    });
  }
  return clauses;
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(fullPath);
    }
    return entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

describe('standalone extension identity', () => {
  test('uses the approved package identity and repository-local packaging tool', () => {
    expect({
      name: manifest.name,
      displayName: manifest.displayName,
      version: manifest.version,
      publisher: manifest.publisher,
      author: manifest.author,
    }).toEqual({
      name: 'sftp-sync-ai',
      displayName: 'SFTP/FTP Sync + AI Conflict Resolution',
      version: '0.1.0',
      publisher: 'Timorfiy',
      author: 'Timorfiy',
    });
    expect(manifest.devDependencies['@vscode/vsce']).toBe('4.0.0');
    expect(manifest.scripts.package).toBe(
      'vsce package --out sftp-sync-ai-0.1.0.vsix'
    );
    expect(manifest.scripts['package:list']).toBe('vsce ls --tree');
    expect(Object.values(manifest.scripts).join('\n')).not.toMatch(/\b(?:publish|push)\b/);
  });

  test('uses one private command namespace and resolves every manifest reference', () => {
    const contributedCommands = manifest.contributes.commands.map(item => item.command);
    const contributedCommandSet = new Set(contributedCommands);
    const runtimeCommands = Object.entries(constants)
      .filter(([name]) => name.startsWith('COMMAND_') && name !== 'COMMAND_NAMESPACE')
      .map(([, value]) => value);
    const references = [
      ...collectMenuCommandReferences(),
      ...manifest.contributes.keybindings.map(item => item.command),
      ...collectWelcomeCommandReferences(),
    ];

    expect(contributedCommands).toHaveLength(new Set(contributedCommands).size);
    expect(contributedCommands.every(command => command.startsWith(COMMAND_PREFIX))).toBe(true);
    expect(runtimeCommands.every(command => command.startsWith(COMMAND_PREFIX))).toBe(true);
    expect(contributedCommands.every(command => runtimeCommands.includes(command))).toBe(true);
    expect(references.every(command => contributedCommandSet.has(command))).toBe(true);
    expect(references.every(command => command.startsWith(COMMAND_PREFIX))).toBe(true);
  });

  test('uses the private namespace for extension context keys but keeps settings keys', () => {
    const whenClauses = collectWhenClauses(manifest.contributes);
    const extensionContextTokens = whenClauses.flatMap(clause =>
      clause.match(/\b(?:sftpSyncAI|sftp)\.(?:enabled|hasConfig|hasRemoteFilter)\b/g) || []
    );

    expect(extensionContextTokens.length).toBeGreaterThan(0);
    expect(extensionContextTokens.every(token => token.startsWith('sftpSyncAI.'))).toBe(true);
    expect(
      Object.hasOwn(manifest.contributes.configuration.properties, 'sftp.debug')
    ).toBe(true);
    expect(whenClauses).toContain(
      'view == remoteExplorer && viewItem == file && config.sftp.downloadWhenOpenInRemoteExplorer'
    );
  });

  test('contains no active legacy command reference in TypeScript sources', () => {
    const source = sourceFiles(path.join(root, 'src'))
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n');

    expect(source).not.toMatch(
      /(?:command:|['"`])sftp\.(?:toggleOutput|config|setProfile|selectNetworkInterface|cancelAllTransfer|openConnectInTerminal|forceUpload|upload|forceDownload|download|sync|diff|list|delete|rename|reveal|remoteExplorer|viewContent|create|deleteSavedPassword|transferQueue|remoteBackups)/
    );
    expect(source).not.toContain('SFTP@PhilipDaoud');
  });

  test('keeps the existing sftp.json path and schema association', () => {
    expect(constants.CONFIG_PATH.replace(/\\/g, '/')).toBe('.vscode/sftp.json');
    expect(manifest.contributes.jsonValidation).toContainEqual({
      fileMatch: '.vscode/sftp.json',
      url: './schema/config.schema.json',
    });
  });

  test('keeps packaging deny-by-default and excludes internal specifications', () => {
    const vscodeIgnore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');

    expect(vscodeIgnore.split(/\r?\n/, 1)[0]).toBe('**');
    expect(vscodeIgnore).toContain('!dist/extension.js');
    expect(vscodeIgnore).toContain('!dist/mcp-server.js');
    expect(vscodeIgnore).toContain('!resources/mcp/conflict-resolution-instructions.md');
    expect(vscodeIgnore).not.toContain('!dist/**');
    expect(vscodeIgnore).not.toContain('!docs/**');
    expect(vscodeIgnore).not.toContain('release-readiness-roadmap');
    expect(vscodeIgnore).not.toContain('preview-sync-feature-spec');
  });

  test('pins the supported MCP editor surface and bundled server provider', () => {
    expect(manifest.engines.vscode).toBe('^1.104.0');
    expect(manifest.devDependencies['@types/vscode']).toBe('1.104.0');
    expect(manifest.dependencies['@modelcontextprotocol/sdk']).toBe('1.30.1');
    expect(manifest.contributes.mcpServerDefinitionProviders).toEqual([
      {
        id: 'sftpSyncAI.conflicts',
        label: 'SFTP/FTP Sync Conflict Resolution',
      },
    ]);
  });
});
