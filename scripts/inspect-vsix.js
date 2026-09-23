const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

const FAILURE_ID = 'packaging.inspection-failed';
const TROUBLESHOOTING = 'docs/troubleshooting.md#packaging';
const forbiddenPath = /(?:^|\/)(?:test|tests|__mocks__|fixtures|node_modules|\.vscode|\.kent-tmp)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx|crt|cer|log)$|release-readiness-roadmap|preview-sync-feature-spec/i;
const textFile = /\.(?:js|json|md|txt|xml|ya?ml|css|html|schema)$/i;
const canaries = [
  'PW-8a751a67-246f-4a51',
  'PP-8da76fe1-06bf-48b8',
  'KI-6df65e87-9839-4737',
  'conflict-password-canary-2d719b2c',
  'SFTPSYNC8_PACKAGE_CANARY_37c7ef84',
];

function redactedMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/\bPASS\s+[^\r\n]*/gi, 'PASS [REDACTED]');
  for (const canary of canaries) {
    message = message.split(canary).join('[REDACTED]');
  }
  return message;
}

function inspectVsix(vsixPath) {
  const vsix = path.resolve(vsixPath || 'sftp-sync-ai-0.1.0.vsix');
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(vsix)) {
      reject(new Error(`VSIX not found: ${vsix}`));
      return;
    }

    yauzl.open(vsix, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError || new Error('VSIX could not be opened.'));
        return;
      }
      const entries = [];
      const violations = [];
      let settled = false;
      const fail = error => {
        if (!settled) {
          settled = true;
          zip.close();
          reject(error);
        }
      };

      zip.readEntry();
      zip.on('error', fail);
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
          if (streamError || !stream) {
            fail(streamError || new Error(`Could not inspect ${name}`));
            return;
          }
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (canaries.some(canary => text.includes(canary))) {
              violations.push(`secret canary in ${name}`);
            }
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        if (violations.length > 0) {
          reject(new Error(`VSIX security inspection failed:\n${violations.join('\n')}`));
          return;
        }
        resolve(entries.length);
      });
    });
  });
}

function formatInspectionFailure(error) {
  return [
    `[${FAILURE_ID}] Package inspection failed.`,
    'Next step: review the redacted local output, fix the VSIX contents, and rebuild.',
    `Troubleshooting: ${TROUBLESHOOTING}`,
    `Detail: ${redactedMessage(error)}`,
  ].join('\n');
}

async function main() {
  try {
    const entries = await inspectVsix(process.argv[2]);
    process.stdout.write(
      `VSIX security inspection passed: ${entries} entries, no forbidden paths or secret canaries.\n`
    );
  } catch (error) {
    process.stderr.write(`${formatInspectionFailure(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  formatInspectionFailure,
  inspectVsix,
};

if (require.main === module) {
  void main();
}
