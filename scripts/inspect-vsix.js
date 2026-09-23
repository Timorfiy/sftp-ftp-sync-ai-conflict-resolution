const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

const vsix = path.resolve(process.argv[2] || 'sftp-sync-ai-0.1.0.vsix');
const forbiddenPath = /(?:^|\/)(?:test|tests|__mocks__|fixtures|node_modules|\.vscode|\.kent-tmp)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx|crt|cer|log)$|release-readiness-roadmap|preview-sync-feature-spec/i;
const textFile = /\.(?:js|json|md|txt|xml|ya?ml|css|html|schema)$/i;
const canaries = [
  'PW-8a751a67-246f-4a51',
  'PP-8da76fe1-06bf-48b8',
  'KI-6df65e87-9839-4737',
  'conflict-password-canary-2d719b2c',
  'SFTPSYNC8_PACKAGE_CANARY_37c7ef84',
];

if (!fs.existsSync(vsix)) {
  throw new Error(`VSIX not found: ${vsix}`);
}

yauzl.open(vsix, { lazyEntries: true }, (openError, zip) => {
  if (openError) {
    throw openError;
  }
  const entries = [];
  const violations = [];
  zip.readEntry();
  zip.on('entry', entry => {
    const name = entry.fileName.replace(/\\/g, '/');
    entries.push(name);
    if (forbiddenPath.test(name)) {
      violations.push(`forbidden path: ${name}`);
    }
    if (/\/$/.test(name) || !textFile.test(name)) {
      zip.readEntry();
      return;
    }
    zip.openReadStream(entry, (streamError, stream) => {
      if (streamError) {
        throw streamError;
      }
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        for (const canary of canaries) {
          if (text.includes(canary)) {
            violations.push(`secret canary in ${name}: ${canary}`);
          }
        }
        zip.readEntry();
      });
    });
  });
  zip.on('end', () => {
    if (violations.length > 0) {
      throw new Error(`VSIX security inspection failed:\n${violations.join('\n')}`);
    }
    process.stdout.write(
      `VSIX security inspection passed: ${entries.length} entries, no forbidden paths or secret canaries.\n`
    );
  });
});
