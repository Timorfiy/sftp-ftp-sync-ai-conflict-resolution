const definitions = require('../schema/definitions.json');
const manifest = require('../package.json');

describe('safe setup schema and onboarding', () => {
  test('offers non-destructive watcher and sync completions', () => {
    const watcher = definitions.rootOption.properties.watcher;
    const sync = definitions.option.properties.syncOption.properties;

    expect(watcher.properties.files.oneOf).toEqual([
      { type: 'string' },
      { enum: [false] },
    ]);
    expect(watcher.default).toEqual({
      files: false,
      autoUpload: false,
      autoDelete: false,
      autoRename: false,
    });
    expect(watcher.properties.autoUpload.default).toBe(false);
    expect(watcher.properties.autoDelete.default).toBe(false);
    expect(watcher.properties.autoRename.default).toBe(false);
    expect(Object.fromEntries(
      Object.entries(sync).map(([name, schema]) => [name, schema.default])
    )).toEqual({
      delete: false,
      skipCreate: false,
      ignoreExisting: false,
      update: false,
    });
  });

  test('contributes Test Connection to the palette and remote root', () => {
    const command = 'sftpSyncAI.testConnection';
    expect(manifest.contributes.commands).toContainEqual(
      expect.objectContaining({ command, title: 'Test Connection' })
    );
    expect(manifest.contributes.menus.commandPalette).toContainEqual(
      expect.objectContaining({ command })
    );
    expect(manifest.contributes.menus['view/item/context']).toContainEqual(
      expect.objectContaining({
        command,
        when: 'view == remoteExplorer && viewItem == root',
      })
    );
  });
});
