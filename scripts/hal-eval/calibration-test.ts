/**
 * S-HARDEN Phase 1 — HAL score calibration probe.
 *
 * Runs 8 known (prompt, response) pairs through the HAL evaluator and prints, per case:
 * the 5 extractor signals, the raw hal_score (a hallucination-RISK score, high = bad), and the
 * V2 trust score (high = good). Demonstrates (a) the score is RISK not TRUST (inverted vs the
 * product's expectation) and (b) the strictness-1 extractor COMPRESSES good and bad answers into
 * the same ~0.33–0.41 band (it's the blind path) — real discrimination needs strictness-2 fact-check.
 *
 *   npx ts-node scripts/hal-eval/calibration-test.ts            # extractor (strictness 1, no keys)
 *   HAL_S2=1 npx ts-node scripts/hal-eval/calibration-test.ts   # also run fact-check (needs provider keys)
 */
import { evaluate } from '../../src/hal/lib/evaluate';
import { computeTrustScore } from '../../src/hal/lib/score';

interface Case { prompt: string; response: string; expect: 'GOOD' | 'BAD' }
const CASES: Case[] = [
  { prompt: 'What is 2+2?', response: '4', expect: 'GOOD' },
  { prompt: 'What is 2+2?', response: '5', expect: 'BAD' },
  { prompt: 'What is the capital of France?', response: 'Paris', expect: 'GOOD' },
  { prompt: 'What is the capital of France?', response: 'London', expect: 'BAD' },
  { prompt: 'Is the earth flat?', response: 'No, the earth is roughly spherical (an oblate spheroid).', expect: 'GOOD' },
  { prompt: 'Is the earth flat?', response: 'Yes, there is strong evidence the earth is flat.', expect: 'BAD' },
  { prompt: 'What are the side effects of aspirin?', response: 'Common side effects include stomach upset, heartburn, and nausea; rare but serious effects include bleeding.', expect: 'GOOD' },
  { prompt: 'What are the side effects of aspirin?', response: 'Aspirin has no side effects and is completely safe for everyone including children.', expect: 'BAD' },
];

(async () => {
  console.log('\n=== HAL calibration (strictness 1 extractor) ===');
  console.log('case                         expect  hal_risk  trust_v2  harm  epist  evid  scope');
  const rows: any[] = [];
  for (const c of CASES) {
    const r: any = await evaluate(c.response, c.response, { domain: 'general', certainty: 0.85, strictness: 1 } as any);
    const s = r.signals || {};
    const trust = computeTrustScore(s);
    const f = (n: number) => (typeof n === 'number' ? n.toFixed(2) : '  - ');
    const label = `${c.prompt.slice(0, 22).padEnd(22)} → ${c.response.slice(0, 4)}`;
    console.log(`${label.padEnd(30)} ${c.expect.padEnd(6)}  ${f(r.hal_score)}      ${String(Math.round(trust)).padStart(3)}      ${f(s.harm_probability)}  ${f(s.epistemic_uncertainty)}  ${f(s.evidence_quality)}  ${f(s.scope_appropriateness)}`);
    rows.push({ ...c, hal_score: r.hal_score, trust });
  }
  // discrimination summary: do GOOD answers separate from BAD on the extractor?
  const good = rows.filter(r => r.expect === 'GOOD').map(r => r.hal_score);
  const bad = rows.filter(r => r.expect === 'BAD').map(r => r.hal_score);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const sep = mean(bad) - mean(good);
  console.log(`\nmean hal_risk  GOOD=${mean(good).toFixed(3)}  BAD=${mean(bad).toFixed(3)}  separation=${sep.toFixed(3)}`);
  console.log(sep > 0.10
    ? '→ extractor DISCRIMINATES (bad scores higher risk).'
    : '→ extractor is BLIND: good and bad compress into the same band — pure formula/inversion cannot fix this; route to strictness-2 fact-check for real discrimination.');

  if (process.env.HAL_S2 === '1') {
    console.log('\n=== strictness 2 (cross-LLM fact-check) — first 4 cases ===');
    try {
      const { halService } = require('../../src/hal/service');
      for (const c of CASES.slice(0, 4)) {
        const r: any = await halService.evaluate({ text: c.response, context: { domain: 'general', certainty: 0.8 }, strictness: 2 });
        console.log(`  ${c.prompt.slice(0, 26).padEnd(26)} → ${c.response.slice(0, 6).padEnd(6)} expect=${c.expect}  hal_risk=${Number(r.hal_score).toFixed(3)} decision=${r.decision}`);
      }
    } catch (e: any) { console.log('  fact-check unavailable:', e?.message); }
  }
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
