/**
 * S-R4 Phase 3 gate — run the adversarial x402 E2E and show the system SORT honest from fraud.
 * Synthetic agents only (trinity-adv-*); every row tagged run_id; cleanup at the end (revertible).
 * Run: MOCK_FACILITATOR=true ts-node scripts/t12/run-adversarial-e2e.ts
 */
import { db } from '../../src/db';
import { runExchange, Exchange } from '../../src/testing/adversarial-x402-e2e';

const START = 700;
const FAMILIES = ['grok', 'deepseek', 'qwen', 'chatgpt'];

async function ensureAgent(base: string, idx: number): Promise<string> {
  const { data: prior } = await db.from('repid_agents').select('id').ilike('agent_name', `%${base}`);
  for (const p of (prior ?? []) as any[]) await db.from('repid_score_events').delete().eq('agent_id', p.id);
  await db.from('repid_agents').delete().ilike('agent_name', `%${base}`);
  await db.from('repid_agents').insert({ agent_name: base, erc8004_address: `0x${(idx + 170).toString(16).padStart(40, '0')}`, current_repid: START, peak_repid: START });
  const { data } = await db.from('repid_agents').select('agent_name').ilike('agent_name', `%${base}`).maybeSingle();
  return (data as any)?.agent_name as string;
}
async function repid(name: string): Promise<number> {
  const { data } = await db.from('repid_agents').select('current_repid').eq('agent_name', name).maybeSingle();
  return (data as any)?.current_repid ?? -1;
}

(async () => {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  // Cast of synthetic agents.
  const names = ['adv-honest-prov', 'adv-honest-cons', 'adv-fraud-prov', 'adv-fraud-cons', 'adv-buyer', 'adv-seller'];
  const a: Record<string, string> = {};
  await Promise.all(names.map(async (n, i) => { a[n] = await ensureAgent(n, i); }));
  console.log(`[adv-e2e] run=${runId}; agents @${START}: ${Object.values(a).join(', ')}`);

  const exchanges: Exchange[] = [
    // Scenario A — take-and-run (provider paid, delivers nothing)
    { runId, provider: a['adv-fraud-prov']!, consumer: a['adv-buyer']!, scenario: 'take_and_run', amountUsdc: 0.5, adversaryFamily: 'grok' },
    // Scenario B — deliver-and-stiff (consumer underpays vs contract)
    { runId, provider: a['adv-seller']!, consumer: a['adv-fraud-cons']!, scenario: 'deliver_and_stiff', amountUsdc: 0.2, agreedPriceUsdc: 0.8, adversaryFamily: 'deepseek' },
    // Contention — mixed honest + fraud across families (the system must sort them)
    { runId, provider: a['adv-honest-prov']!, consumer: a['adv-honest-cons']!, scenario: 'honest', amountUsdc: 0.5 },
    { runId, provider: a['adv-fraud-prov']!, consumer: a['adv-buyer']!, scenario: 'take_and_run', amountUsdc: 0.3, adversaryFamily: 'qwen' },
    { runId, provider: a['adv-honest-prov']!, consumer: a['adv-honest-cons']!, scenario: 'honest', amountUsdc: 0.4 },
    { runId, provider: a['adv-seller']!, consumer: a['adv-fraud-cons']!, scenario: 'deliver_and_stiff', amountUsdc: 0.1, agreedPriceUsdc: 0.9, adversaryFamily: 'chatgpt' },
  ];

  console.log('\n=== ADVERSARIAL TRANSCRIPT (watch them try to cheat) ===');
  const results = [];
  for (const ex of exchanges) { const r = await runExchange(ex); results.push(r); console.log(`  ${r.caught ? '🚨' : '✅'} ${r.transcript} | x402=${r.x402_source} t12#${r.t12_id}${r.red_team_id ? ' rt#' + r.red_team_id : ''}`); }

  // The sort: honest rise, fraud fall.
  console.log('\n=== THE SORT (RepID before→after, start 700) ===');
  const roles: Array<[string, string]> = [['honest provider', a['adv-honest-prov']!], ['honest consumer', a['adv-honest-cons']!], ['fraud provider (take-and-run)', a['adv-fraud-prov']!], ['fraud consumer (deliver-and-stiff)', a['adv-fraud-cons']!]];
  let pass = true;
  for (const [label, name] of roles) {
    const now = await repid(name); const dir = now > START ? '↑ rose' : now < START ? '↓ fell' : '= flat';
    const expectUp = label.startsWith('honest');
    const ok = expectUp ? now > START : now < START;
    if (!ok) pass = false;
    console.log(`  ${ok ? 'OK ' : 'XX '} ${label.padEnd(34)} 700 → ${now}  ${dir}`);
  }

  const caught = results.filter((r) => r.caught).length;
  const { count: rtCount } = await db.from('red_team_results').select('id', { count: 'exact', head: true }).like('challenge_id', `adv-%${runId}`);
  const { count: t12Count } = await db.from('t12_e2e_proofs').select('id', { count: 'exact', head: true }).eq('run_id', runId);
  console.log(`\n=== LEDGERS ===  red_team_results: ${rtCount ?? '?'} rows  |  t12_e2e_proofs: ${t12Count ?? '?'} rows  |  fraud caught: ${caught}/${exchanges.length}`);
  console.log(`VERDICT: ${pass ? 'PASS — honest rose, fraudsters fell (system sorts them)' : 'FAIL — sorting did not hold'}`);

  if (process.env.ADV_CLEANUP !== 'false') {
    for (const n of Object.values(a)) {
      const { data: ag } = await db.from('repid_agents').select('id').eq('agent_name', n).maybeSingle();
      if ((ag as any)?.id) await db.from('repid_score_events').delete().eq('agent_id', (ag as any).id);
      await db.from('repid_agents').delete().eq('agent_name', n);
    }
    console.log('\n(cleanup: synth agents + their score-events removed; set ADV_CLEANUP=false to keep. red_team_results + t12_e2e_proofs ledger rows kept as proof.)');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
