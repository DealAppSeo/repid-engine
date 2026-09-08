#!/usr/bin/env node
/**
 * check-all — run every `check:*` script in package.json, by DISCOVERY.
 *
 * WHY A DISCOVERY RULE AND NOT A CHAIN. The sibling repo learned this the
 * expensive way: a single hand-maintained `check:a && check:b && ...` line was
 * one shared string that five PRs fought over in a night, and it silently kept
 * five suites — 145 assertions — out of CI, because adding one meant editing
 * that line and nobody did. A discovery rule picks up the next check with no
 * config change and nobody to remember. Same reasoning as `jest.config.js`
 * rooting at `src` rather than naming directories.
 *
 * WHY THIS EXISTS HERE AT ALL. On 2026-09-08 a guard was added to this repo as
 * a `check:*` script on the explicit instruction that "the runner discovers
 * check:* automatically". That is true in `trinity-ecosystem`. It was NOT true
 * here — this repo had no runner, so `npm run check:named-env-vars` was invoked
 * by no workflow and no script. It happened to be wired anyway because its Jest
 * test spawns the real script, but that was luck, not design: the next
 * `check:*` added without a Jest wrapper would have been inert while looking
 * covered. That is LESSONS rule 3 — a mechanism wired at one end only is worse
 * than an absent one, because it converts a known gap into false coverage.
 *
 * ZERO CHECKS IS NOT A PASS. If discovery finds no `check:*` scripts, this
 * exits NOT_CHECKED rather than 0. "Nothing to run, therefore green" is the
 * vacuous pass the whole convention exists to prevent — it is what a broken
 * matcher looks like from the outside.
 *
 * EXIT CODES, and a divergence worth stating rather than silently picking a
 * side. `trinity-ecosystem` documents 2 = NOT_CHECKED; `trustshell` and this
 * repo's own `check:named-env-vars` use 3. Both are in use across the three
 * repos today. So BOTH 2 and 3 are read as NOT_CHECKED here. Reading a
 * NOT_CHECKED as FAILED would be merely noisy; reading it as VERIFIED is the
 * defect that cost this system a 12-day outage, and neither number is ever 0.
 *
 *   0  VERIFIED     every check passed
 *   1  FAILED       at least one check failed
 *   2  NOT_CHECKED  no check failed, but at least one could not run
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const EXIT = { VERIFIED: 0, FAILED: 1, NOT_CHECKED: 2 };
/** Codes a child may use to say "I could not check", across the three repos. */
const NOT_CHECKED_CODES = new Set([2, 3]);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const names = Object.keys(pkg.scripts ?? {})
  .filter((n) => n.startsWith('check:'))
  .sort();

if (names.length === 0) {
  console.error('NOT_CHECKED — discovery found no `check:*` scripts in package.json.');
  console.error('  This is not "nothing to do, so green": a matcher that finds nothing');
  console.error('  looks exactly like a matcher that is broken. Add a check, or fix this.');
  process.exit(EXIT.NOT_CHECKED);
}

const rows = [];
for (const name of names) {
  const r = spawnSync('npm', ['run', '--silent', name], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  // A child killed by a signal has no exit code. That is not a pass.
  const code = r.status === null ? EXIT.FAILED : r.status;
  const verdict = code === 0 ? 'VERIFIED' : NOT_CHECKED_CODES.has(code) ? 'NOT_CHECKED' : 'FAILED';
  rows.push({ name, code, verdict });
}

console.log('\n=== check-all ===');
for (const { name, code, verdict } of rows) {
  console.log(`  ${verdict.padEnd(11)} exit=${String(code).padEnd(3)} ${name}`);
}

const failed = rows.filter((r) => r.verdict === 'FAILED');
const notChecked = rows.filter((r) => r.verdict === 'NOT_CHECKED');

if (failed.length > 0) {
  console.error(`\nFAILED — ${failed.length} of ${rows.length}: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(EXIT.FAILED);
}
if (notChecked.length > 0) {
  console.error(`\nNOT_CHECKED — ${notChecked.length} of ${rows.length} could not run: ${notChecked.map((r) => r.name).join(', ')}`);
  console.error('  Not a pass. A build where a guard could not run is not a verified build.');
  process.exit(EXIT.NOT_CHECKED);
}
console.log(`\nVERIFIED — ${rows.length} check${rows.length === 1 ? '' : 's'} passed.`);
process.exit(EXIT.VERIFIED);
