const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8').replace(/\r\n?/g, '\n');
const quality = fs.readFileSync(path.join(root, '.github/workflows/quality.yml'), 'utf8').replace(/\r\n?/g, '\n');

function job(name, nextName) {
  const start = workflow.indexOf(`  ${name}:\n`);
  const end = nextName ? workflow.indexOf(`  ${nextName}:\n`, start + 1) : workflow.length;
  if (start === -1 || end === -1) {
    throw new Error(`Could not find workflow job ${name}.`);
  }
  return workflow.slice(start, end);
}

function jobNames() {
  return [...workflow.matchAll(/^  ([a-z][a-z0-9-]+):$/gm)].map(match => match[1]);
}

function jobNeeds(name) {
  const names = jobNames();
  const index = names.indexOf(name);
  const block = job(name, names[index + 1]);
  const needs = block.match(/^    needs:\n((?:      - .+\n)+)/m);
  return needs
    ? needs[1].trim().split('\n').map(line => line.replace(/^\s*-\s*/, ''))
    : [];
}

function canStart(name, statuses) {
  return jobNeeds(name).every(dependency => statuses[dependency] === 'success');
}

describe('release workflow security and build-once contract', () => {
  test('quality requires every target runner and case-sensitive APFS before release', () => {
    const runners = ['windows-latest', 'ubuntu-22.04', 'ubuntu-24.04', 'ubuntu-26.04',
      'macos-14', 'macos-15', 'macos-26', 'macos-15-intel', 'macos-26-intel'];
    for (const runner of runners) {
      expect(quality.split(`          - ${runner}\n`).length - 1).toBe(2);
    }
    expect(quality).toContain('case-sensitive-apfs:');
    expect(quality).toContain('node scripts/test-case-sensitive-apfs.js');
    expect(quality).toContain('npm run package');
    expect(quality).not.toMatch(/npm\.cmd|tsc\.cmd/);
    expect(job('build', 'validate-marketplace')).toContain('needs: quality');
  });

  test('manual dispatch defaults to dry-run and explicitly retries only existing Open VSX releases', () => {
    const trigger = workflow.slice(0, workflow.indexOf('\njobs:'));
    expect(trigger).toContain('workflow_dispatch:');
    expect(trigger).toContain('tag:');
    expect(trigger).toContain('publish_open_vsx:');
    expect(trigger).toContain('default: false');
    expect(job('quality', 'build')).toContain("!inputs.publish_open_vsx");
    expect(job('publish-open-vsx')).toContain("inputs.publish_open_vsx == true");
    expect(workflow).toContain("if: github.event_name == 'push'");
  });

  test('uses the reusable quality gate and one package-producing build job', () => {
    expect(quality).toContain('workflow_call:');
    expect(workflow).toContain('uses: ./.github/workflows/quality.yml');
    expect(workflow.match(/scripts\/release\.js build/g)).toHaveLength(1);
    expect(workflow.match(/upload-artifact@/g)).toHaveLength(1);
  });

  test('validation jobs use no publish secrets and report the common hash', () => {
    const validation = [
      job('validate-marketplace', 'validate-open-vsx'),
      job('validate-open-vsx', 'validate-github'),
      job('validate-github', 'validation-barrier'),
    ].join('\n');
    expect(validation).not.toMatch(/secrets\.|VSCE_PAT|OVSX_PAT|GH_TOKEN/);
    expect(validation.match(/scripts\/release\.js verify/g)).toHaveLength(3);
    expect(validation.match(/needs\.build\.outputs\.artifact-hash/g)).toHaveLength(3);
  });

  test('publishes GitHub and Open VSX with scoped permissions and no rebuild', () => {
    const github = job('publish-github', 'publish-open-vsx');
    expect(jobNames().filter(name => name.startsWith('publish-'))).toEqual(['publish-github', 'publish-open-vsx']);
    expect(workflow).not.toMatch(/VSCE_PAT|OVSX_PAT|vsce publish/);
    const open = job('publish-open-vsx');
    expect(open).toContain('!cancelled() && (');
    expect(open).toContain('id-token: write');
    expect(open).toContain('contents: read');
    expect(open).toContain('name: release');
    expect(open).toContain('RELEASE_ENABLED');
    expect(open).not.toMatch(/contents: write|npm (?:run )?(?:compile|package)|release\.js build/);
    expect(github).not.toContain('id-token: write');
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
    expect(github).toContain('name: release');
    expect(github).toContain('RELEASE_ENABLED');
    expect(github).toContain('scripts/release.js verify');
    expect(github).not.toMatch(/npm (?:run )?(?:compile|package)|release\.js build/);
    expect(github).toContain('GH_TOKEN');
    expect(github).toContain('contents: write');
    expect(workflow.slice(0, workflow.indexOf('\njobs:'))).toContain('contents: read');
  });

  test('blocks GitHub publication until all channel validators pass', () => {
    const validators = ['validate-marketplace', 'validate-open-vsx', 'validate-github'];
    expect(jobNeeds('validation-barrier')).toEqual(['build', ...validators]);
    expect(jobNeeds('publish-github')).toEqual(['build', 'validation-barrier']);
    expect(jobNeeds('publish-open-vsx')).toEqual(['build', 'validation-barrier']);
    expect(job('publish-open-vsx')).toContain("needs.validation-barrier.result == 'success'");

    const failedValidation = {
      build: 'success',
      'validate-marketplace': 'success',
      'validate-open-vsx': 'failure',
      'validate-github': 'success',
    };
    expect(canStart('validation-barrier', failedValidation)).toBe(false);
    expect(canStart('publish-github', { ...failedValidation, 'validation-barrier': 'skipped' })).toBe(false);

    const validated = {
      build: 'success',
      'validation-barrier': 'success',
    };
    expect(canStart('publish-github', validated)).toBe(true);
  });

  test('delegates GitHub retry recovery to the tested release publisher', () => {
    const github = job('publish-github', 'publish-open-vsx');
    expect(github).toContain(
      'node scripts/publish-github-release.js release-bundle "$GITHUB_REF_NAME"'
    );
    expect(github).not.toContain('gh release create');
  });

  test('pins official actions to immutable commit SHAs', () => {
    const actionUses = `${quality}\n${workflow}`.match(/uses: actions\/[^\s]+/g) || [];
    expect(actionUses.length).toBeGreaterThan(0);
    expect(actionUses.every(value => /@[0-9a-f]{40}$/.test(value))).toBe(true);
  });
});
