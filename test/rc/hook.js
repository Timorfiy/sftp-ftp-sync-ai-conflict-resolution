// An opt-in, disposable hook marker outside the synchronized workspace.
require('node:fs').appendFileSync(process.argv[2], 'executed\n');
