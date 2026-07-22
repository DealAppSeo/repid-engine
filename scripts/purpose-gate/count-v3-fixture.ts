/**
 * count-v3-fixture.ts — before/after count for classifier v3 (CC-2).
 *
 * Loads the PROVISIONAL fixture and runs the LIVE classifyTaskPurpose over every row,
 * then reports how many rows the v3 tail set NEWLY classifies non-deliverable
 * (v1 classified deliverable → v3 classifies non-deliverable). The v1 baseline is the
 * fixture's `v1_deliverable` field (documented v1 exact-match behavior); the v3 side is
 * computed live so the number can't drift from the code.
 *
 * Run:  npx ts-node scripts/purpose-gate/count-v3-fixture.ts
 * NOTE: GA-1's labeled corpus is the REAL oracle — this fixture is provisional.
 */
import * as fs from 'fs';
import * as path from 'path';
import { classifyTaskPurpose } from '../../src/scoring/task-purpose';

interface Row {
  domain: string;
  prompt: string;
  v1_deliverable: boolean;
  v3_deliverable: boolean;
  note?: string;
}

const fixturePath = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'purpose-gate-v3.provisional.jsonl');
const rows: Row[] = fs
  .readFileSync(fixturePath, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.includes('"_meta"'))
  .map((l) => JSON.parse(l) as Row);

let v1NonDeliverable = 0;
let v3NonDeliverable = 0;
let newlyNonDeliverable = 0;
const newly: string[] = [];

for (const r of rows) {
  const verdict = classifyTaskPurpose(r.domain, r.prompt);
  const v3IsDeliverable = verdict.halVetoApplies; // deliverable ⇔ HAL veto applies
  if (!r.v1_deliverable) v1NonDeliverable++;
  if (!v3IsDeliverable) v3NonDeliverable++;
  if (r.v1_deliverable && !v3IsDeliverable) {
    newlyNonDeliverable++;
    newly.push(`${r.domain} → ${verdict.purpose}`);
  }
  // Guard: the fixture's asserted v3 expectation must match the live classifier.
  if (v3IsDeliverable !== r.v3_deliverable) {
    console.error(`MISMATCH: ${r.domain} expected v3_deliverable=${r.v3_deliverable}, got ${v3IsDeliverable}`);
    process.exitCode = 1;
  }
}

console.log(`fixture rows:            ${rows.length}`);
console.log(`v1 non-deliverable:      ${v1NonDeliverable}`);
console.log(`v3 non-deliverable:      ${v3NonDeliverable}`);
console.log(`NEWLY non-deliverable:   ${newlyNonDeliverable}`);
console.log(`  ${newly.join('\n  ')}`);
