const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

if (process.platform !== 'darwin' || !process.env.RUNNER_TEMP) {
  throw new Error('This check requires a macOS CI runner with RUNNER_TEMP.');
}
const runnerRoot = fs.realpathSync(process.env.RUNNER_TEMP);
const root = fs.mkdtempSync(path.join(runnerRoot, 'sftpsync-apfs-'));
const relative = path.relative(runnerRoot, fs.realpathSync(root));
if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  throw new Error('APFS test directory escaped RUNNER_TEMP.');
}
const image = path.join(root, 'case-sensitive.sparseimage');
const mount = path.join(root, 'mount');
let mounted = false;
try {
  fs.mkdirSync(mount);
  execFileSync('hdiutil', ['create', '-size', '1g', '-type', 'SPARSE', '-fs', 'APFSX', '-volname', 'SFTPSyncCaseTest', image], { stdio: 'inherit' });
  execFileSync('hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, image], { stdio: 'inherit' });
  mounted = true;
  fs.writeFileSync(path.join(mount, 'CaseProbe'), 'upper', { flag: 'wx' });
  fs.writeFileSync(path.join(mount, 'caseprobe'), 'lower', { flag: 'wx' });
  if (fs.statSync(path.join(mount, 'CaseProbe')).ino === fs.statSync(path.join(mount, 'caseprobe')).ino) {
    throw new Error('Mounted APFS volume is not case-sensitive.');
  }
  const result = spawnSync(process.execPath, [
    'node_modules/jest/bin/jest.js', '--runInBand',
    'test/helper/paths.spec.js', 'test/helper/localPaths.spec.js',
    'test/core/localPermissions.spec.js',
    'test/modules/watcherSuppression.spec.js',
    'test/modules/downloadWatcher.spec.js',
    'test/modules/downloadWatcher.scale.spec.js',
    'test/modules/downloadWatcher.protocol.spec.js',
  ], { stdio: 'inherit', env: { ...process.env, TMPDIR: mount } });
  if (result.error) throw result.error;
  process.exitCode = result.status === 0 ? 0 : 1;
} finally {
  // Never recursively remove an attached volume if detaching fails.
  if (mounted) execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit' });
  fs.rmSync(root, { recursive: true, force: true });
}
