const fs = require('fs');
const os = require('os');
const path = require('path');
const { publishGitHubRelease } = require('../scripts/publish-github-release');

function createBundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftpsync-github-release-'));
  const vsix = 'sftp-sync-ai-0.1.0.vsix';
  const notes = '## 0.1.0 - 2026-09-24\n\nRelease notes.\n';
  const assetContent = {
    [vsix]: Buffer.from('immutable-vsix'),
    [`${vsix}.sha256`]: Buffer.from(`hash  ${vsix}\n`),
  };
  fs.writeFileSync(path.join(root, 'release-notes.md'), notes);
  fs.writeFileSync(
    path.join(root, 'provenance.json'),
    JSON.stringify({ tag: 'v0.1.0', artifact: { name: vsix } })
  );
  for (const [name, content] of Object.entries(assetContent)) {
    fs.writeFileSync(path.join(root, name), content);
  }
  return { root, notes, assetContent };
}

function fakeGitHub({
  bundle,
  exists = true,
  draft = false,
  notes = bundle.notes,
  assets = bundle.assetContent,
  failEdit = false,
  remainDraft = false,
} = {}) {
  const commands = [];
  const state = {
    exists,
    draft,
    notes,
    assets: new Map(Object.entries(assets)),
  };
  const runner = args => {
    commands.push(args);
    const command = args.slice(0, 2).join(' ');
    if (command === 'release view') {
      if (!state.exists) {
        return { status: 1, stdout: '', stderr: 'release not found' };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          tagName: 'v0.1.0',
          body: state.notes,
          isDraft: state.draft,
          isPrerelease: false,
          assets: [...state.assets.keys()].map(name => ({ name })),
        }),
        stderr: '',
      };
    }
    if (command === 'release create') {
      state.exists = true;
      state.draft = false;
      state.notes = bundle.notes;
      for (const assetPath of args.slice(args.indexOf('--notes-file') + 2)) {
        state.assets.set(path.basename(assetPath), fs.readFileSync(assetPath));
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'release download') {
      const name = args[args.indexOf('--pattern') + 1];
      const destination = args[args.indexOf('--dir') + 1];
      fs.writeFileSync(path.join(destination, name), state.assets.get(name));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'release upload') {
      const assetPath = args[3];
      state.assets.set(path.basename(assetPath), fs.readFileSync(assetPath));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'release edit') {
      if (failEdit) {
        return { status: 1, stdout: '', stderr: 'publication failed' };
      }
      if (!remainDraft) {
        state.draft = false;
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 99, stdout: '', stderr: `Unexpected command: ${args.join(' ')}` };
  };
  return { commands, runner, state };
}

describe('idempotent GitHub Release publication', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length > 0) {
      fs.rmSync(roots.pop(), { recursive: true, force: true });
    }
  });

  function bundle() {
    const value = createBundle();
    roots.push(value.root);
    return value;
  }

  test('creates and verifies a missing release with --verify-tag', async () => {
    const fixture = bundle();
    const fake = fakeGitHub({ bundle: fixture, exists: false, assets: {} });
    await publishGitHubRelease({
      bundleDir: fixture.root,
      tag: 'v0.1.0',
      runner: fake.runner,
    });

    const create = fake.commands.find(args => args[1] === 'create');
    expect(create).toContain('--verify-tag');
    expect(fake.state.draft).toBe(false);
  });

  test('completes an interrupted draft only after matching notes and assets', async () => {
    const fixture = bundle();
    const fake = fakeGitHub({ bundle: fixture, draft: true });
    await publishGitHubRelease({
      bundleDir: fixture.root,
      tag: 'v0.1.0',
      runner: fake.runner,
    });

    expect(fake.commands).toContainEqual([
      'release',
      'edit',
      'v0.1.0',
      '--draft=false',
    ]);
    expect(fake.state.draft).toBe(false);
  });

  test('uploads a missing draft asset and then publishes the verified draft', async () => {
    const fixture = bundle();
    const [vsix] = Object.keys(fixture.assetContent);
    const fake = fakeGitHub({
      bundle: fixture,
      draft: true,
      assets: { [vsix]: fixture.assetContent[vsix] },
    });
    await publishGitHubRelease({
      bundleDir: fixture.root,
      tag: 'v0.1.0',
      runner: fake.runner,
    });

    expect(fake.commands.some(args => args[1] === 'upload')).toBe(true);
    expect(fake.commands.some(args => args[1] === 'edit')).toBe(true);
    expect(fake.state.assets.size).toBe(2);
    expect(fake.state.draft).toBe(false);
  });

  test('leaves an identical published release unchanged', async () => {
    const fixture = bundle();
    const fake = fakeGitHub({ bundle: fixture });
    await publishGitHubRelease({
      bundleDir: fixture.root,
      tag: 'v0.1.0',
      runner: fake.runner,
    });

    expect(fake.commands.some(args => ['create', 'upload', 'edit'].includes(args[1]))).toBe(
      false
    );
  });

  test('rejects mismatched notes or an existing asset without mutation', async () => {
    const notesFixture = bundle();
    const wrongNotes = fakeGitHub({ bundle: notesFixture, draft: true, notes: 'different' });
    await expect(
      publishGitHubRelease({
        bundleDir: notesFixture.root,
        tag: 'v0.1.0',
        runner: wrongNotes.runner,
      })
    ).rejects.toThrow('notes differ');
    expect(wrongNotes.commands.some(args => ['upload', 'edit'].includes(args[1]))).toBe(false);

    const assetFixture = bundle();
    const [vsix, checksum] = Object.keys(assetFixture.assetContent);
    const wrongAsset = fakeGitHub({
      bundle: assetFixture,
      draft: true,
      assets: {
        [vsix]: Buffer.from('different'),
        [checksum]: assetFixture.assetContent[checksum],
      },
    });
    await expect(
      publishGitHubRelease({
        bundleDir: assetFixture.root,
        tag: 'v0.1.0',
        runner: wrongAsset.runner,
      })
    ).rejects.toThrow('asset differs');
    expect(wrongAsset.commands.some(args => ['upload', 'edit'].includes(args[1]))).toBe(false);
  });

  test('fails visibly when final draft publication fails or remains a draft', async () => {
    const failedFixture = bundle();
    const failed = fakeGitHub({ bundle: failedFixture, draft: true, failEdit: true });
    await expect(
      publishGitHubRelease({
        bundleDir: failedFixture.root,
        tag: 'v0.1.0',
        runner: failed.runner,
      })
    ).rejects.toThrow('publication failed');

    const staleFixture = bundle();
    const stale = fakeGitHub({ bundle: staleFixture, draft: true, remainDraft: true });
    await expect(
      publishGitHubRelease({
        bundleDir: staleFixture.root,
        tag: 'v0.1.0',
        runner: stale.runner,
      })
    ).rejects.toThrow('did not reach a published state');
  });
});
