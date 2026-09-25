const Ignore = require('../src/core/ignore').default;
const { IGNORE_PRESETS, getIgnoreConfigTargets, applyIgnorePreset } = require('../src/modules/ignorePresets');

test.each([
  ['Basic', '.env.production', 'src/index.php'],
  ['Bitrix', 'bitrix/modules/main/index.php', 'local/templates/site/src/main.js'],
  ['WordPress', 'wp-content/cache/page.html', 'wp-content/uploads/photo.jpg'],
  ['PHP / Composer', '.phpunit.cache/results', 'vendor/autoload.php'],
  ['Laravel', 'storage/framework/sessions/abc', 'storage/app/public/photo.jpg'],
  ['Yii2', 'frontend/runtime/cache/data.bin', 'frontend/views/site/index.php'],
  ['Node.js', 'node_modules/package/index.js', 'dist/server.js'],
  ['React / Vue / Vite', '.vite/cache/data', 'dist/assets/index.js'],
  ['Next.js', '.next/cache/data', '.next/server/app/page.js'],
  ['Nuxt 3 / 4', '.nuxt/dev/index.js', '.output/server/index.mjs'],
  ['Python / Django / FastAPI / Flask', '.venv/lib/site.py', 'media/photo.jpg'],
  ['Go', 'server.test', 'bin/server'],
  ['Java / Maven / Gradle', '.gradle/cache/data', 'target/server.jar'],
  ['.NET / ASP.NET Core', 'src/Server/obj/cache.bin', 'src/Server/bin/Release/publish/Server.dll'],
  ['Ruby / Rails', 'tmp/cache/data', 'storage/photo.jpg'],
])('%s excludes temporary files and keeps deployable content', (label, excluded, included) => {
  const preset = IGNORE_PRESETS.find(item => item.label === label);
  const ignore = Ignore.from(preset.patterns);
  expect(ignore.ignores(excluded)).toBe(true);
  for (const file of [included, 'src/main.ts', 'vendor/autoload.php', 'public/index.html']) {
    expect(ignore.ignores(file)).toBe(false);
  }
  expect(new Set(preset.patterns).size).toBe(preset.patterns.length);
});

test('Bitrix excludes installed core, media and work files while keeping site code', () => {
  const ignore = Ignore.from(IGNORE_PRESETS.find(item => item.label === 'Bitrix').patterns);
  for (const file of [
    'bitrix', 'bitrix/modules/main/index.php', 'bitrix/php_interface/dbconn.php',
    'upload', 'upload/iblock/photo.jpg', '.kent-tmp/snapshots/template.php',
    '.codex/config.toml', '.agents/skills/local/SKILL.md', '.playwright-cli/page.yml',
    '.cache/data', 'local/frontend/app/node_modules/vite/index.js',
    'local/frontend/.vite/deps.json', 'local/frontend/app/.vite-temp/config.js',
    'local/frontend/coverage/index.html', 'backup.sql', 'backups/db.dump',
    'site.tar', 'site.tar.gz', 'site.gz', 'site.zip', 'index.php.old', '.index.php.swp', 'index.php~',
    'agents.md', 'SKILLS.md', 'skills.md', 'README.md',
    '.vsftp-backup/template.php', 'local/.sftp-backups/template.php', '_snapshots/template.php',
  ]) {
    expect({ file, ignored: ignore.ignores(file) }).toEqual({ file, ignored: true });
  }
  for (const file of [
    'local', 'local/php_interface/init.php', 'local/templates/site/template_styles.css',
    'local/templates/site/components/bitrix/news.list/cards/template.php',
    'local/components/company/upload/component.php',
    'local/frontend/app/src/main.ts', 'local/frontend/app/dist/assets/index.js',
    'local/templates/site/assets/images/logo.svg', 'ajax/index.php', 'index.php', '.htaccess',
  ]) {
    expect({ file, ignored: ignore.ignores(file) }).toEqual({ file, ignored: false });
  }
});

test.each([
  ['Next.js', '.next/standalone/node_modules/next/server.js'],
  ['Next.js', '.next/standalone/apps/web/node_modules/package/index.js'],
  ['Nuxt 3 / 4', '.output/server/node_modules/package/index.mjs'],
])('%s keeps dependencies bundled into production output', (label, file) => {
  const ignore = Ignore.from(IGNORE_PRESETS.find(item => item.label === label).patterns);
  expect(ignore.ignores(file)).toBe(false);
  expect(ignore.ignores('node_modules/package/index.js')).toBe(true);
});

test('merges once, preserving user rule order, negations, credentials and CRLF', () => {
  const text = '{\r\n\t"password": "unchanged",\r\n\t"ignore": ["*.log", "!keep.log", "custom", "*.log", "!keep.log"]\r\n}\r\n';
  const preset = IGNORE_PRESETS[0];
  const updated = applyIgnorePreset(text, getIgnoreConfigTargets(text)[0], preset.patterns);
  const parsed = JSON.parse(updated);
  expect(parsed.password).toBe('unchanged');
  expect(updated).toContain('\r\n\t"password": "unchanged",');
  expect(updated.replace(/\r\n/g, '')).not.toContain('\n');
  expect(parsed.ignore.slice(-5)).toEqual(['*.log', '!keep.log', 'custom', '*.log', '!keep.log']);
  expect(Ignore.from(parsed.ignore).ignores('keep.log')).toBe(false);
  expect(Ignore.from(parsed.ignore).ignores('other.log')).toBe(true);
  expect(applyIgnorePreset(updated, getIgnoreConfigTargets(updated)[0], preset.patterns)).toBe(updated);
});

test('edits only the chosen connection/profile and does not duplicate inherited rules', () => {
  const configs = [
    { name: 'FTP', protocol: 'ftp', ignore: ['.git'], profiles: { dev: {}, ignore: { ignore: ['custom'] } } },
    { name: 'SFTP', protocol: 'sftp' },
  ];
  const text = JSON.stringify(configs);
  const targets = getIgnoreConfigTargets(text);
  expect(targets.map(target => target.path)).toEqual([[0], [0, 'profiles', 'dev'], [0, 'profiles', 'ignore'], [1]]);
  const updated = JSON.parse(applyIgnorePreset(text, targets[2], ['.git', 'node_modules']));
  expect(updated[0].profiles.ignore.ignore).toEqual(['node_modules', 'custom']);
  expect(updated[0].ignore).toEqual(['.git']);
  expect(updated[0].profiles.dev).toEqual({});
  expect(updated[1]).toEqual(configs[1]);
});

test.each(['null', '42', '{"ignore":"src"}', '{"ignore":[42]}', '{"profiles":[]}', '{"profiles":{"dev":null}}', '{'])('rejects invalid configuration: %s', text => {
  expect(() => getIgnoreConfigTargets(text)).toThrow();
});
