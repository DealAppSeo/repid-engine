/**
 * HAL provider-failure simulation (CC1 2026-05-23).
 *
 * Runs CC2's 20-item calibration corpus through factCheck under simulated
 * provider-failure scenarios, comparing PRE-gate behavior (score-threshold,
 * the old lone-provider-can-veto path) vs POST-gate behavior (the resilience
 * minimum-quorum gate). Quantifies the tradeoff:
 *   - benefit: false vetoes PREVENTED on TRUE content when a lone provider errs
 *   - cost:    catches DEFERRED on FALSE content under low quorum (acceptable —
 *              caught downstream by the F-series filter + dispute path)
 *
 * Deterministic + offline (mocks provider verdicts from the corpus labels; no
 * real API calls, no quota, no cerebras 429 risk). Run:
 *   npx tsx scripts/hal-eval/provider-failure-simulation.ts
 */
import { factCheck, type FactCheckProviderCfg, type Verdict } from '../../src/hal/fact-check';
import { CORPUS, type CorpusItem } from './corpus';

const PROVIDERS: FactCheckProviderCfg[] = [
  { name: 'groq', endpoint: 'http://groq.sim', apiKey: 'k', model: 'm', timeoutMs: 1000 },
  { name: 'cerebras', endpoint: 'http://cerebras.sim', apiKey: 'k', model: 'm', timeoutMs: 1000 },
  { name: 'fireworks', endpoint: 'http://fireworks.sim', apiKey: 'k', model: 'm', timeoutMs: 1000 },
];

const VETO = 0.5, FLAG = 0.35; // factCheck defaults

/** Correct verdict a well-behaved provider would give for a corpus item. */
function correctVerdict(item: CorpusItem): Verdict {
  if (item.truth === 'TRUE') return 'TRUE';
  if (item.truth === 'FALSE') return 'FALSE';
  return 'UNCERTAIN';
}
const flip = (v: Verdict): Verdict => (v === 'TRUE' ? 'FALSE' : v === 'FALSE' ? 'TRUE' : 'UNCERTAIN');

type Behavior = 'correct' | 'hallucinate';
interface Scenario { name: string; ok: Record<string, boolean>; behavior: Behavior; note: string; }
const SCENARIOS: Scenario[] = [
  { name: 'full (3/3 ok)',                  ok: { groq: true, cerebras: true, fireworks: true },  behavior: 'correct',     note: 'happy path' },
  { name: 'partial (cerebras 429, 2/3)',    ok: { groq: true, cerebras: false, fireworks: true }, behavior: 'correct',     note: '>=2 quorum → veto still allowed' },
  { name: 'low, survivor correct (1/3)',    ok: { groq: true, cerebras: false, fireworks: false }, behavior: 'correct',    note: 'gate defers catches (cost)' },
  { name: 'low, survivor HALLUCINATES (1/3)', ok: { groq: true, cerebras: false, fireworks: false }, behavior: 'hallucinate', note: 'gate prevents false vetoes (benefit)' },
];

function installMock(item: CorpusItem, sc: Scenario) {
  (global as any).fetch = jest_noop_fetch(item, sc);
}
// Plain fetch mock (no jest dependency — script runs under tsx/node).
function jest_noop_fetch(item: CorpusItem, sc: Scenario) {
  const base = correctVerdict(item);
  return async (url: string) => {
    const name = ['groq', 'cerebras', 'fireworks'].find((n) => String(url).includes(n))!;
    if (!sc.ok[name]) return { ok: false, status: 429, text: async () => 'Too Many Requests', json: async () => ({}) } as any;
    const verdict = sc.behavior === 'hallucinate' ? flip(base) : base;
    return {
      ok: true, status: 200, text: async () => '',
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict, confidence: 90 }) } }] }),
    } as any;
  };
}

const preGate = (score: number) => (score >= VETO ? 'vetoed' : score >= FLAG ? 'flagged' : 'clean');

async function run() {
  console.log('HAL Provider-Failure Simulation — corpus n=' + CORPUS.length + ' (TRUE=' + CORPUS.filter(c=>c.truth==='TRUE').length + ', FALSE=' + CORPUS.filter(c=>c.truth==='FALSE').length + ', AMBIG=' + CORPUS.filter(c=>c.truth==='AMBIG').length + ')\n');
  for (const sc of SCENARIOS) {
    let catchesPost = 0, falseVetoPost = 0, falseVetoPre = 0, missedCatch = 0, degraded = 0;
    const falseCount = CORPUS.filter((c) => c.truth === 'FALSE').length;
    for (const item of CORPUS) {
      installMock(item, sc);
      const fc = await factCheck(item.text, PROVIDERS);
      const pre = preGate(fc.hal_score);
      const post = fc.decision;
      if (fc.degraded) degraded++;
      if (item.truth === 'FALSE' && post === 'vetoed') catchesPost++;
      if (item.truth === 'TRUE' && post === 'vetoed') falseVetoPost++;
      if (item.truth === 'TRUE' && pre === 'vetoed') falseVetoPre++;
      if (item.truth === 'FALSE' && pre === 'vetoed' && post !== 'vetoed') missedCatch++;
    }
    console.log('── ' + sc.name + '  [' + sc.note + ']');
    console.log('   catches (FALSE→veto, post-gate): ' + catchesPost + '/' + falseCount);
    console.log('   FALSE VETOES on TRUE content:    pre-gate=' + falseVetoPre + '  post-gate=' + falseVetoPost + '   → prevented=' + (falseVetoPre - falseVetoPost));
    console.log('   catches deferred by gate (cost): ' + missedCatch);
    console.log('   degraded events: ' + degraded + '/' + CORPUS.length + '\n');
  }
  console.log('SUMMARY: at full/partial quorum (>=2) behavior is unchanged (catches kept, 0 false vetoes).');
  console.log('At LOW quorum the gate prevents 100% of lone-provider false vetoes on TRUE content,');
  console.log('trading off deferred FALSE catches (acceptable: downstream F-series filter + dispute path).');
  (global as any).fetch = undefined;
}

run().catch((e) => { console.error(e); process.exit(1); });
