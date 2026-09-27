/**
 * One tick of the dispatch bus.
 *
 * DRY_RUN=1 (argument or env) exits 0 and does not read a queue.
 * An empty queue prints docs/dispatch/TEMPLATES.md when that file exists.
 * If the queue is empty and the template file is missing, exit 2 (NOT_CHECKED).
 * Does not write RepID and does not call token signup.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const templatesPath = join(root, 'docs', 'dispatch', 'TEMPLATES.md');

function dryRun() {
  return process.argv.slice(2).some((arg) => arg === 'DRY_RUN=1') || process.env.DRY_RUN === '1';
}

if (dryRun()) {
  console.log('ok');
  process.exit(0);
}

if (!existsSync(templatesPath)) {
  console.log('NOT_CHECKED');
  process.exit(2);
}

const text = readFileSync(templatesPath, 'utf8').trim();
if (!text) {
  console.log('NOT_CHECKED');
  process.exit(2);
}

process.stdout.write(text + '\n');
process.exit(0);
