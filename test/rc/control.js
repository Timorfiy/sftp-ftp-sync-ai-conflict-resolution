const fs = require('node:fs/promises');
const path = require('node:path');

async function request(root, body) {
  const { port, token } = JSON.parse(await fs.readFile(path.join(root, 'control.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(100000),
  });
  const result = await response.json();
  if (!result.ok) throw new Error(result.error);
  return result.result;
}
module.exports = request;
if (require.main === module) {
  request(process.argv[2], JSON.parse(process.argv[3])).then(
    result => console.log(JSON.stringify(result, null, 2)),
    error => { console.error(error.message); process.exitCode = 1; }
  );
}
