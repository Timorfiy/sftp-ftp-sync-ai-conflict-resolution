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
  test('manual dispatch is secretless and cannot enable publication', () => {
    const trigger = workflow.slice(0, workflow.indexOf('\njobs:'));
    expect(trigger).toContain('workflow_dispatch:');
    expect(trigger).toContain('tag:');
    expect(trigger).not.toMatch(/publish|release.enabled/i);
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

  test('publish jobs are independent, protected, guarded, and never rebuild', () => {
    const marketplace = job('publish-marketplace', 'publish-open-vsx');
    const openVsx = job('publish-open-vsx', 'publish-github');
    const github = job('publish-github');
    for (const publishJob of [marketplace, openVsx, github]) {
      expect(publishJob).toContain('name: release');
      expect(publishJob).toContain('RELEASE_ENABLED');
      expect(publishJob).toContain('scripts/release.js verify');
      expect(publishJob).not.toMatch(/npm (?:run )?(?:compile|package)|release\.js build/);
    }
    expect(marketplace).toContain('secrets.VSCE_PAT');
    expect(marketplace).not.toMatch(/OVSX_PAT|GH_TOKEN|contents: write/);
    expect(openVsx).toContain('secrets.OVSX_PAT');
    expect(openVsx).not.toMatch(/VSCE_PAT|GH_TOKEN|contents: write/);
    expect(github).toContain('GH_TOKEN');
    expect(github).toContain('contents: write');
    expect(workflow.slice(0, workflow.indexOf('\njobs:'))).toContain('contents: read');
  });

  test('blocks every publisher until all validators pass without coupling publishers', () => {
    const validators = ['validate-marketplace', 'validate-open-vsx', 'validate-github'];
    const publishers = ['publish-marketplace', 'publish-open-vsx', 'publish-github'];
    expect(jobNeeds('validation-barrier')).toEqual(['build', ...validators]);
    for (const publisher of publishers) {
      expect(jobNeeds(publisher)).toEqual(['build', 'validation-barrier']);
    }

    const failedValidation = {
      build: 'success',
      'validate-marketplace': 'success',
      'validate-open-vsx': 'failure',
      'validate-github': 'success',
    };
    expect(canStart('validation-barrier', failedValidation)).toBe(false);
    for (const publisher of publishers) {
      expect(canStart(publisher, { ...failedValidation, 'validation-barrier': 'skipped' })).toBe(
        false
      );
    }

    const validated = {
      build: 'success',
      'validation-barrier': 'success',
    };
    expect(publishers.every(publisher => canStart(publisher, validated))).toBe(true);
    expect(
      publishers.every(
        publisher => jobNeeds(publisher).filter(dependency => publishers.includes(dependency)).length === 0
      )
    ).toBe(true);
  });

  test('delegates GitHub retry recovery to the tested release publisher', () => {
    const github = job('publish-github');
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
