/**
 * routing-session-curve.ts — OPTIMAL-THRESHOLD routing test harness.
 *
 * SPEC: E:\dev\living-docs\03_specs\ROUTING_AND_FIRST_TIME_UX_POLICY_v1.md  (§ "Testing at the OPTIMAL THRESHOLD")
 * BRANCH: feat/cc-2026-07-05-routing-session-curve
 *
 * WHAT THIS IS
 * ------------
 * A DECISION-SUPPORT harness (NOT production code) that tests routing the way it actually
 * runs — as a SESSION CURVE, not as static provider pairs. It simulates a user session where
 * the first N queries are routed to a frontier-value model (optimize speed+accuracy), then the
 * session DOWNSHIFTS to the free/SLM cost-cascade. It sweeps N = 3..10 and prints the
 * accuracy / latency / cost frontier vs N so `ROUTER_FIRST_TIME_FRONTIER_N` (the tunable env
 * knob in the spec) can be chosen ON EVIDENCE rather than guessed.
 *
 * REAL vs MODELED (be honest — no fake precision):
 *   REAL (measured / on-disk):
 *     - The labeled accuracy corpus is the REAL HAL ground-truth corpus at
 *       scripts/hal-eval/corpus.ts (20 items, TRUE/FALSE/AMBIG). Imported, not copied.
 *     - The complexity gate `isLowComplexity()` is the REAL router function imported from
 *       src/providers/router.ts — the same code that decides SLM-eligibility in production.
 *     - The tier ladder ORDER (SLM -> tier0a -> tier1) is the real ladder in router.ts:32-49.
 *   MODELED (simulated — clearly labeled below):
 *     - PROVIDER_COST/latency numbers are a small hardcoded table sourced from llm_call_log (7d).
 *       They are point estimates, NOT live reads — refresh from llm_call_log periodically.
 *     - Per-model ACCURACY is a MODELED accuracy profile per provider tier. We do NOT have a
 *       live labeled accuracy-per-provider table reachable offline, so accuracy is derived by
 *       (a) the corpus item's own difficulty and (b) a modeled per-tier skill coefficient.
 *       This is a stand-in and is MARKED modeled-not-real everywhere it is used.
 *     - The session query stream is a MODELED synthetic session (cycles the real corpus).
 *
 * CONSTRAINTS HONORED: no DB writes, no network calls, no env changes. Importing router.ts is
 * safe (it constructs the Supabase client lazily and this harness never calls it).
 *
 * RUN:  npx ts-node scripts/sim/routing-session-curve.ts
 *       npx ts-node scripts/sim/routing-session-curve.ts --json     (machine-readable JSON only)
 *       npx ts-node scripts/sim/routing-session-curve.ts --session 40   (session length, default 30)
 *
 * NOTE on --json: the committed dotenvx setup prints a one-line "injected env" banner to stdout
 * at import time (before this script runs). We therefore wrap the JSON payload in sentinel lines
 * ===JSON-START=== / ===JSON-END=== so a consumer can slice it deterministically:
 *   ... --json | sed -n '/===JSON-START===/,/===JSON-END===/{/===JSON-/d;p;}'
 */

// REAL: the labeled HAL ground-truth corpus (20 items). Imported, not copied.
import { CORPUS, type CorpusItem } from '../hal-eval/corpus';
// REAL: the production complexity gate. Imported, not copied.
import { isLowComplexity } from '../../src/providers/router';

// ---------------------------------------------------------------------------
// PROVIDER_COST — MODELED-BUT-SOURCED cost/latency table.
// Sourced from llm_call_log (7d per-provider medians) per the sprint spec; these are POINT
// ESTIMATES, not live reads. REFRESH from llm_call_log when routing decisions depend on them.
//   groq     ~$0.0000021 / 123ms
//   cerebras ~$0.000057  / 2220ms
//   mistral  ~$0         / 628ms
//   gemini   ~$0         / 1235ms
//   deepseek ~$0.00007   / 333ms
// tier1 (frontier) figures are MODELED placeholders (no llm_call_log rows for the frontier tier
// on this deployment — the 12 agents call providers direct); marked <modeled> so they are never
// mistaken for measured. Refresh once frontier traffic flows through the engine (ENGINE_LLM_PROXY).
// ---------------------------------------------------------------------------
interface ProviderModel {
  provider: string;
  tier: 'slm' | '0a' | '1';
  costUsd: number;   // USD per call (point estimate)
  latencyMs: number; // ms per call (point estimate)
  source: 'llm_call_log-7d' | 'modeled';
  /**
   * MODELED skill coefficient in [0,1]: capability proxy used to derive accuracy vs corpus
   * difficulty. Frontier tier is modeled as most capable; SLM least. This is the explicit
   * modeled-not-real accuracy knob — it is NOT a measured per-provider accuracy.
   */
  skill: number;
}

const PROVIDER_COST: Record<string, ProviderModel> = {
  // SLM tier (cheap small models) — cost/latency modeled from the cheapest tier0a proxy (groq-like)
  'llama-3-2-1b': { provider: 'llama-3-2-1b', tier: 'slm', costUsd: 0.0000010, latencyMs: 110, source: 'modeled', skill: 0.55 },
  // tier0a free/cheap cascade — REAL cost/latency from llm_call_log 7d
  groq:     { provider: 'groq',     tier: '0a', costUsd: 0.0000021, latencyMs: 123,  source: 'llm_call_log-7d', skill: 0.72 },
  deepseek: { provider: 'deepseek', tier: '0a', costUsd: 0.00007,   latencyMs: 333,  source: 'llm_call_log-7d', skill: 0.78 },
  mistral:  { provider: 'mistral',  tier: '0a', costUsd: 0.0,       latencyMs: 628,  source: 'llm_call_log-7d', skill: 0.75 },
  gemini:   { provider: 'gemini',   tier: '0a', costUsd: 0.0,       latencyMs: 1235, source: 'llm_call_log-7d', skill: 0.80 },
  cerebras: { provider: 'cerebras', tier: '0a', costUsd: 0.000057,  latencyMs: 2220, source: 'llm_call_log-7d', skill: 0.79 },
  // tier1 frontier (escalation) — MODELED placeholders (no frontier rows in llm_call_log here)
  anthropic:{ provider: 'anthropic',tier: '1',  costUsd: 0.0090,    latencyMs: 900,  source: 'modeled', skill: 0.94 },
  openai:   { provider: 'openai',   tier: '1',  costUsd: 0.0075,    latencyMs: 850,  source: 'modeled', skill: 0.93 },
};

// The FRONTIER-VALUE pick for phase A (first N queries). Spec: "optimize SPEED + ACCURACY".
// Modeled choice = the fastest high-skill frontier model (anthropic here). MODELED.
const FRONTIER_PICK: ProviderModel = PROVIDER_COST['anthropic']!;

// REAL tier ladder order, mirrored from src/providers/router.ts:32-49 (SLM -> tier0a -> tier1).
// We keep the ORDER authoritative-by-reference; the cost/latency come from PROVIDER_COST above.
// NB: 'cohere' is in the real tier0a ladder but has no llm_call_log figures here, so it is
// filtered out of the modeled cascade rather than fabricated.
const SLM_LADDER = ['llama-3-2-1b'];
const TIER0A_LADDER = ['groq', 'cerebras', 'gemini', 'cohere', 'deepseek'];

type Phase = 'frontier' | 'steady';

interface CallResult {
  provider: string;
  tier: string;
  costUsd: number;
  latencyMs: number;
  correct: boolean; // vs the corpus item's ground-truth label
}

/**
 * MODELED accuracy: does `model` correctly resolve corpus `item`?
 * Deterministic (seeded by item.n + provider) so runs are reproducible — this is a simulation,
 * not a live LLM call. Harder items (adversarial/synthetic/AMBIG) need more skill to get right.
 * MARKED modeled-not-real: there is no live per-provider accuracy table reachable offline.
 */
function modeledCorrect(model: ProviderModel, item: CorpusItem): boolean {
  // difficulty in [0,1]: adversarial hardest, plain facts easiest, ambiguous mid-high.
  let difficulty = 0.15;
  if (item.category === 'adversarial') difficulty = 0.85;
  else if (item.truth === 'AMBIG') difficulty = 0.6;
  else if (item.synthetic) difficulty = 0.5;
  else if (item.truth === 'FALSE') difficulty = 0.35;
  // Probability correct rises with skill, falls with difficulty; clamped to [0.02, 0.99].
  const pCorrect = Math.max(0.02, Math.min(0.99, model.skill - difficulty * (1 - model.skill)));
  // Deterministic pseudo-random draw seeded by (item, provider) — reproducible across runs.
  const seed = (item.n * 2654435761 + hashStr(model.provider)) >>> 0;
  const draw = (seed % 10000) / 10000;
  return draw < pCorrect;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * Pick the steady-state provider for an item using the REAL complexity gate.
 * Low-complexity -> SLM (cheapest); otherwise first tier0a in the real ladder order.
 * Mirrors router.ts static path (SLM for low complexity, else tier0a cost-order).
 */
function steadyPick(item: CorpusItem): ProviderModel {
  if (isLowComplexity(item.text)) {
    for (const p of SLM_LADDER) { const m = PROVIDER_COST[p]; if (m) return m; }
  }
  for (const p of TIER0A_LADDER) { const m = PROVIDER_COST[p]; if (m) return m; }
  return PROVIDER_COST['groq']!;
}

/** Simulate ONE call: frontier phase uses FRONTIER_PICK; steady phase uses the cascade gate. */
function simulateCall(item: CorpusItem, phase: Phase): CallResult {
  const model = phase === 'frontier' ? FRONTIER_PICK : steadyPick(item);
  return {
    provider: model.provider,
    tier: model.tier,
    costUsd: model.costUsd,
    latencyMs: model.latencyMs,
    correct: modeledCorrect(model, item),
  };
}

interface PhaseMetrics {
  N: number;
  phase: Phase;
  queries: number;
  accuracy: number;        // fraction correct (deliverable accuracy vs ground truth)
  avg_latency_ms: number;
  total_cost_usd: number;
}

/** Run one session of `sessionLen` queries with a frontier->steady switch at N. */
function runSession(N: number, sessionLen: number): PhaseMetrics[] {
  const byPhase: Record<Phase, CallResult[]> = { frontier: [], steady: [] };
  for (let i = 0; i < sessionLen; i++) {
    const item = CORPUS[i % CORPUS.length]!; // MODELED synthetic session: cycle the real corpus
    const phase: Phase = i < N ? 'frontier' : 'steady';
    byPhase[phase].push(simulateCall(item, phase));
  }
  return (['frontier', 'steady'] as Phase[]).map((phase) => {
    const calls = byPhase[phase];
    const queries = calls.length;
    const correct = calls.filter((c) => c.correct).length;
    const totLat = calls.reduce((s, c) => s + c.latencyMs, 0);
    const totCost = calls.reduce((s, c) => s + c.costUsd, 0);
    return {
      N,
      phase,
      queries,
      accuracy: queries ? +(correct / queries).toFixed(4) : 0,
      avg_latency_ms: queries ? +(totLat / queries).toFixed(1) : 0,
      total_cost_usd: +totCost.toFixed(8),
    };
  });
}

interface SessionRollup {
  N: number;
  session_accuracy: number;   // whole-session accuracy
  session_avg_latency_ms: number;
  session_total_cost_usd: number;
  phases: PhaseMetrics[];
}

function runSweep(sessionLen: number): SessionRollup[] {
  const rollups: SessionRollup[] = [];
  for (let N = 3; N <= 10; N++) {
    const phases = runSession(N, sessionLen);
    const totQ = phases.reduce((s, p) => s + p.queries, 0) || 1;
    const totCorrect = phases.reduce((s, p) => s + p.accuracy * p.queries, 0);
    const totLat = phases.reduce((s, p) => s + p.avg_latency_ms * p.queries, 0);
    const totCost = phases.reduce((s, p) => s + p.total_cost_usd, 0);
    rollups.push({
      N,
      session_accuracy: +(totCorrect / totQ).toFixed(4),
      session_avg_latency_ms: +(totLat / totQ).toFixed(1),
      session_total_cost_usd: +totCost.toFixed(8),
      phases,
    });
  }
  return rollups;
}

/**
 * Recommend N on evidence. Heuristic: maximize a value score that rewards accuracy + speed and
 * penalizes cost, then pick the SMALLEST N within a small tolerance of the best score (cost-lean
 * tie-break, matching the spec's "raise for performance, lower for cost"). This is a MODELED
 * decision rule over MODELED accuracy — the harness is decision-support, not an oracle.
 */
function recommendN(rollups: SessionRollup[]): { N: number; rationale: string } {
  const maxCost = Math.max(...rollups.map((r) => r.session_total_cost_usd), 1e-9);
  const maxLat = Math.max(...rollups.map((r) => r.session_avg_latency_ms), 1);
  const score = (r: SessionRollup) =>
    r.session_accuracy * 1.0
    + (1 - r.session_avg_latency_ms / maxLat) * 0.3
    - (r.session_total_cost_usd / maxCost) * 0.5;
  const scored = rollups.map((r) => ({ N: r.N, s: score(r) }));
  const best = Math.max(...scored.map((x) => x.s));
  const within = scored.filter((x) => x.s >= best - 0.02).sort((a, b) => a.N - b.N);
  const pick = within[0]!;
  return {
    N: pick.N,
    rationale: 'smallest N within 0.02 of the best value-score (accuracy + speed - cost, all MODELED); cost-lean tie-break per spec',
  };
}

// --------------------------------- output ----------------------------------
function main(): void {
  const args = process.argv.slice(2);
  const jsonOnly = args.includes('--json');
  const sIdx = args.indexOf('--session');
  const sessionLen = sIdx >= 0 && args[sIdx + 1] ? Math.max(11, parseInt(args[sIdx + 1]!, 10)) : 30;

  const rollups = runSweep(sessionLen);
  const rec = recommendN(rollups);

  // Flat rows: {N, phase, accuracy, avg_latency_ms, total_cost_usd}
  const rows = rollups.flatMap((r) => r.phases.map((p) => ({
    N: p.N,
    phase: p.phase,
    queries: p.queries,
    accuracy: p.accuracy,
    avg_latency_ms: p.avg_latency_ms,
    total_cost_usd: p.total_cost_usd,
  })));

  if (jsonOnly) {
    console.log('===JSON-START===');
    console.log(JSON.stringify({
      spec: 'ROUTING_AND_FIRST_TIME_UX_POLICY_v1 § optimal-threshold',
      session_length: sessionLen,
      corpus: { source: 'scripts/hal-eval/corpus.ts', items: CORPUS.length, real: true },
      accuracy_basis: 'MODELED (per-tier skill vs corpus difficulty) — NOT measured per-provider',
      cost_latency_basis: 'MODELED-BUT-SOURCED (llm_call_log 7d point estimates; tier1 modeled)',
      rows,
      sweep: rollups,
      recommended_N: rec,
    }, null, 2));
    console.log('===JSON-END===');
    return;
  }

  console.log('='.repeat(78));
  console.log('ROUTING SESSION-CURVE HARNESS  (optimal-threshold sweep, N = 3..10)');
  console.log('spec: ROUTING_AND_FIRST_TIME_UX_POLICY_v1.md  |  session length:', sessionLen, 'queries');
  console.log('-'.repeat(78));
  console.log('REAL:    accuracy corpus = scripts/hal-eval/corpus.ts (' + CORPUS.length + ' labeled items)');
  console.log('REAL:    complexity gate = isLowComplexity() from src/providers/router.ts');
  console.log('MODELED: per-provider accuracy (skill x difficulty) — NOT a measured per-provider table');
  console.log('MODELED: cost/latency = llm_call_log 7d point estimates (tier1 modeled placeholders)');
  console.log('='.repeat(78));

  // per-phase table
  console.log('\nPER-PHASE  {N, phase, queries, accuracy, avg_latency_ms, total_cost_usd}');
  console.log('  N  phase     q   acc     lat(ms)   cost($)');
  for (const p of rows) {
    console.log(
      `  ${String(p.N).padStart(2)}  ${p.phase.padEnd(8)}  ${String(p.queries).padStart(2)}  ` +
      `${p.accuracy.toFixed(3)}   ${p.avg_latency_ms.toFixed(1).padStart(7)}   ${p.total_cost_usd.toFixed(8)}`,
    );
  }

  // frontier vs N (accuracy/latency/cost frontier)
  console.log('\nSESSION FRONTIER vs N  (whole-session; this is the accuracy/latency/cost frontier)');
  console.log('  N   session_acc   avg_lat(ms)   total_cost($)');
  for (const r of rollups) {
    console.log(
      `  ${String(r.N).padStart(2)}   ${r.session_accuracy.toFixed(4).padStart(9)}   ` +
      `${r.session_avg_latency_ms.toFixed(1).padStart(9)}   ${r.session_total_cost_usd.toFixed(8)}`,
    );
  }

  console.log('\n' + '-'.repeat(78));
  console.log(`RECOMMENDED  ROUTER_FIRST_TIME_FRONTIER_N = ${rec.N}   (${rec.rationale})`);
  console.log('NOTE: recommendation is over MODELED accuracy — re-run against a live labeled');
  console.log('      per-provider accuracy source before trusting the absolute N. This harness');
  console.log('      exists to show the SHAPE of the frontier, not to certify a production value.');
  console.log('-'.repeat(78));
}

main();
