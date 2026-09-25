# Ignore templates

Run **SFTP: Config** and choose a template when creating `.vscode/sftp.json`.
Choose **Basic** for common exclusions only. Cancelling creates no file.
Opening an existing config with this command leaves it unchanged.

For an existing file, run **SFTP: Apply Ignore Template**, choose a connection
or profile if there is more than one, then choose the stack. The picker shows
the rules before applying them. The command saves the additions and opens the
configuration for review. Save any pending edits before running it.

Templates add missing rules to `ignore`. They keep existing rules and their
order, add no duplicate entries, and leave all other settings unchanged.
Existing rules follow new ones so user negations keep their precedence.
Applying another template combines the lists; remove unwanted rules manually
to switch stacks. Rules already inherited from the base configuration are not
copied into a profile.

| Template | Stack-specific exclusions | Kept available for transfer |
| --- | --- | --- |
| Basic | Editor files, Git, `.env` and `.env.*`, logs, temporary and backup files | Application source and build output |
| Bitrix | Entire root `bitrix` and `upload`, tool directories, frontend dependencies/caches, dumps, archives and backups | `local`, templates, custom components, site code and frontend build output |
| WordPress | PHP tool files, `wp-content/cache`, `upgrade`, `upgrade-temp-backup` | Themes, plugins and uploads |
| PHP / Composer | `node_modules`, PHPUnit and PHP CS Fixer caches | `vendor` and source |
| Laravel | PHP tool files, framework cache, sessions, compiled views, logs, `bootstrap/cache` | `storage/app`, `public`, `vendor` and source |
| Yii2 | PHP tool files, basic/advanced runtime directories and published web assets | Views, source assets and `vendor` |
| Node.js | `node_modules`, npm/pnpm caches and coverage data | Source and build output |
| React / Vue / Vite | Node.js exclusions and `.vite` | `src`, `public` and `dist` |
| Next.js | Node.js exclusions and `.next/cache` | `.next`, including standalone bundled dependencies |
| Nuxt 3 / 4 | Node.js exclusions and `.nuxt` | `.output`, including bundled dependencies |
| Python / Django / FastAPI / Flask | Virtual environments, bytecode, test/type/lint caches and coverage data | Source, media, databases and static output |
| Go | Test binaries and root `coverage.out` | Compiled binaries and `vendor` |
| Java / Maven / Gradle | `.gradle` | `target`, `build`, JAR/WAR files and build wrappers |
| .NET / ASP.NET Core | `.vs`, `obj`, `TestResults`, user IDE settings | `bin` and publish output |
| Ruby / Rails | `node_modules`, local Bundler config, logs, temporary cache/PID/socket files and coverage | Gems, compiled assets and storage |

Every stack includes the Basic rules. These are transfer templates: build
output is often needed on the server, so a project's `.gitignore` is not an
equivalent list. Node.js templates exclude development dependencies; install
server dependencies separately or use a self-contained build. PHP templates
keep `vendor` for servers without Composer.

Paths starting with `/` are relative to the configured `context`, or the
workspace root when `context` is omitted. Adjust stack paths if the context
points to a subdirectory or your layout differs. Templates do not detect or
rewrite project layouts. Any existing `ignoreFile` still contributes its rules.

Existing exclusions remain effective: if an older config contains `src`,
`dist` or another path you now want to transfer, remove that rule yourself.
The command does not remove exclusions inherited from a base config.

## Bitrix: complete ignore list

This template is for code changes on an existing Bitrix site. The installed
core and uploaded media stay on the server: the root `bitrix` and `upload`
directories are excluded entirely. Custom components under
`local/templates/.../components/bitrix` remain transferable, as do frontend
source and build output. Use a different list for a full site migration.

The complete list below includes the shared Basic rules. A bare directory
name excludes it and its contents at any depth; `/bitrix` and `/upload`
apply only at the context root.

```json
{
  "ignore": [
    ".vscode",
    ".git",
    ".github",
    ".idea",
    ".DS_Store",
    "Thumbs.db",
    ".env",
    ".env.*",
    "AGENTS.md",
    "CLAUDE.md",
    ".claude",
    ".cursor",
    "*.log",
    "*.tmp",
    "*.bak",
    "/bitrix",
    "/upload",
    ".codex",
    ".agents",
    ".playwright-cli",
    ".cache",
    "node_modules",
    "local/frontend/**/.vite",
    "local/frontend/**/.vite-temp",
    "coverage",
    "*.sql",
    "*.dump",
    "*.tar",
    "*.tar.gz",
    "*.gz",
    "*.zip",
    "*.old",
    "*.swp",
    "*~",
    "agents.md",
    "SKILLS.md",
    "skills.md",
    "README.md",
    ".vsftp-backup",
    ".sftp-backups",
    "_snapshots"
  ]
}
```

Framework references: [Bitrix directories](https://docs.1c-bitrix.ru/pages/get-started/directory-structure.html),
[Yii2 assets](https://www.yiiframework.com/doc/guide/2.0/en/structure-assets),
[Next.js build cache](https://nextjs.org/docs/pages/guides/ci-build-caching),
[Nuxt production output](https://nuxt.com/docs/4.x/directory-structure/output).
