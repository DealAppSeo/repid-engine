/**
 * flag-matrix — flip RepID switches on the REAL engine code, locally, and measure what each does.
 *
 * Pre-registration: side-session notes flag-experiments/PREREG.md (E1 decay fidelity, E2 satisfaction
 * weighting, E4 shadow purity). Flags are read at module load, so every configuration runs in its own
 * child process with a fresh LOCAL_MODE store, the same synthetic agents and the egress tripwire; every
 * configuration runs twice and must reproduce itself exactly, or the run is void.
 *
 * Run: npx ts-node --transpile-only scripts/e2e-local/flag-matrix.ts [out.json]
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Env = Record<string, string>;
const CONFIGS: { name: string; env: Env }[] = [
  { name: 'base', env: {} },
  { name: 'decay=shadow', env: { REPID_DECAY_MODE: 'shadow' } },
  { name: 'decay=enforce', env: { REPID_DECAY_MODE: 'enforce' } },
  { name: 'settlement_shadow=on', env: { SETTLEMENT_SCORE_SHADOW_ENABLED: 'true' } },
  { name: 'owner_distinct_shadow=on', env: { OWNER_DISTINCT_SHADOW: 'true' } },
];
const GRID_REPID = [200, 500, 1000, 2500, 5000, 9000];
const GRID_ACT = [0, 1, 5, 20, 100];
const SAT = [0, 0.25, 0.5, 0.95, 1];
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

// ─────────────────────────────── child: one configuration ───────────────────────────────
async function child() {
  process.env.LOCAL_MODE = 'true';
  process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
  process.env.LOCAL_STORE_PATH = join(mkdtempSync(join(tmpdir(), 'flagmx-')), 'repid.db');
  for (const k of Object.keys(process.env)) {
    if (/^SUPABASE_|^ERC8004_|PRIVATE_KEY|_RPC_URL$|^DATABASE_URL$|_API_KEY$|^ZKP_SERVICE_URL$/.test(k)) delete process.env[k];
  }
  const { isLocalHost } = require('../../src/selfhost/egress-guard');
  const blocked: string[] = [];
  const realFetch = global.fetch;
  (global as any).fetch = (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (!isLocalHost(url)) {
      blocked.push(new URL(url).host);
      return Promise.reject(new Error(`EGRESS VIOLATION: ${url}`));
    }
    return (realFetch as any)(input, init);
  };
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: any[]) => { logs.push(a.map(String).join(' ')); };
  console.warn = console.log;
  console.error = console.log;

  const { db } = require('../../src/db');
  const d = require('../../src/services/validation-repid-delta');
  const { finalizeSettledContract } = require('../../src/services/contract-settlement-finalize');
  let n = 0x100;
  const agent = async (repid: number, act: number) => {
    const id = uuid(++n);
    await db.from('repid_agents').insert({ id, agent_id: id, agent_name: `FM-${n}`, current_repid: repid, tier: 'PROBATIONARY', activity_30d: act, constitution: {} });
    // Decay reads the agent's own ledger (assessEventDecay), so activity is seeded as real rows.
    for (let i = 0; i < act; i++) {
      await db.from('repid_score_events').insert({ id: uuid(0xa00000 + ++n), agent_id: id, event_type: 'SEED', delta: 0, repid_before: repid, repid_after: repid, is_shadow: false, metadata: {}, created_at: new Date(Date.now() - 3600_000).toISOString() });
    }
    return id;
  };
  const contract = async (p: string, b: string, simulated: boolean, status = 'fulfilled') => {
    const id = uuid(++n), sid = uuid(++n);
    await db.from('x402_settlements').insert({ id: sid, tx_hash: '0x' + n.toString(16).padStart(64, '0'), is_simulated: simulated, payer_address: '0x' + '1'.repeat(40), status: 'settled' });
    await db.from('service_contracts').insert({ id, service_id: uuid(0xfff), provider_agent_id: p, buyer_agent_id: b, x402_payment_id: sid, status, metadata: {}, payload: { content: 'synthetic' }, result: { verdict: 'synthetic' }, agreed_price_usdc_raw: 1000000 });
    return { id, service_id: uuid(0xfff), provider_agent_id: p, buyer_agent_id: b };
  };
  const events = async (agentId: string, contractId?: string) =>
    ((await db.from('repid_score_events').select('*').eq('agent_id', agentId)).data as any[])
      .filter((e) => e.event_type !== 'SEED')
      .filter((e) => !contractId || e.contract_id === contractId)
      .map((e) => ({ type: e.event_type, delta: e.delta, before: e.repid_before, after: e.repid_after, decay: e.metadata?.decay ?? null }));
  const repid = async (id: string) => (await db.from('repid_agents').select('*').eq('id', id).single()).data.current_repid;

  // E1: one SERVICE_SATISFIED (s = 1) per (repid, activity) cell, provider side.
  const e1: any[] = [];
  for (const r of GRID_REPID) for (const a of GRID_ACT) {
    const p = await agent(r, a), b = await agent(500, 100);
    const c = await contract(p, b, false);
    await d.applyServiceSatisfiedDeltas(c, 1);
    e1.push({ repid: r, act: a, ev: (await events(p, c.id))[0] });
  }
  // E2: satisfaction weighting through the live leg.
  const e2: any[] = [];
  for (const s of SAT) {
    const p = await agent(1000, 100), b = await agent(1000, 100);
    const c = await contract(p, b, false);
    await d.applyServiceSatisfiedDeltas(c, s);
    e2.push({ s, provider: (await events(p, c.id)).map((e) => e.delta), buyer: (await events(b, c.id)).map((e) => e.delta) });
  }
  // E4: the exchange path end to end. T1 fulfilled, T2 via the real finalize (s = 0.95), T3 good,
  // then a second contract: T3 bad + dispute provider_at_fault; and a simulated control.
  const P = await agent(1200, 3), B = await agent(500, 100), Bc = await agent(500, 100);
  const A = await contract(P, B, false);
  await d.applyServiceFulfilledDeltas(A);
  const fin = await finalizeSettledContract({ contractId: A.id, satisfactionScore: 0.95 });
  await d.applyServiceOutcomeDeltas(A, 'good', await repid(B));
  const A2 = await contract(P, B, false);
  await d.applyServiceOutcomeDeltas(A2, 'bad', await repid(B));
  await d.applyServiceDisputeResolution(A2, 'provider_at_fault');
  const C = await contract(P, Bc, true);
  await d.applyServiceFulfilledDeltas(C);
  await finalizeSettledContract({ contractId: C.id, satisfactionScore: 1 });
  await d.applyServiceDisputeResolution(C, 'provider_at_fault');
  await new Promise((r) => setTimeout(r, 300)); // let fire-and-forget shadows land
  const strip = (es: any[]) => es.map(({ decay, ...rest }) => rest);
  const decaySeq = (await events(P)).map((e) => ({ applied: !!e.decay?.applied, period_hit: !!e.decay?.period_hit, skipped: e.decay?.skipped ?? null }));
  const e4 = {
    finalize_ok: fin?.ok ?? null,
    provider: strip(await events(P)), buyer: strip(await events(B)), control_buyer: strip(await events(Bc)),
    final: { P: await repid(P), B: await repid(B), Bc: await repid(Bc) },
  };
  // Non-vacuity: did each shadow actually run here?
  const odLines = logs.filter((l) => /owner[-_]distinct/i.test(l));
  const traces = {
    decay_shadow_rows: e1.filter((x) => x.ev?.decay?.mode === 'shadow').length,
    trinity_agent_logs_total: ((await db.from('trinity_agent_logs').select('*')).data ?? []).length,
    owner_distinct_log_lines: odLines.length,
    owner_distinct_sample: odLines.slice(0, 2),
  };
  console.log = realLog;
  process.stdout.write('\n@@RESULT@@' + JSON.stringify({ e1, e2, e4, decaySeq, traces, egress_blocked_hosts: [...new Set(blocked)] }) + '\n');
  try { db.close?.(); } catch { /* ignore */ }
}

// ─────────────────────────────── parent: run, repeat, compare ───────────────────────────────
function run(env: Env) {
  const r = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', __filename, '--child'], {
    env: { ...process.env, ...env, TS_NODE_TRANSPILE_ONLY: 'true' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@RESULT@@'));
  if (!line) throw new Error(`child produced no result (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(-1500)}`);
  return JSON.parse(line.slice('@@RESULT@@'.length));
}

const clamp = (x: number) => Math.min(10000, Math.max(10, x));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function parent() {
  const res: Record<string, any> = {};
  const checks: { id: string; outcome: 'PASS' | 'FAIL' | 'NOT_CHECKED'; detail?: unknown }[] = [];
  const check = (id: string, ok: boolean | null, detail?: unknown) => {
    checks.push({ id, outcome: ok === null ? 'NOT_CHECKED' : ok ? 'PASS' : 'FAIL', detail });
    console.log(`${ok === null ? 'NOT_CHECKED' : ok ? 'PASS' : 'FAIL'}  ${id}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
  };
  for (const c of CONFIGS) {
    const r1 = run(c.env), r2 = run(c.env);
    res[c.name] = r1;
    check(`determinism: ${c.name} reproduces itself exactly`, same(r1, r2));
    check(`egress: ${c.name} made no non-local request`, r1.egress_blocked_hosts.length === 0, r1.egress_blocked_hosts);
  }
  const base = res['base'], sh = res['decay=shadow'], en = res['decay=enforce'];

  // E1 fidelity
  const cells = sh.e1.length;
  const shadowConsistent = sh.e1.filter((x: any) => x.ev.after === clamp(x.ev.before + x.ev.delta) && x.ev.decay && x.ev.decay.mode === 'shadow').length;
  const enforceMatches = en.e1.filter((x: any, i: number) => {
    const s = sh.e1[i].ev.decay;
    return x.ev.after === clamp((s.period_hit ? s.decayed_to : x.ev.before) + x.ev.delta);
  }).length;
  const offEqualsShadow = base.e1.filter((x: any, i: number) => same([x.ev.delta, x.ev.before, x.ev.after], [sh.e1[i].ev.delta, sh.e1[i].ev.before, sh.e1[i].ev.after])).length;
  check(`E1a shadow rows move by delta only, and carry the decay assessment (${cells} cells)`, shadowConsistent === cells, { shadowConsistent, cells });
  check(`E1a enforce applies exactly what the shadow marked (period_hit ? decayed_to : before) + delta (${cells} cells)`, enforceMatches === cells, { enforceMatches, cells });
  check(`E1a off = shadow on every score column (${cells} cells)`, offEqualsShadow === cells, { offEqualsShadow, cells });
  const removed = sh.e1.map((x: any) => ({ repid: x.repid, act: x.act, would_remove: x.ev.decay.would_remove }));
  console.log('      E1 local would_remove grid (DEV placeholder params; shape only):', JSON.stringify(removed.filter((x: any) => x.would_remove > 0).map((x: any) => `${x.repid}@${x.act}:-${x.would_remove}`)));

  // E2 weighting (live path), with JS Math.round as the engine uses it
  const e2ok = base.e2.every((x: any) => same(x.provider, [Math.round(30 * x.s)]) && same(x.buyer, [Math.round(15 * x.s)]));
  check('E2 live satisfied leg = round(30·s) provider, round(15·s) buyer at every s (H2)', e2ok, base.e2);

  // E4 shadow purity, each with its non-vacuity witness
  const outcome = (r: any) => r.e4;
  const pairs: [string, string, string, (r: any) => number][] = [
    ['decay off vs shadow', 'base', 'decay=shadow', (r) => r.traces.decay_shadow_rows],
    ['settlement shadow off vs on', 'base', 'settlement_shadow=on', (r) => r.traces.trinity_agent_logs_total],
    ['owner-distinct shadow off vs on', 'base', 'owner_distinct_shadow=on', (r) => r.traces.owner_distinct_log_lines],
  ];
  for (const [label, a, b, witness] of pairs) {
    const ran = witness(res[b]) > 0 && witness(res[a]) === 0;
    const identical = same(outcome(res[a]), outcome(res[b]));
    check(`E4 purity: ${label}: identical score outcomes`, ran ? identical : null, ran ? undefined : { note: 'the shadow left no trace in the ON run, so identical outcomes prove nothing', witnessOn: witness(res[b]), witnessOff: witness(res[a]) });
  }
  check('E4 enforce is NOT pure (decay=enforce changes outcomes; control for the purity test)', !same(outcome(base), outcome(en)));

  // E5: the three blockers (PREREG E1; fix/cc1-2026-10-20-decay-enforce-blockers)
  const applied = en.decaySeq.filter((d: any) => d.applied).length;
  check('E5 enforce: decay lands at most once per window on the provider (7 events)', applied <= 1, en.decaySeq);
  const zeroMoves = [...en.e4.provider, ...en.e4.control_buyer].filter((e: any) => e.delta === 0 && e.before !== e.after);
  check('E5 enforce: zero-delta events (incl. the simulated control) move no score', zeroMoves.length === 0, zeroMoves);
  check('E5 shadow marks exactly the events enforce decays', same(sh.decaySeq.map((d: any) => d.period_hit), en.decaySeq.map((d: any) => d.applied)), { shadow: sh.decaySeq, enforce: en.decaySeq });
  const busy = sh.e1.filter((x: any) => x.repid === 2500).map((x: any) => x.ev.decay.would_remove);
  check('E5 activity is the ledger: more seeded events, less decay (repid 2500, act 0→100)', busy.every((w: number, i: number) => i === 0 || w <= busy[i - 1]) && busy[0] > busy[busy.length - 1], busy);
  check('E4 the real finalize path ran (settled)', base.e4.finalize_ok === true, base.e4.finalize_ok);
  console.log('      E4 base outcome:', JSON.stringify(base.e4.final), '| enforce:', JSON.stringify(en.e4.final));

  const out = process.argv[2];
  if (out) writeFileSync(out, JSON.stringify({ configs: CONFIGS, results: res, checks }, null, 2));
  const failed = checks.filter((c) => c.outcome === 'FAIL').length;
  console.log(`\n${checks.filter((c) => c.outcome === 'PASS').length} PASS, ${failed} FAIL, ${checks.filter((c) => c.outcome === 'NOT_CHECKED').length} NOT_CHECKED`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv.includes('--child')) child().catch((e) => { process.stdout.write('\n@@RESULT@@' + JSON.stringify({ error: String(e?.stack ?? e) }) + '\n'); process.exitCode = 2; });
else parent();
