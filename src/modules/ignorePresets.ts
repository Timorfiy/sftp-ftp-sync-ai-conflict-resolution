import { applyEdits, modify } from 'jsonc-parser';

export const BASE_IGNORE_PATTERNS = [
  '.vscode', '.git', '.github', '.idea', '.DS_Store', 'Thumbs.db',
  '.env', '.env.*', 'AGENTS.md', 'CLAUDE.md', '.claude', '.cursor',
  '*.log', '*.tmp', '*.bak',
];

const nodePatterns = ['node_modules', '.npm', '.pnpm-store', 'coverage', '.nyc_output'];
const phpPatterns = ['node_modules', '.phpunit.cache', '.phpunit.result.cache', '.php-cs-fixer.cache'];

// Transfer presets keep application source and deployable build output.
export const IGNORE_PRESETS = [
  { label: 'Basic', description: 'Editor files, Git, environment files and logs', patterns: [] },
  { label: 'Bitrix', description: 'Existing site: excludes /bitrix, /upload, dumps and backups; keeps local and frontend builds', patterns: [
    '/bitrix', '/upload',
    '.kent-tmp', '.codex', '.agents', '.playwright-cli', '.cache',
    'node_modules', 'local/frontend/**/.vite', 'local/frontend/**/.vite-temp', 'coverage',
    '*.sql', '*.dump', '*.tar', '*.tar.gz', '*.gz', '*.zip', '*.old', '*.swp', '*~',
    'agents.md', 'SKILLS.md', 'skills.md', 'README.md',
    '.vsftp-backup', '.sftp-backups', '_snapshots',
  ] },
  { label: 'WordPress', description: 'PHP tools, cache and upgrade files; keeps themes, plugins and uploads', patterns: [
    ...phpPatterns, '/wp-content/cache', '/wp-content/upgrade', '/wp-content/upgrade-temp-backup',
  ] },
  { label: 'PHP / Composer', description: 'PHP tool caches; keeps vendor for FTP deployments', patterns: phpPatterns },
  { label: 'Laravel', description: 'PHP tools, runtime cache, sessions and logs; keeps storage/app and vendor', patterns: [
    ...phpPatterns, '/storage/framework/cache', '/storage/framework/sessions',
    '/storage/framework/views', '/storage/logs', '/bootstrap/cache',
  ] },
  { label: 'Yii2', description: 'PHP tools, runtime and published assets for basic and advanced apps', patterns: [
    ...phpPatterns, '/runtime', '/web/assets', '/frontend/runtime', '/frontend/web/assets',
    '/backend/runtime', '/backend/web/assets', '/console/runtime',
  ] },
  { label: 'Node.js', description: 'Dependencies and tool caches; install dependencies on the server', patterns: nodePatterns },
  { label: 'React / Vue / Vite', description: 'Node dependencies and Vite cache; keeps src, public and dist', patterns: [
    ...nodePatterns, '.vite',
  ] },
  { label: 'Next.js', description: 'Node dependencies and Next cache; keeps .next build output', patterns: [
    ...nodePatterns, '/.next/cache', '!/.next/standalone/**/node_modules',
  ] },
  { label: 'Nuxt 3 / 4', description: 'Node dependencies and generated dev files; keeps .output', patterns: [
    ...nodePatterns, '/.nuxt', '!/.output/**/node_modules',
  ] },
  { label: 'Python / Django / FastAPI / Flask', description: 'Virtual environments, bytecode and tool caches; keeps media and databases', patterns: [
    '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
    '.ruff_cache', '.tox', '.nox', '.coverage', '.coverage.*', 'htmlcov',
  ] },
  { label: 'Go', description: 'Test binaries and coverage files; keeps binaries and vendor', patterns: [
    '*.test', '/coverage.out',
  ] },
  { label: 'Java / Maven / Gradle', description: 'Gradle caches; keeps target, build and build wrappers', patterns: [
    '.gradle',
  ] },
  { label: '.NET / ASP.NET Core', description: 'IDE and intermediate files; keeps bin and publish output', patterns: [
    '.vs', 'obj', 'TestResults', '*.user', '*.suo',
  ] },
  { label: 'Ruby / Rails', description: 'Local bundle config, runtime caches and logs; keeps gems, assets and storage', patterns: [
    'node_modules', '/.bundle', '/log', '/tmp/cache', '/tmp/pids', '/tmp/sockets', '/coverage',
  ] },
].map(preset => ({ ...preset, patterns: [...BASE_IGNORE_PATTERNS, ...preset.patterns] }));

export interface IgnoreConfigTarget {
  path: (string | number)[];
  label: string;
  host: string;
  ignore: string[];
  inheritedIgnore: string[];
}

export function getIgnoreConfigTargets(text: string): IgnoreConfigTarget[] {
  const parsed = JSON.parse(text);
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  const targets: IgnoreConfigTarget[] = [];
  const checkObject = (value: any) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('sftp.json must contain configuration objects.');
    }
  };
  const readIgnore = (value: any): string[] => {
    checkObject(value);
    if (value.ignore !== undefined &&
        (!Array.isArray(value.ignore) || value.ignore.some(pattern => typeof pattern !== 'string'))) {
      throw new Error('The ignore field in sftp.json must be an array of strings.');
    }
    return value.ignore || [];
  };
  roots.forEach((config, index) => {
    const ignore = readIgnore(config);
    const basePath = Array.isArray(parsed) ? [index] : [];
    const label = config.name || `Connection ${index + 1}`;
    targets.push({
      path: basePath, label: `${label} — base configuration`, host: config.host || '',
      ignore, inheritedIgnore: [],
    });
    if (config.profiles !== undefined) {
      checkObject(config.profiles);
      Object.entries(config.profiles).forEach(([name, profile]: [string, any]) => {
        const profileIgnore = readIgnore(profile);
        targets.push({
          path: [...basePath, 'profiles', name], label: `${label} — ${name}`, host: profile.host || config.host || '',
          ignore: profileIgnore, inheritedIgnore: ignore,
        });
      });
    }
  });
  return targets;
}

export function applyIgnorePreset(text: string, target: IgnoreConfigTarget, patterns: string[]): string {
  const existing = new Set([...target.inheritedIgnore, ...target.ignore]);
  const additions = patterns.filter(pattern => !existing.has(pattern));
  if (!additions.length) return text;
  const indent = text.match(/\n([\t ]+)"/)?.[1] || '  ';
  // Keep user rules last so their ordered negations can override the template.
  return applyEdits(text, modify(text, [...target.path, 'ignore'], [...additions, ...target.ignore], {
    formattingOptions: {
      insertSpaces: !indent.includes('\t'), tabSize: indent.length,
      eol: text.includes('\r\n') ? '\r\n' : '\n',
    },
  }));
}
