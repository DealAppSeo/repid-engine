/**
 * B2 before/after veto-rate harness (CC1 2026-06-11). Runs the SAME cases through this branch's
 * `factCheck` in SCORE mode (before = legacy default) and VERDICT mode (after = new default),
 * with `fetch` mocked to replay the verdicts real free providers give per category (UNCERTAIN for
 * opinions/time-sensitive — validated against the live HAL endpoint; FALSE/TRUE for the factual
 * controls). Reports veto-rate per category. No network, deterministic.
 *
 *   npx ts-node scripts/opinion-veto-harness.ts
 */
import { factCheck, type FactCheckProviderCfg } from '../src/hal/fact-check';

const PROVIDERS: FactCheckProviderCfg[] = [
  { name: 'p1', endpoint: 'http://x/1', apiKey: 'k1', model: 'm1', family: 'fam-a' },
  { name: 'p2', endpoint: 'http://x/2', apiKey: 'k2', model: 'm2', family: 'fam-b' },
  { name: 'p3', endpoint: 'http://x/3', apiKey: 'k3', model: 'm3', family: 'fam-c' },
];

type Verdict = 'TRUE' | 'FALSE' | 'UNCERTAIN';
const CASES: { category: string; text: string; verdict: Verdict; conf: number }[] = [
  // OPINION — providers abstain (UNCERTAIN). Live-validated: cerebras+mistral returned UNCERTAIN.
  { category: 'opinion', text: 'Chocolate ice cream tastes better than vanilla.', verdict: 'UNCERTAIN', conf: 100 },
  { category: 'opinion', text: 'Blue is the most beautiful color.', verdict: 'UNCERTAIN', conf: 100 },
  { category: 'opinion', text: 'Jazz is the greatest genre of music ever made.', verdict: 'UNCERTAIN', conf: 100 },
  { category: 'opinion', text: 'Cats make better pets than dogs.', verdict: 'UNCERTAIN', conf: 90 },
  // TIME-SENSITIVE — not verifiable from training data → UNCERTAIN.
  { category: 'time-sensitive', text: 'It is currently raining in New York City.', verdict: 'UNCERTAIN', conf: 100 },
  { category: 'time-sensitive', text: 'The stock market is up today.', verdict: 'UNCERTAIN', conf: 90 },
  { category: 'time-sensitive', text: 'The newest iPhone model released this week is sold out.', verdict: 'UNCERTAIN', conf: 90 },
  { category: 'time-sensitive', text: 'There are exactly 3 people in the room right now.', verdict: 'UNCERTAIN', conf: 100 },
  // CONTROL: factual-FALSE — must STILL veto in BOTH modes (proves 0.73 / factual detection untouched).
  { category: 'control-false', text: 'The Eiffel Tower is located in Berlin, Germany.', verdict: 'FALSE', conf: 95 },
  { category: 'control-false', text: 'Water boils at 50 degrees Celsius at sea level.', verdict: 'FALSE', conf: 95 },
  // CONTROL: factual-TRUE — clean in both.
  { category: 'control-true', text: 'The chemical symbol for gold is Au.', verdict: 'TRUE', conf: 95 },
];

function mockFetchReturning(v: Verdict, conf: number) {
  (global as any).fetch = async (_url: string, _init: any) =>
    ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: v, confidence: conf, note: 'mock' }) } }] }) }) as any;
}

async function run(mode: 'score' | 'verdict') {
  if (mode === 'score') process.env.HAL_DECISION_MODE = 'score';
  else delete process.env.HAL_DECISION_MODE; // default = verdict
  const rows: { category: string; decision: string }[] = [];
  for (const c of CASES) {
    mockFetchReturning(c.verdict, c.conf);
    const r = await factCheck(c.text, PROVIDERS);
    rows.push({ category: c.category, decision: r.decision });
  }
  return rows;
}

function vetoRateByCategory(rows: { category: string; decision: string }[]) {
  const cats = [...new Set(rows.map((r) => r.category))];
  return cats.map((cat) => {
    const inCat = rows.filter((r) => r.category === cat);
    const vetoed = inCat.filter((r) => r.decision === 'vetoed').length;
    return { cat, n: inCat.length, vetoed, vetoRate: `${vetoed}/${inCat.length}`, decisions: inCat.map((r) => r.decision).join(',') };
  });
}

(async () => {
  const before = await run('score');
  const after = await run('verdict');
  console.log('\n=== B2 VETO-RATE: BEFORE (score mode, legacy default) ===');
  console.table(vetoRateByCategory(before));
  console.log('=== B2 VETO-RATE: AFTER (verdict mode, new default) ===');
  console.table(vetoRateByCategory(after));

  const opinionBefore = before.filter((r) => r.category === 'opinion' || r.category === 'time-sensitive').filter((r) => r.decision === 'vetoed').length;
  const opinionAfter = after.filter((r) => r.category === 'opinion' || r.category === 'time-sensitive').filter((r) => r.decision === 'vetoed').length;
  const falseBefore = before.filter((r) => r.category === 'control-false' && r.decision === 'vetoed').length;
  const falseAfter = after.filter((r) => r.category === 'control-false' && r.decision === 'vetoed').length;
  console.log(`\nopinion+time-sensitive vetoes: BEFORE ${opinionBefore}/8  →  AFTER ${opinionAfter}/8`);
  console.log(`control-FALSE vetoes (must stay 2/2 — 0.73 untouched): BEFORE ${falseBefore}/2  →  AFTER ${falseAfter}/2`);
  console.log(opinionAfter === 0 && falseAfter === 2 ? '\nPASS: opinions/time-sensitive stop vetoing; factual falses still veto.' : '\nFAIL: unexpected.');
})();
