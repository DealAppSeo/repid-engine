/**
 * First run reads scripts/fixtures/repid-aware-arms.json.
 * Arms A and B are prompt fixtures. Arm C is a later rater row, not a sentence.
 * The fixture run prints arm, verdict, and refuse. Missing stays NOT_CHECKED, never 0.
 * A calls JSON path, when present, is the only file read. It does not call a vendor.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const armsPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'repid-aware-arms.json');
const ARMS = ['A', 'B', 'C'];
const PROMPTS = [
  ['A', 'bare'],
  ['B', 'check-this'],
  ['C', 'later-rater'],
];

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
  const fixture = JSON.parse(readFileSync(armsPath, 'utf8'));
  if (!Array.isArray(fixture.arms) || fixture.arms.length !== 3) fail('arm file must have three arms');
  const lines = ['arm\tverdict\trefuse'];
  for (let i = 0; i < PROMPTS.length; i += 1) {
    const row = fixture.arms[i];
    const want = PROMPTS[i];
    if (!row || row.arm !== want[0] || row.prompt !== want[1]) fail(`arm ${want[0]} is not ${want[1]}`);
    if (typeof row.prompt !== 'string' || row.prompt.length === 0) fail(`arm ${want[0]} prompt is missing`);
    if (row.prompt === 0 || row.prompt === '0') fail('missing arm printed 0');
    if (row.prompt.includes('.') || row.prompt.includes(' ')) fail(`arm ${row.arm} is a sentence`);
    lines.push([row.arm, 'NOT_CHECKED', 'NOT_CHECKED'].join('\t'));
  }
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
