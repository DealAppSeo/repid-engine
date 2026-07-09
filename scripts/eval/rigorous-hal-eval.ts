/**
 * RIGOROUS HAL EVAL — RUNNER (real cross-LLM quorum, wide provider set).
 * ---------------------------------------------------------------------------
 * Builds on the canary-f1 harness (scripts/eval/canary-f1.ts): same real
 * `factCheck()` code path, same "record raw per-provider verdicts then analyse
 * offline" split. Differences:
 *   1. Corpus = eval/rigorous/rigorous-corpus-v1.jsonl (337 provenanced rows from
 *      FEVER + HaluEval + TruthfulQA + canary), not the 47-claim canary alone.
 *   2. WIDE quorum incl. THREE same-weight Llama-3.1-8B hosts (groq/sambanova/
 *      together) alongside 5 distinct families (glm/qwen/gemini/mistral/deepseek)
 *      so the offline analysis can measure INTER-FAMILY error correlation — the
 *      thesis experiment (do "6 providers" actually give independent votes?).
 *   3. All providers called EVERY claim (HAL_QUORUM_COST_ORDERED=false) so every
 *      provider has a verdict on every scored claim (needed for ablations + kappa).
 *
 * DISCIPLINE (unchanged from canary): real providers only; a provider that errors
 * is recorded as ERROR, never fabricated; if ZERO real verdicts across the run it
 * exits non-zero. No tuning to pass.
 *
 * Run (from repo root; keys auto-loaded from ../.env.master):
 *   npx ts-node scripts/eval/rigorous-hal-eval.ts
 * Env:
 *   RIG_LIMIT=150         score only the first N corpus rows (feasible sample)
 *   RIG_DELAY_MS=900      inter-claim delay (default 900)
 *   RIG_CORPUS=path       override corpus path
 *   RIG_OUT=path          override raw-json output path
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

const envMaster = path.resolve(__dirname, '../../../.env.master');
if (fs.existsSync(envMaster)) dotenv.config({ path: envMaster });
else dotenv.config();

import { factCheck, familyOf, type FactCheckProviderCfg, type ProviderVerdict, type HalDecision } from '../../src/hal/fact-check';

// --- WIDE quorum. Each entry key-gated; only key-present providers included. ---
// GROUP A: 6 distinct families.  GROUP B: 2 extra Llama-3.1-8B hosts (SAME weights
// as groq) so intra-family (shared-weight) error correlation is measurable.
interface PSpec { name: string; endpoint: string; envKey: string; model: string; family: string; }
// NOTE (live-key audit 2026-07-09): SambaNova (HTTP 402 no balance), Together (402
// credit limit), Fireworks (suspended), and BOTH Gemini keys (429 credits depleted)
// are paywalled/dead on the free tier — itself a finding: the "6 marketed families"
// are thinner live than on paper. Working free set = 7 hosts / 5 families below.
// The same-weight pair for the thesis is groq + deepinfra (both Llama-3.1-8B-Instruct).
const SPECS: PSpec[] = [
  { name: 'groq',        endpoint: 'https://api.groq.com/openai/v1/chat/completions',        envKey: 'GROQ_API_KEY',        model: 'llama-3.1-8b-instant',              family: 'llama'    },
  { name: 'deepinfra',   endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions',   envKey: 'DEEPINFRA_API_KEY',   model: 'meta-llama/Meta-Llama-3.1-8B-Instruct', family: 'llama' },
  { name: 'cerebras',    endpoint: 'https://api.cerebras.ai/v1/chat/completions',            envKey: 'CEREBRAS_API_KEY',    model: 'zai-glm-4.7',                       family: 'glm'      },
  { name: 'openrouter',  endpoint: 'https://openrouter.ai/api/v1/chat/completions',          envKey: 'OPENROUTER_API_KEY',  model: 'qwen/qwen-2.5-72b-instruct',        family: 'qwen'     },
  { name: 'siliconflow', endpoint: 'https://api.siliconflow.com/v1/chat/completions',        envKey: 'SILICONFLOW_API_KEY', model: 'Qwen/Qwen2.5-7B-Instruct',          family: 'qwen'     },
  { name: 'mistral',     endpoint: 'https://api.mistral.ai/v1/chat/completions',             envKey: 'MISTRAL_API_KEY',     model: 'mistral-small-latest',              family: 'mistral'  },
  { name: 'deepseek',    endpoint: 'https://api.deepseek.com/chat/completions',              envKey: 'DEEPSEEK_API_KEY',    model: 'deepseek-chat',                     family: 'deepseek' },
];

function buildQuorum(): FactCheckProviderCfg[] {
  const out: FactCheckProviderCfg[] = [];
  for (const s of SPECS) {
    const apiKey = process.env[s.envKey]?.trim();
    if (!apiKey) { console.warn(`[rigorous] skip ${s.name} — ${s.envKey} not present`); continue; }
    out.push({ name: s.name, endpoint: s.endpoint, apiKey, model: s.model, family: s.family, tier: 'free' });
  }
  return out;
}

interface CorpusRow {
  row_id: string; source: string; source_id: string; url: string;
  claim: string; label: 'TRUE' | 'FALSE'; domain: string; difficulty: string; construction: string;
}
function loadCorpus(): CorpusRow[] {
  const file = process.env.RIG_CORPUS
    ? path.resolve(process.env.RIG_CORPUS)
    : path.resolve(__dirname, '../../eval/rigorous/rigorous-corpus-v1.jsonl');
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as CorpusRow);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scoreClaim(row: CorpusRow, idx: number, providers: FactCheckProviderCfg[]) {
  const maxAttempts = 3;
  let attempt = 0;
  let fc: Awaited<ReturnType<typeof factCheck>> | null = null;
  while (attempt < maxAttempts) {
    attempt++;
    fc = await factCheck(row.claim, providers, { vetoThreshold: 0.5, flagThreshold: 0.35 });
    if (fc.providers_used > 0) break;
    if (attempt < maxAttempts) await sleep(1500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 500));
  }
  const r = fc!;
  return {
    idx, row_id: row.row_id, source: row.source, source_id: row.source_id, url: row.url,
    claim: row.claim, label: row.label, domain: row.domain, difficulty: row.difficulty, construction: row.construction,
    hal_decision: r.decision as HalDecision, decision_reason: r.decision_reason,
    providers_used: r.providers_used, families_used: r.families_used, families: r.families, attempts: attempt,
    verdicts: r.verdicts.map((v: ProviderVerdict) => ({
      provider: v.provider, verdict: v.verdict, confidence: v.confidence, error: v.error, latency_ms: v.latency_ms,
    })),
  };
}

async function main() {
  const providers = buildQuorum();
  if (providers.length < 2) { console.error('[rigorous] FATAL: <2 providers with keys present. Aborting.'); process.exit(2); }

  // Force the REAL cross-LLM quorum, ALL providers every claim (no cost-order early-stop).
  process.env.HAL_DECISION_MODE = 'verdict';
  process.env.HAL_QUORUM_FAMILY_AWARE = 'true';
  process.env.HAL_QUORUM_COST_ORDERED = 'false';
  process.env.HAL_SBFA_SHADOW = 'false';
  process.env.HAL_LOCAL_FALLBACK_ENABLED = 'false';

  const corpus = loadCorpus();
  const limit = Number(process.env.RIG_LIMIT) || corpus.length;
  const rows = corpus.slice(0, limit);
  const delayMs = Number.isFinite(Number(process.env.RIG_DELAY_MS)) ? Number(process.env.RIG_DELAY_MS) : 900;

  console.log('\n=== RIGOROUS HAL EVAL — RUNNER ===');
  console.log(`corpus: ${rows.length}/${corpus.length} rows (TRUE ${rows.filter((r) => r.label === 'TRUE').length} / FALSE ${rows.filter((r) => r.label === 'FALSE').length})`);
  console.log(`quorum: ${providers.map((p) => `${p.name}:${p.family}`).join('  ')}`);
  console.log(`pacing: seq, inter-claim delay=${delayMs}ms\n`);

  const results: any[] = [];
  const providersEverResponded = new Set<string>();
  let totalCalls = 0, totalErr = 0;
  const t0 = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const res = await scoreClaim(rows[i]!, i, providers);
    results.push(res);
    for (const v of res.verdicts) { totalCalls++; if (v.verdict === 'ERROR') totalErr++; else providersEverResponded.add(v.provider); }
    const votes = res.verdicts.map((v: any) => `${v.provider.slice(0, 3)}=${v.verdict[0]}${v.error ? '!' : ''}`).join(' ');
    process.stdout.write(`#${String(i).padStart(3)} [${res.source.slice(0, 4)}] gt=${res.label.padEnd(5)} hal=${res.hal_decision.padEnd(7)} fam=${res.families_used ?? 0} [${votes}]\n`);
    if (i + 1 < rows.length) await sleep(delayMs);
  }

  if (providersEverResponded.size === 0) { console.error('\n[rigorous] FATAL: ZERO real provider verdicts — not a real measurement. Aborting.'); process.exit(3); }

  const out = {
    harness: 'rigorous-hal-eval-v1',
    generated_at: new Date().toISOString(),
    elapsed_sec: Math.round((Date.now() - t0) / 1000),
    corpus_path: process.env.RIG_CORPUS || 'eval/rigorous/rigorous-corpus-v1.jsonl',
    corpus_size: rows.length,
    corpus_total: corpus.length,
    quorum: providers.map((p) => ({ name: p.name, model: p.model, family: p.family ?? familyOf(p.model) })),
    providers_that_voted: [...providersEverResponded].sort(),
    provider_calls: totalCalls,
    provider_errors: totalErr,
    results,
  };
  const outPath = process.env.RIG_OUT
    ? path.resolve(process.env.RIG_OUT)
    : path.resolve(__dirname, `../../reports/2026-07-09/rigorous-raw-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nscored ${rows.length} claims in ${out.elapsed_sec}s; providers that voted: [${out.providers_that_voted.join(', ')}]`);
  console.log(`provider error rate: ${(totalErr / (totalCalls || 1)).toFixed(3)} (${totalErr}/${totalCalls})`);
  console.log(`wrote raw -> ${outPath}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('[rigorous] uncaught:', e); process.exit(1); });
