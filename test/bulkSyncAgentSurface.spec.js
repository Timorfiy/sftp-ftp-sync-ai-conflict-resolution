const fs = require('fs');
const path = require('path');
const packageJson = require('../package.json');
const {
  COMMAND_SYNC_LOCAL_TO_REMOTE,
  COMMAND_SYNC_REMOTE_TO_LOCAL,
  COMMAND_SYNC_BOTH_DIRECTIONS,
} = require('../src/constants');

describe('bulk sync command surface', () => {
  const bulkCommands = [
    COMMAND_SYNC_LOCAL_TO_REMOTE,
    COMMAND_SYNC_REMOTE_TO_LOCAL,
    COMMAND_SYNC_BOTH_DIRECTIONS,
  ];

  test('keeps direction labels explicit in the command palette', () => {
    const commands = new Map(
      packageJson.contributes.commands.map(command => [command.command, command.title])
    );

    expect(commands.get(COMMAND_SYNC_LOCAL_TO_REMOTE)).toBe('Sync Local → Remote');
    expect(commands.get(COMMAND_SYNC_REMOTE_TO_LOCAL)).toBe('Sync Remote → Local');
    expect(commands.get(COMMAND_SYNC_BOTH_DIRECTIONS)).toBe('Sync Both Directions');
  });

  test('does not expose bulk sync through an agent, language-model, or MCP contribution', () => {
    const contributionKeys = [
      'languageModelTools',
      'chatParticipants',
      'mcpServers',
    ];
    const serializedAgentContributions = JSON.stringify(
      contributionKeys.map(key => packageJson.contributes[key] || [])
    );

    for (const command of bulkCommands) {
      expect(serializedAgentContributions).not.toContain(command);
    }

    const commandDirectory = path.join(__dirname, '..', 'src', 'commands');
    const bulkHandlerFiles = fs.readdirSync(commandDirectory)
      .filter(name => /^fileCommandSync.*\.ts$/.test(name))
      .sort();
    expect(bulkHandlerFiles).toEqual([
      'fileCommandSyncBothDirections.ts',
      'fileCommandSyncLocalToRemote.ts',
      'fileCommandSyncRemoteToLocal.ts',
    ]);
  });
});
