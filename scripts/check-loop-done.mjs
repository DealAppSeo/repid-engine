/**
 * Turnstile for a loop.
 *
 * Exit 0: PR_NUMBER is set and every required check is green,
 *         or DRY_RUN=1 and the fixture says the same.
 * Exit 1: the checks were read and one is not green.
 * Exit 2: NOT_CHECKED. The PR number is missing, or the checks could not be read.
 *
 * Does not write RepID. Does not talk to Laya.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function dryRunArg() {
  return process.argv.slice(2).some((arg) => arg === 'DRY_RUN=1') || process.env.DRY_RUN === '1';
}

function finish(code, line) {
  console.log(line);
  process.exit(code);
}

function checksAreGreen(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return false;
  return checks.every((check) => {
    const conclusion = String(check.conclusion ?? check.state ?? '').toUpperCase();
    return conclusion === 'SUCCESS' || conclusion === 'GREEN';
  });
}

if (dryRunArg()) {
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'loop-done.json'), 'utf8'));
  } catch {
    finish(2, 'NOT_CHECKED');
  }
  if (!fixture.pr || !checksAreGreen(fixture.checks)) finish(1, 'fail');
  finish(0, 'ok');
}

const pr = process.env.PR_NUMBER;
if (!pr || !/^[0-9]+$/.test(pr)) finish(2, 'NOT_CHECKED');

let raw;
try {
  raw = execFileSync(
    'gh',
    ['pr', 'checks', pr, '--repo', 'DealAppSeo/repid-engine', '--required', '--json', 'name,state,bucket'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch {
  finish(2, 'NOT_CHECKED');
}

let checks;
try {
  checks = JSON.parse(raw);
} catch {
  finish(2, 'NOT_CHECKED');
}

if (!Array.isArray(checks) || checks.length === 0) finish(2, 'NOT_CHECKED');
for (const check of checks) {
  const bucket = String(check.bucket ?? '').toLowerCase();
  const state = String(check.state ?? '').toUpperCase();
  if (bucket === 'fail' || bucket === 'cancel' || state === 'FAILURE' || state === 'CANCELLED') {
    finish(1, 'fail');
  }
  if (bucket !== 'pass' && state !== 'SUCCESS') finish(2, 'NOT_CHECKED');
}
finish(0, 'ok');
