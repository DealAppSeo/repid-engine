/**
 * First run reads scripts/fixtures/hal-traps.json and prints arms A, B, and C as FIXTURE.
 * A calls JSON path, when present, is the only file read. It does not call a vendor.
 * A missing family is NOT_CHECKED, never 0.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const trapsPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hal-traps.json');
const ARMS = ['A', 'B', 'C'];

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function word(value) {
  if (value === 0 || value === '0') return 'NOT_CHECKED';
  if (value === undefined || value === null || value === '') return 'NOT_CHECKED';
  return String(value);
}

function percent(part, whole) {
  if (!Number.isFinite(whole) || whole <= 0) return 'NOT_CHECKED';
  const rate = Math.round((part / whole) * 100);
  if (rate === 0 && part !== 0) fail('rate collapsed to 0');
  return String(rate);
}

function readCall(row) {
  const family = word(row.family);
  const host = word(row.host);
  const arm = word(row.arm);
  const verdict = word(row.verdict);
  const armOk = ARMS.includes(arm);
  const verdictOk = verdict === 'TRUE' || verdict === 'FALSE';
  const refused = family === 'NOT_CHECKED' || host === 'NOT_CHECKED' || !armOk || !verdictOk;
  return {
    family,
    host,
    arm: armOk ? arm : 'NOT_CHECKED',
    verdict: verdictOk ? verdict : 'NOT_CHECKED',
    refused,
  };
}

function printFixture() {
  const traps = JSON.parse(readFileSync(trapsPath, 'utf8'));
  if (!Array.isArray(traps.claims) || traps.claims.length !== 10) fail('hal traps fixture missing');
  const lines = [
    'arm\tA\tFIXTURE',
    'arm\tB\tFIXTURE',
    'arm\tC\tFIXTURE',
    'error_rate\tNOT_CHECKED',
    'refuse_rate\tNOT_CHECKED',
    'same_direction_miss\tNOT_CHECKED',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printCalls(rows) {
  if (!Array.isArray(rows) || rows.length === 0) fail('calls file has no rows');
  const lines = [];
  const byHost = new Map();
  let refused = 0;
  let closed = 0;
  let errors = 0;
  for (const row of rows) {
    const call = readCall(row);
    if (call.family === '0' || call.family === 0) fail('missing family printed 0');
    lines.push(['arm', call.arm, call.family, call.host, call.verdict].join('\t'));
    if (call.refused) {
      refused += 1;
      continue;
    }
    closed += 1;
    if (call.verdict === 'FALSE') errors += 1;
    const group = byHost.get(call.host) ?? [];
    group.push(call.verdict);
    byHost.set(call.host, group);
  }
  let sameDirection = 0;
  let comparable = 0;
  for (const verdicts of byHost.values()) {
    if (verdicts.length < 2) continue;
    comparable += 1;
    if (verdicts.every((verdict) => verdict === 'FALSE')) sameDirection += 1;
  }
  lines.push(`error_rate\t${percent(errors, closed)}`);
  lines.push(`refuse_rate\t${percent(refused, rows.length)}`);
  lines.push(`same_direction_miss\t${comparable === 0 ? 'NOT_CHECKED' : String(sameDirection)}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

const callsArg = process.argv[2];
if (callsArg) {
  if (!existsSync(callsArg)) fail('calls file missing');
  printCalls(JSON.parse(readFileSync(callsArg, 'utf8')));
} else {
  printFixture();
}
