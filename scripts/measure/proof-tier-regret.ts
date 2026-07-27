/**
 * proof-tier-regret.ts (CLI) — print the measured-regret report for the proof-tier policy.
 *
 * All scoring lives in `src/services/proof-tier-regret.ts` so the same code the tests pin
 * is the code that prints this table. A reporting script that re-implements its own
 * arithmetic is a second implementation nobody verifies.
 *
 *   npx tsx scripts/measure/proof-tier-regret.ts
 *
 * Offline and read-only: no network, no DB, no env flags.
 */

import {
  PROOF_TIERS,
  selectProofTier,
} from '../../src/services/proof-tier-policy';
import { PROOF_TIER_CORPUS } from '../../src/services/proof-tier-corpus';
import {
  UNDER_PROOF_PRICES,
  crossoverPrice,
  requiredIndexOf,
  runRegretMeasurement,
  type StrategyResult,
} from '../../src/services/proof-tier-regret';

// ── report ────────────────────────────────────────────────────────────────────
function main(): void {
  const { results, oracleCostUnits, n, floorFirings, ceilingFirings } = runRegretMeasurement();

  console.log('\n=== PROOF-TIER POLICY — MEASURED REGRET (Patent #2 enabling disclosure) ===');
  console.log(`corpus: ${n} labelled scenarios · oracle cost (perfect play): ${oracleCostUnits} units`);
  console.log(`under-proof prices swept: ${UNDER_PROOF_PRICES.join(', ')} units per violation\n`);

  const pad = (s: string | number, w: number) => String(s).padEnd(w);
  const padL = (s: string | number, w: number) => String(s).padStart(w);
  console.log(
    pad('strategy', 24) +
      padL('exact', 6) +
      padL('under', 6) +
      padL('over', 5) +
      padL('overCost', 9) +
      padL('cost', 6) +
      UNDER_PROOF_PRICES.map((p) => padL(`R@${p}`, 8)).join(''),
  );
  console.log('-'.repeat(24 + 6 + 6 + 5 + 9 + 6 + 8 * UNDER_PROOF_PRICES.length));
  for (const r of results) {
    console.log(
      pad(r.name, 24) +
        padL(r.exact, 6) +
        padL(r.underProof, 6) +
        padL(r.overProof, 5) +
        padL(r.overProofCostUnits, 9) +
        padL(r.totalCostUnits, 6) +
        UNDER_PROOF_PRICES.map((p) => padL(r.regretAtPrice[p] as number, 8)).join(''),
    );
  }

  console.log('\n-- under-proof detail (the safety-relevant column) --');
  for (const r of results) {
    if (r.underProof === 0) console.log(`  ${r.name}: none`);
    else console.log(`  ${r.name}: ${r.underProof} → ${r.underProofIds.join(', ')}`);
  }

  console.log('\n-- per-scenario decisions (policy vs required) --');
  for (const s of PROOF_TIER_CORPUS) {
    const d = selectProofTier(s.axes);
    const req = requiredIndexOf(s);
    const mark = d.tierIndex === req ? '=' : d.tierIndex > req ? '+' : '!';
    console.log(
      `  ${mark} ${s.id.padEnd(28)} req=${(s.requiredTier as string).padEnd(19)} got=${d.tier.padEnd(19)} ` +
        `learned=${PROOF_TIERS[d.learnedTierIndex]}${d.floorApplied ? ' [floor]' : ''}${d.ceilingApplied ? ' [ceiling]' : ''}` +
        `${d.zkRequired ? ' [zk]' : ''}`,
    );
  }

  const policy = results.find((r) => r.name === 'policy') as StrategyResult;
  console.log('\n-- crossover: the price of an under-proof at which `policy` ties each rival --');
  for (const r of results) {
    if (r.name === 'policy') continue;
    const p = crossoverPrice(policy, r);
    if (p === null) {
      console.log(`  vs ${r.name.padEnd(24)} parallel (same under-proof count) — one dominates at every price`);
    } else {
      const cheaperSide = policy.underProof < r.underProof ? 'above' : 'below';
      console.log(
        `  vs ${r.name.padEnd(24)} ties at ${p.toFixed(1)} units — policy wins ${cheaperSide} that price`,
      );
    }
  }

  console.log(
    `\n-- gate activity on REAL scenarios: floor fired ${floorFirings}/${n}, ceiling fired ${ceilingFirings}/${n} --`,
  );

  const zk = PROOF_TIER_CORPUS.filter((s) => selectProofTier(s.axes).zkRequired).length;
  console.log(
    `\nzkRequired fired on ${zk}/${n} scenarios. NOT SCORED: the corpus carries no independent ` +
      `zk label, so scoring it against the policy's own threshold would be the self-referential\n` +
      `oracle this measurement is built to avoid. Reported descriptively only.`,
  );
  console.log('');
}

if (require.main === module) main();
