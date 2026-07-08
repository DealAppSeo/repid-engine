/**
 * CANARY HAL F1 HARNESS — re-runnable known-answer baseline.
 *
 * WHAT THIS MEASURES: the accuracy of the REAL cross-LLM HAL fact-check quorum
 * (src/hal/fact-check.ts `factCheck`) against a 50-claim known-answer canary
 * corpus (eval/canary/canary-corpus-v1.jsonl, == Supabase artifact 173133
 * "HAL_Decisioning_Canary_Corpus_v1", GAMMA SQUAD). It invokes the ACTUAL
 * multi-provider vote LOCALLY with live keys — NOT the deterministic-extractor
 * short-circuit, and NOT the production Railway endpoint (prod HAL has been
 * observed running deterministic-only with 0 real LLM calls). We want the REAL
 * quorum's accuracy.
 *
 * SCORING CONVENTION (per the sprint brief):
 *   verdict -> prediction:  PASS (clean) => predicted-TRUE/trustworthy
 *                           FLAG | VETO   => predicted-FALSE/untrustworthy
 *   POSITIVE class = "correctly catch a FALSE claim".
 *     TP = claim is FALSE and HAL flagged/vetoed it (caught)
 *     FP = claim is TRUE  but HAL flagged/vetoed it (false alarm)
 *     TN = claim is TRUE  and HAL passed it (clean)
 *     FN = claim is FALSE but HAL passed it (missed)
 *   ABSTAIN (HAL could not reach a verdict / 0 usable providers) is counted
 *   separately and EXCLUDED from precision/recall/F1 (reported explicitly).
 *
 * PACING (anti-self-DOS): claims run SEQUENTIALLY with a short inter-claim delay.
 * The per-provider path already does a jittered 429 retry (postWith429Retry);
 * we ALSO retry the whole claim on a fully-degraded (0-provider) result with
 * exponential backoff, because the thin free quorum (groq+cerebras) rate-limits
 * under burst.
 *
 * DISCIPLINE: real providers only. If a provider is down it is recorded as ERROR,
 * never fabricated. No tuning to pass. If NO real provider vote can be obtained
 * for the whole run, the harness EXITS NON-ZERO and says so loudly — a
 * deterministic run is not the measurement we want.
 *
 * Run (from repo root, keys auto-loaded from ../.env.master):
 *   npx ts-node scripts/eval/canary-f1.ts
 * Optional env:
 *   CANARY_LIMIT=5            smoke subset
 *   CANARY_DELAY_MS=1200      inter-claim delay (default 1200)
 *   CANARY_CONCURRENCY=1      claims in flight (default 1; max 2 per brief)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// --- SECURITY: load provider keys from repo-root ../.env.master into process.env.
// NEVER print a key value. dotenv only populates process.env; we log key NAMES /
// presence booleans only, never values. .env.master lives one level above the
// repo (C:\Users\Cash4\repos\.env.master); fall back to a local .env if absent.
const envMaster = path.resolve(__dirname, '../../../.env.master');
if (fs.existsSync(envMaster)) {
  dotenv.config({ path: envMaster });
} else {
  dotenv.config(); // repo-local .env fallback
}

import {
  factCheck,
  familyOf,
  type FactCheckProviderCfg,
  type ProviderVerdict,
  type HalDecision,
} from '../../src/hal/fact-check';

// ---------------------------------------------------------------------------
// QUORUM under test. Cheapest-first independent families, key-gated. groq(llama)
// + cerebras(glm) are the thin always-on free pair; deepseek/gemini/mistral/
// openrouter are added when their KEY is present to keep a >=2-family quorum
// alive when the free pair throttles. Only key-present providers are included.
// ---------------------------------------------------------------------------
function P(name: string, endpoint: string, envKey: string, model: string, tier: 'free' | 'cheap' | 'escalation'): FactCheckProviderCfg | null {
  const apiKey = process.env[envKey]?.trim();
  if (!apiKey) return null;
  return { name, endpoint, apiKey, model, family: familyOf(model), tier };
}

function buildQuorum(): FactCheckProviderCfg[] {
  const cands = [
    P('groq', 'https://api.groq.com/openai/v1/chat/completions', 'GROQ_API_KEY', 'llama-3.1-8b-instant', 'free'),
    P('cerebras', 'https://api.cerebras.ai/v1/chat/completions', 'CEREBRAS_API_KEY', 'zai-glm-4.7', 'free'),
    P('deepseek', 'https://api.deepseek.com/chat/completions', 'DEEPSEEK_API_KEY', 'deepseek-chat', 'cheap'),
    P('gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'GEMINI_API_KEY', 'gemini-2.0-flash', 'escalation'),
    P('mistral', 'https://api.mistral.ai/v1/chat/completions', 'MISTRAL_API_KEY', 'mistral-small-latest', 'escalation'),
    P('openrouter', 'https://openrouter.ai/api/v1/chat/completions', 'OPENROUTER_API_KEY', 'qwen/qwen3-next-80b-a3b-instruct:free', 'escalation'),
  ];
  return cands.filter((c): c is FactCheckProviderCfg => c !== null);
}

// ---------------------------------------------------------------------------
interface CorpusRow {
  claim: string;
  label: 'TRUE' | 'FALSE';
  domain: string;
  difficulty: string;
  source_title?: string;
  source_url?: string;
}
function loadCorpus(): CorpusRow[] {
  const file = path.resolve(__dirname, '../../eval/canary/canary-corpus-v1.jsonl');
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CorpusRow);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Map the HAL decision to a binary prediction per the brief.
// clean => predicted TRUE (trustworthy); flagged|vetoed => predicted FALSE (caught);
// abstain / 0-provider => no verdict (excluded from F1).
type Pred = 'TRUE' | 'FALSE' | 'ABSTAIN';
function decisionToPred(decision: HalDecision, providersUsed: number): Pred {
  if (providersUsed === 0) return 'ABSTAIN';
  if (decision === 'clean') return 'TRUE';
  if (decision === 'flagged' || decision === 'vetoed') return 'FALSE';
  return 'ABSTAIN'; // 'abstain'
}

interface Cell {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  abstain: number;
}
const empty = (): Cell => ({ tp: 0, fp: 0, tn: 0, fn: 0, abstain: 0 });
function metrics(c: Cell) {
  const p = c.tp + c.fp === 0 ? 0 : c.tp / (c.tp + c.fp);
  const r = c.tp + c.fn === 0 ? 0 : c.tp / (c.tp + c.fn);
  const f = p + r === 0 ? 0 : (2 * p * r) / (p + r);
  const decided = c.tp + c.fp + c.tn + c.fn;
  const acc = decided === 0 ? 0 : (c.tp + c.tn) / decided;
  return {
    precision: +p.toFixed(4),
    recall: +r.toFixed(4),
    f1: +f.toFixed(4),
    accuracy: +acc.toFixed(4),
    decided,
    abstain: c.abstain,
  };
}

interface ClaimResult {
  idx: number;
  claim: string;
  label: 'TRUE' | 'FALSE';
  domain: string;
  difficulty: string;
  hal_decision: HalDecision;
  prediction: Pred;
  outcome: 'TP' | 'FP' | 'TN' | 'FN' | 'ABSTAIN';
  providers_used: number;
  families_used?: number;
  families?: string[];
  decision_reason?: string;
  attempts: number;
  verdicts: Array<{ provider: string; verdict: string; confidence: number; error?: string; latency_ms: number }>;
}

async function scoreClaim(row: CorpusRow, idx: number, providers: FactCheckProviderCfg[]): Promise<ClaimResult> {
  const maxAttempts = 3;
  let attempt = 0;
  let fc: Awaited<ReturnType<typeof factCheck>> | null = null;
  // Retry the WHOLE claim only when the quorum fully degraded (0 usable providers)
  // — exponential backoff so a transient all-429 burst can recover.
  while (attempt < maxAttempts) {
    attempt++;
    fc = await factCheck(row.claim, providers, { vetoThreshold: 0.5, flagThreshold: 0.35 });
    if (fc.providers_used > 0) break;
    if (attempt < maxAttempts) {
      const backoff = 1500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500);
      console.warn(`  #${idx} 0/${providers.length} providers responded — backoff ${backoff}ms then retry (${attempt}/${maxAttempts - 1})`);
      await sleep(backoff);
    }
  }
  const result = fc!;
  const prediction = decisionToPred(result.decision, result.providers_used);
  const gtFalse = row.label === 'FALSE';

  let outcome: ClaimResult['outcome'];
  if (prediction === 'ABSTAIN') outcome = 'ABSTAIN';
  else if (prediction === 'FALSE') outcome = gtFalse ? 'TP' : 'FP';
  else outcome = gtFalse ? 'FN' : 'TN';

  return {
    idx,
    claim: row.claim,
    label: row.label,
    domain: row.domain,
    difficulty: row.difficulty,
    hal_decision: result.decision,
    prediction,
    outcome,
    providers_used: result.providers_used,
    families_used: result.families_used,
    families: result.families,
    decision_reason: result.decision_reason,
    attempts: attempt,
    verdicts: result.verdicts.map((v: ProviderVerdict) => ({
      provider: v.provider,
      verdict: v.verdict,
      confidence: v.confidence,
      error: v.error,
      latency_ms: v.latency_ms,
    })),
  };
}

function tallyInto(cell: Cell, o: ClaimResult['outcome']) {
  if (o === 'TP') cell.tp++;
  else if (o === 'FP') cell.fp++;
  else if (o === 'TN') cell.tn++;
  else if (o === 'FN') cell.fn++;
  else cell.abstain++;
}

async function main() {
  const providers = buildQuorum();
  if (providers.length === 0) {
    console.error('[canary-f1] FATAL: no provider API keys present in env. Cannot run the REAL cross-LLM quorum. Aborting (a deterministic run is not the measurement we want).');
    process.exit(2);
  }

  // Force the REAL cross-LLM quorum path (never the deterministic extractor):
  process.env.HAL_DECISION_MODE = 'verdict'; // family-aware verdict-count decision (explainable path)
  process.env.HAL_QUORUM_FAMILY_AWARE = 'true'; // count distinct families
  process.env.HAL_QUORUM_COST_ORDERED = 'false'; // call ALL quorum members every claim (no early-stop) so the config is exactly what we set
  process.env.HAL_SBFA_SHADOW = 'false'; // no shadow telemetry noise
  process.env.HAL_LOCAL_FALLBACK_ENABLED = 'false'; // never substitute the local_slm string heuristic for a real vote

  const corpus = loadCorpus();
  const limit = Number(process.env.CANARY_LIMIT) || corpus.length;
  const rows = corpus.slice(0, limit);
  const delayMs = Number.isFinite(Number(process.env.CANARY_DELAY_MS)) ? Number(process.env.CANARY_DELAY_MS) : 1200;
  const concurrency = Math.min(2, Math.max(1, Number(process.env.CANARY_CONCURRENCY) || 1));

  console.log('\n=== CANARY HAL F1 BASELINE ===');
  console.log(`corpus: ${rows.length} claims (TRUE ${rows.filter((r) => r.label === 'TRUE').length} / FALSE ${rows.filter((r) => r.label === 'FALSE').length})`);
  console.log(`quorum: ${providers.map((p) => `${p.name}:${p.family}(${p.model})`).join('  +  ')}`);
  console.log(`pacing: concurrency=${concurrency} inter-claim-delay=${delayMs}ms  (per-provider 429 retry + whole-claim backoff on 0-provider)\n`);

  const results: ClaimResult[] = [];
  const all = empty();
  const byDomain: Record<string, Cell> = {};
  const byDifficulty: Record<string, Cell> = {};
  const providersEverResponded = new Set<string>();
  let totalProviderCalls = 0;
  let totalProviderErrors = 0;

  // Sequential (concurrency 1) or paired (concurrency 2) with an inter-batch delay.
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((row, k) => scoreClaim(row, i + k, providers)));
    for (const res of batchResults) {
      results.push(res);
      tallyInto(all, res.outcome);
      (byDomain[res.domain] ??= empty());
      tallyInto(byDomain[res.domain]!, res.outcome);
      (byDifficulty[res.difficulty] ??= empty());
      tallyInto(byDifficulty[res.difficulty]!, res.outcome);
      for (const v of res.verdicts) {
        totalProviderCalls++;
        if (v.verdict === 'ERROR') totalProviderErrors++;
        else providersEverResponded.add(v.provider);
      }
      const votes = res.verdicts.map((v) => `${v.provider[0]}${v.verdict[0]}${v.error ? '!' : ''}`).join(' ');
      process.stdout.write(
        `#${String(res.idx).padStart(2)} gt=${res.label.padEnd(5)} ${res.difficulty.padEnd(6)} hal=${res.hal_decision.padEnd(7)} -> ${res.outcome.padEnd(7)} [${votes}]\n`,
      );
    }
    if (i + concurrency < rows.length) await sleep(delayMs);
  }

  // HARD STOP: if NO provider ever produced a real verdict, this was a degenerate
  // (effectively deterministic / all-error) run — not the measurement we want.
  if (providersEverResponded.size === 0) {
    console.error('\n[canary-f1] FATAL: ZERO real provider verdicts across the entire run — every call errored/abstained. This is NOT a real cross-LLM measurement. Aborting non-zero.');
    process.exit(3);
  }

  const overall = metrics(all);
  console.log('\n\n=== RESULTS (positive class = catching a FALSE claim) ===');
  console.log(`accuracy=${overall.accuracy}  precision=${overall.precision}  recall=${overall.recall}  F1=${overall.f1}`);
  console.log(`confusion: TP=${all.tp} FP=${all.fp} TN=${all.tn} FN=${all.fn}  abstain=${all.abstain}  decided=${overall.decided}`);
  console.log(`providers that voted at least once: [${[...providersEverResponded].sort().join(', ')}]`);
  console.log(`provider error rate: ${totalProviderCalls ? +(totalProviderErrors / totalProviderCalls).toFixed(4) : 0} (${totalProviderErrors}/${totalProviderCalls})`);

  console.log('\nper-difficulty:');
  for (const [d, c] of Object.entries(byDifficulty)) {
    const m = metrics(c);
    console.log(`  ${d.padEnd(8)} F1=${m.f1} (P=${m.precision} R=${m.recall} acc=${m.accuracy}) TP=${c.tp} FP=${c.fp} TN=${c.tn} FN=${c.fn} abstain=${c.abstain}`);
  }

  // ---- write the markdown report ----
  const misclassified = results.filter((r) => r.outcome === 'FP' || r.outcome === 'FN' || r.outcome === 'ABSTAIN');
  const mdTable = (byX: Record<string, Cell>) =>
    Object.entries(byX)
      .sort()
      .map(([k, c]) => {
        const m = metrics(c);
        return `| ${k} | ${m.f1} | ${m.precision} | ${m.recall} | ${m.accuracy} | ${c.tp} | ${c.fp} | ${c.tn} | ${c.fn} | ${c.abstain} |`;
      })
      .join('\n');

  const md = `# Canary HAL F1 Baseline — ${new Date().toISOString()}

## What was measured
- **Corpus**: \`eval/canary/canary-corpus-v1.jsonl\` — 50 known-answer claims (${rows.filter((r) => r.label === 'TRUE').length} TRUE / ${rows.filter((r) => r.label === 'FALSE').length} FALSE). Cross-checked identical to Supabase artifact **173133** (\`HAL_Decisioning_Canary_Corpus_v1\`, GAMMA SQUAD, project qnnpjhlxljtqyigedwkb).
- **Path**: the REAL cross-LLM HAL quorum \`factCheck()\` (\`src/hal/fact-check.ts\`), invoked LOCALLY with live keys — **NOT** the deterministic extractor and **NOT** the production Railway endpoint.
- **Quorum under test**: ${providers.map((p) => `${p.name} (${p.family} / \`${p.model}\`)`).join(', ')}.
- **Providers that actually voted at least once**: ${[...providersEverResponded].sort().join(', ') || '(none)'}.
- **Decision mode**: \`HAL_DECISION_MODE=verdict\`, family-aware quorum, cost-ordering OFF (all members called each claim), SBFA shadow OFF, local-SLM fallback OFF.
- **Scoring**: \`clean\` ⇒ predicted-TRUE; \`flagged\`/\`vetoed\` ⇒ predicted-FALSE; positive class = **catch a FALSE claim**. \`abstain\` / 0-provider excluded from P/R/F1.
- **Pacing**: concurrency=${concurrency}, inter-claim delay=${delayMs}ms, per-provider jittered 429 retry (in \`postWith429Retry\`), plus whole-claim exponential backoff on a 0-provider result.
- **Reproduce**: \`npx ts-node scripts/eval/canary-f1.ts\` (keys auto-loaded from repo-root \`.env.master\`).

## Headline metrics
| metric | value |
|---|---|
| accuracy | **${overall.accuracy}** |
| precision | **${overall.precision}** |
| recall | **${overall.recall}** |
| **F1** | **${overall.f1}** |
| decided (scored) | ${overall.decided} |
| abstained (excluded) | ${all.abstain} |
| provider error rate | ${totalProviderCalls ? +(totalProviderErrors / totalProviderCalls).toFixed(4) : 0} (${totalProviderErrors}/${totalProviderCalls}) |

## Confusion matrix (positive = FALSE claim caught)
|  | HAL says FALSE (flag/veto) | HAL says TRUE (clean) | abstain |
|---|---|---|---|
| **claim is FALSE** | TP = ${all.tp} | FN = ${all.fn} | ${results.filter((r) => r.label === 'FALSE' && r.outcome === 'ABSTAIN').length} |
| **claim is TRUE** | FP = ${all.fp} | TN = ${all.tn} | ${results.filter((r) => r.label === 'TRUE' && r.outcome === 'ABSTAIN').length} |

## Per-difficulty
| difficulty | F1 | precision | recall | accuracy | TP | FP | TN | FN | abstain |
|---|---|---|---|---|---|---|---|---|---|
${mdTable(byDifficulty)}

## Per-domain
| domain | F1 | precision | recall | accuracy | TP | FP | TN | FN | abstain |
|---|---|---|---|---|---|---|---|---|---|
${mdTable(byDomain)}

## Misclassified / abstained claims (${misclassified.length})
| # | outcome | label | HAL | claim | providers voted (verdicts) |
|---|---|---|---|---|---|
${misclassified
  .map(
    (r) =>
      `| ${r.idx} | ${r.outcome} | ${r.label} | ${r.hal_decision} | ${r.claim.replace(/\|/g, '\\|').slice(0, 110)} | ${r.verdicts
        .map((v) => `${v.provider}=${v.verdict}${v.error ? '(err)' : `@${v.confidence}`}`)
        .join(', ')} |`,
  )
  .join('\n')}

## Abstain / quorum note
- Claims where the quorum could not reach a verdict (0 usable providers OR HAL \`abstain\`): **${all.abstain}**.
- Total provider calls: ${totalProviderCalls}; provider errors (429/timeout/empty): ${totalProviderErrors}.

_Generated by \`scripts/eval/canary-f1.ts\`._
`;

  const reportDir = path.resolve(__dirname, '../../reports/2026-07-07');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'CANARY_HAL_F1_BASELINE.md');
  fs.writeFileSync(reportPath, md);

  // also drop the raw JSON next to the report for full reproducibility
  const jsonPath = path.join(reportDir, `canary-f1-raw-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        corpus_size: rows.length,
        quorum: providers.map((p) => ({ name: p.name, model: p.model, family: p.family })),
        providers_that_voted: [...providersEverResponded].sort(),
        overall,
        confusion: all,
        by_difficulty: Object.fromEntries(Object.entries(byDifficulty).map(([k, c]) => [k, { ...metrics(c), cell: c }])),
        by_domain: Object.fromEntries(Object.entries(byDomain).map(([k, c]) => [k, { ...metrics(c), cell: c }])),
        results,
      },
      null,
      2,
    ),
  );

  console.log(`\nwrote report -> ${reportPath}`);
  console.log(`wrote raw    -> ${jsonPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[canary-f1] uncaught error:', e);
    process.exit(1);
  });
