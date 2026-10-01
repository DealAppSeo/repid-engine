/**
 * Count disagreements in the sim-hal-traps table.
 * A row counts when its first_pass verdict differs from its post_hal verdict.
 * The percent is the fixture only. Live accuracy stays NOT_CHECKED.
 * Reads that script's stdout only. Does not insert a row.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'sim-hal-traps.mjs');
const HEADER = 'trap\tfirst_pass\tpost_hal\tdisagree';

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function verdict(cell, label) {
  if (cell === '0' || cell === 0) fail(`${label} printed 0`);
  if (cell !== 'TRUE' && cell !== 'FALSE' && cell !== 'NOT_CHECKED') fail(`${label} printed ${cell}`);
  return cell;
}

const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
if (run.status !== 0) fail((run.stderr || 'sim-hal-traps failed').trim());

const lines = run.stdout.trim().split(/\r?\n/);
if (lines[0] !== HEADER) fail('unexpected header');
const rows = lines.slice(1);
if (rows.length !== 10) fail(`expected 10 rows, got ${rows.length}`);

let disagreement = 0;
for (const line of rows) {
  const cell = line.split('\t');
  if (cell.length !== 4) fail('short row');
  const first = verdict(cell[1], 'first_pass');
  const post = verdict(cell[2], 'post_hal');
  const disagree = verdict(cell[3], 'disagree');
  if (disagree === '0' || disagree === 0) fail('disagree printed 0');
  if (first === 'NOT_CHECKED' || post === 'NOT_CHECKED') {
    if (disagree !== 'NOT_CHECKED') fail('a missing pass was scored as a disagreement');
    continue;
  }
  if (first !== post && disagree !== 'TRUE') fail('disagree missed a split');
  if (first === post && disagree !== 'FALSE') fail('disagree marked an agreement');
  if (disagree === 'TRUE') disagreement += 1;
}

const fixturePct = Math.round((disagreement / rows.length) * 100);
if (!Number.isInteger(fixturePct)) fail('fixture percent is not an integer');
process.stdout.write(
  `disagreement\t${disagreement}\nfixture_disagreement_pct\t${fixturePct}\nlive_accuracy\tNOT_CHECKED\n`,
);
