const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const {
  formatInspectionFailure,
  inspectVsix,
} = require('../scripts/inspect-vsix');

function createVsix(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sftpsync-package-'));
  const filename = path.join(root, 'fixture.vsix');
  const zip = new yazl.ZipFile();
  for (const [name, content] of entries) {
    zip.addBuffer(Buffer.from(content), name);
  }
  zip.end();
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filename);
    output.on('close', () => resolve({ filename, root }));
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
  });
}

describe('VSIX actionable packaging inspection', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length > 0) {
      fs.rmSync(roots.pop(), { recursive: true, force: true });
    }
  });

  test('missing VSIX produces an actionable packaging failure', async () => {
    await expect(inspectVsix(path.join(os.tmpdir(), 'missing-r8.vsix'))).rejects.toThrow(
      /VSIX not found/
    );
    const output = formatInspectionFailure(new Error('VSIX not found'));
    expect(output).toContain('[packaging.inspection-failed]');
    expect(output).toContain('docs/troubleshooting.md#packaging');
  });

  test('forbidden content names the path without dumping package contents', async () => {
    const fixture = await createVsix([
      ['extension/test/fixture.txt', 'ordinary fixture content'],
    ]);
    roots.push(fixture.root);

    await expect(inspectVsix(fixture.filename)).rejects.toThrow(
      /forbidden path: extension\/test\/fixture.txt/
    );
  });

  test('secret canaries are detected but redacted from CLI diagnostics', async () => {
    const canary = 'SFTPSYNC8_PACKAGE_CANARY_37c7ef84';
    const fixture = await createVsix([
      ['extension/README.md', `accidental ${canary}`],
    ]);
    roots.push(fixture.root);

    let error;
    try {
      await inspectVsix(fixture.filename);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('secret canary in extension/README.md');
    const output = formatInspectionFailure(error);
    expect(output).not.toContain(canary);
    expect(output).toContain('packaging.inspection-failed');
  });
});
