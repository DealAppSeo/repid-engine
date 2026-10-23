/**
 * print-antifarming-table.ts — print the shadow anti-farming eligibility record for every fixture.
 *
 *   npx ts-node scripts/shadow/print-antifarming-table.ts
 *
 * Reads only the fixtures in tests/fixtures/antifarming-cases.ts. No database, no network, no
 * environment, no writes. src/shadow/antifarming-eligibility.ts is shadow-only: nothing live
 * imports it (tests/antifarming-eligibility.test.ts proves that) and this script is not a deploy
 * entrypoint.
 */
import { evaluateEligibilityBatch, renderEligibilityTable } from '../../src/shadow/antifarming-eligibility';
import { CASES } from '../../tests/fixtures/antifarming-cases';

const rows = CASES.map((c) => {
  const records = evaluateEligibilityBatch(c.events);
  const record = records[c.events.findIndex((e) => e.event_id === c.subject)];
  if (!record) throw new Error(`fixture ${c.name}: subject ${c.subject} not in its events`);
  return { name: `${c.kind}: ${c.name}`, record };
});

console.log(renderEligibilityTable(rows));
const threats = rows.filter((r) => r.name.startsWith('threat'));
const credited = threats.filter((r) => r.record.independent_credibility.units > 0).length;
console.log(`\nthreat fixtures: ${threats.length}, credited for independent credibility: ${credited}`);
