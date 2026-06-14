/**
 * router-verify.ts — VERIFY the unified free-first cost router (CC_ANFIS_COST_ROUTER_SPRINT).
 * Exercises the 5 sprint scenarios, writes REAL rows to anfis_routing_logs (un-cold), prints raw.
 * No live LLM calls — verifies the ROUTING DECISION + logging + budget + fallback (offline-deterministic).
 *
 *   railway run -- npx ts-node scripts/router-verify.ts
 */
import { routeAndLog } from '../src/services/cost-router';
import { markRateLimit, markSuccess } from '../src/providers/health';
import { db } from '../src/db';

const ALL_PROVIDERS = ['groq','cerebras','gemini','cohere','deepseek','anthropic','openai','llama-3.2-1b','gemma-3-2b','phi-4'];
/** Force every provider healthy (markSuccess clears resetAt — recoverProviders only clears EXPIRED marks). */
function reset() { for (const p of ALL_PROVIDERS) markSuccess(p); }

const TASKS: { prompt: string; task_hint: string }[] = [
  { prompt: 'Classify the sentiment: "great product".', task_hint: 'classification' },
  { prompt: 'What is the capital of France?', task_hint: 'factual' },
  { prompt: 'Summarize: the cat sat on the mat all day.', task_hint: 'summarize' },
  { prompt: 'Is 17 prime? yes/no', task_hint: 'quick_check' },
  { prompt: 'Translate "hello" to Spanish.', task_hint: 'simple' },
  { prompt: 'Extract the date from: meeting on 2026-06-13.', task_hint: 'classification' },
  { prompt: 'Route this request to a model.', task_hint: 'routing_decision' },
  { prompt: 'Define entropy in one sentence.', task_hint: 'factual' },
  { prompt: 'List three primary colors.', task_hint: 'simple' },
  { prompt: 'Is this spam? "win a prize now"', task_hint: 'classification' },
  { prompt: 'What year did WW2 end?', task_hint: 'factual' },
  { prompt: 'Shorten: please kindly send me the report.', task_hint: 'summarize' },
  { prompt: 'Tag the topic of: quarterly earnings call.', task_hint: 'classification' },
  { prompt: 'yes or no: is water wet?', task_hint: 'quick_check' },
  { prompt: 'Convert 10 km to miles (approx).', task_hint: 'simple' },
  { prompt: 'Name the largest planet.', task_hint: 'factual' },
  { prompt: 'Is "colour" British or American spelling?', task_hint: 'classification' },
  { prompt: 'Give a one-word mood for: sunny morning.', task_hint: 'quick_check' },
  { prompt: 'What is 12 x 12?', task_hint: 'factual' },
  { prompt: 'Pick a greeting for an email.', task_hint: 'simple' },
];

async function countLogs() {
  const { count } = await db.from('anfis_routing_logs').select('*', { count: 'exact', head: true });
  const { data } = await db.from('anfis_routing_logs').select('created_at').order('created_at', { ascending: false }).limit(1);
  return { n: count ?? 0, latest: data?.[0]?.created_at ?? null };
}

(async () => {
  const before = await countLogs();
  console.log(`\n[PRE] anfis_routing_logs: ${before.n} rows, latest=${before.latest}`);

  // ── Scenario A: 20 mixed general tasks, NO escalation → must NOT hit a paid lane.
  console.log('\n=== A) 20 mixed general tasks (free-first default) ===');
  reset();
  let paidHits = 0; const tierDist: Record<string, number> = {};
  for (const t of TASKS) {
    const u = await routeAndLog({ prompt: t.prompt, tier_preference: 'auto', task_hint: t.task_hint });
    tierDist[u.decision.chosen_tier] = (tierDist[u.decision.chosen_tier] || 0) + 1;
    if (u.hit_paid_lane) paidHits++;
    console.log(`  ${t.task_hint.padEnd(16)} → tier=${u.decision.chosen_tier} provider=${(u.decision.chosen_provider||'').padEnd(9)} pref=${u.effective_tier_pref} esc=${u.escalation} logged=${u.logged}`);
  }
  console.log(`  RESULT A: paid-lane hits = ${paidHits}/20 (expect 0) · tier distribution = ${JSON.stringify(tierDist)}`);

  // ── Scenario B: escalation signal (contested_bft) + all tier-0 down → reaches Tier-1.
  console.log('\n=== B) escalation (contested_bft) with tier-0 exhausted → Tier-1 reachable ===');
  reset();
  for (const p of ['groq','cerebras','gemini','cohere','deepseek']) markRateLimit(p, 120000);
  const b = await routeAndLog({ prompt: 'Resolve a contested BFT verdict on a subtle claim.', tier_preference: 'auto', task_hint: 'reasoning' }, { contested_bft: true });
  console.log(`  RESULT B: tier=${b.decision.chosen_tier} provider=${b.decision.chosen_provider} reason=${b.decision.reason} esc=${b.escalation} pref=${b.effective_tier_pref} (expect tier=1)`);

  // ── Scenario C: cheapest tier-0 (groq) down, NO escalation → fallback to next-cheapest tier-0, NOT premium.
  console.log('\n=== C) tier-0 groq down (no signal) → next-cheapest tier-0, never premium ===');
  reset();
  markRateLimit('groq', 120000);
  const c = await routeAndLog({ prompt: 'Summarize a short paragraph.', tier_preference: 'auto', task_hint: 'summarize' });
  console.log(`  RESULT C: tier=${c.decision.chosen_tier} provider=${c.decision.chosen_provider} reason=${c.decision.reason} (expect tier=0a, provider≠groq, NOT tier=1)`);

  // ── Scenario D: budget breach + escalation signal → fail CLOSED to free (never premium).
  console.log('\n=== D) budget breach + escalation → fail-closed to free ===');
  reset();
  process.env.ROUTER_DAILY_PAID_CAP = '50';        // a real ceiling
  process.env.ROUTER_FORCE_BUDGET_BREACH = 'true';  // simulate today's paid_tasks over the ceiling
  const d = await routeAndLog({ prompt: 'High-stakes contested verdict.', tier_preference: 'auto', task_hint: 'reasoning' }, { contested_bft: true, rep_id_stake: 9999, escalation_level: 2 });
  delete process.env.ROUTER_FORCE_BUDGET_BREACH;
  delete process.env.ROUTER_DAILY_PAID_CAP;
  console.log(`  RESULT D: tier=${d.decision.chosen_tier} provider=${d.decision.chosen_provider} budget_failclosed=${d.budget_failclosed} pref=${d.effective_tier_pref} (expect tier=0a/none, NOT tier=1, failclosed=true)`);

  reset();
  const after = await countLogs();
  console.log(`\n[POST] anfis_routing_logs: ${after.n} rows, latest=${after.latest}  (+${after.n - before.n} fresh)`);
  console.log(`\nSUMMARY: A paid=${paidHits}/20 | B tier=${b.decision.chosen_tier} | C provider=${c.decision.chosen_provider} | D failclosed=${d.budget_failclosed}/tier=${d.decision.chosen_tier} | logged +${after.n - before.n}`);
})().catch(e => { console.error('VERIFY ERROR', e); process.exit(1); });
