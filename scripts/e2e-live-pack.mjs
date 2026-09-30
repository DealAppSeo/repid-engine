/**
 * Reads scripts/fixtures/live-claims.json only.
 * Calls the fixture verify path when HAL_QUORUM_RECEIPT_ENABLED is the exact string true.
 * Otherwise prints skipped and inserts nothing.
 * This script does not open a database or a network connection.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-claims.json');
const claims = JSON.parse(readFileSync(fixturePath, 'utf8'));

function word(value) {
  if (value === 'TRUE' || value === 'FALSE') return value;
  return 'NOT_CHECKED';
}

function line(claim, status) {
  return `${claim.id}\t${word(claim.first_pass_verdict)}\t${word(claim.post_hal_verdict)}\t${claim.family}\t${claim.host}\t${status}\n`;
}

if (process.env.HAL_QUORUM_RECEIPT_ENABLED !== 'true') {
  for (const claim of claims) process.stdout.write(line(claim, 'skipped'));
} else {
  const require = createRequire(import.meta.url);
  require('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: {
      module: 'commonjs',
      moduleResolution: 'node',
      esModuleInterop: true,
      target: 'es2022',
      ignoreDeprecations: '6.0',
    },
  });
  const { runLivePack } = require('../src/hal/live-pack.ts');
  const client = {
    from() {
      return {
        select() {
          return {
            async limit() {
              return { error: null };
            },
          };
        },
        async insert(row) {
          if (Object.prototype.hasOwnProperty.call(row, 'user_id')) {
            throw new Error('user id is not a vote field');
          }
          return { error: null };
        },
      };
    },
  };
  const { lines } = await runLivePack(claims, client, process.env);
  for (const text of lines) process.stdout.write(`${text}\n`);
}
