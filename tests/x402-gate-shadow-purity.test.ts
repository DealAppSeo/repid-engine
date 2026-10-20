/**
 * x402-gate-shadow-purity — turning OWNER_CEILING_SHADOW_ENABLED and STAKE_AUTHORITY_SHADOW_ENABLED
 * on must not change a single payment decision.
 *
 * Both are OFF in production (`GET /readiness`, 2026-10-20). Each module's own tests prove it is
 * inert while off and never throws, in isolation. What they do not prove is the property an
 * operator needs before flipping one: that the REAL gate (`checkTransactionAuthority`) returns the
 * same decision for the same request with the shadow on. Both observers receive the live `decision`
 * object by reference, so a synchronous write to it before an observer's first await would leak
 * into the returned copy; this test is what would catch that.
 *
 * Three identically seeded worlds, each a fresh LOCAL_MODE store, because the gate's own audit
 * rows feed `daily_used` and a reused store would change decisions for reasons unrelated to the
 * flags: A (off), B (both on), C (off again: the stability control). Pass = A equals B, A equals C,
 * and B shows each shadow actually ran while A shows neither did (otherwise equality is vacuous).
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const FLAGS = ['OWNER_CEILING_SHADOW_ENABLED', 'STAKE_AUTHORITY_SHADOW_ENABLED'] as const;

// agent, amount: a spread of authorised and every denial the gate can reach without other flags.
const REQUESTS: [string, number][] = [
  ['trinity-pa', 1], // PROBATIONARY cannot transact
  ['trinity-ea', 5], // EARNING: a wager in agent_stakes no longer counts (F2), so insufficient_stake
  ['trinity-ea', 15], // over the EARNING per-tx limit
  ['trinity-es', 5], // ESTABLISHED: its builder's real deposit is invisible to the gate
  ['trinity-au', 50], // AUTONOMOUS needs no stake: authorised
  ['trinity-au', 900], // ...authorised again, and the audit row now counts toward daily_used
  ['trinity-au', 2000], // over the AUTONOMOUS per-tx limit
  ['trinity-dx', 5], // open dispute
  ['trinity-nobody', 5], // agent_not_found
];

interface World {
  decisions: unknown[];
  ownerCeilingRows: number;
  stakeAuthorityLines: number;
}

async function world(on: boolean): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'x402-purity-'));
  process.env.LOCAL_MODE = 'true';
  process.env.LOCAL_STORE_PATH = join(dir, 'repid.db');
  for (const f of FLAGS) {
    if (on) process.env[f] = 'true';
    else delete process.env[f];
  }
  const lines: string[] = [];
  const spies = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn')].map((s) =>
    s.mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }),
  );
  jest.resetModules();
  const { db } = require('../src/db');
  const { checkTransactionAuthority } = require('../src/services/x402-gate');
  try {
    const agent = (agent_name: string, tier: string, current_repid: number, builder_id: string | null = null) =>
      db.from('repid_agents').insert({ id: `00000000-0000-4000-8000-${Buffer.from(agent_name).toString('hex').slice(0, 12).padStart(12, '0')}`, agent_name, tier, current_repid, builder_id, constitution: {} });
    await agent('trinity-pa', 'PROBATIONARY', 300);
    await agent('trinity-ea', 'EARNING', 700);
    await agent('trinity-es', 'ESTABLISHED', 1500, '00000000-0000-4000-8000-0000000b0001');
    await agent('trinity-au', 'AUTONOMOUS', 6000);
    await agent('trinity-dx', 'ESTABLISHED', 1500);
    await db.from('agent_stakes').insert({ staker_agent: 'EA', stake_amount: 20, status: 'active' });
    await db.from('dispute_claims').insert({ id: 'd1', defendant_agent: 'trinity-dx', status: 'filed' });
    // Real and simulated posted collateral for trinity-es's builder: the gate never reads it, the
    // stake-authority shadow does, so this is the row that gives it something to report.
    await db.from('stake_deposits').insert({ builder_id: '00000000-0000-4000-8000-0000000b0001', amount: 40, status: 'active', is_simulated: false });
    await db.from('stake_deposits').insert({ builder_id: '00000000-0000-4000-8000-0000000b0001', amount: 500, status: 'active', is_simulated: true });

    const decisions: unknown[] = [];
    for (const [a, amount] of REQUESTS) {
      decisions.push(await checkTransactionAuthority({ agent: a, transaction_type: 'service_payment', amount }));
    }
    await new Promise((r) => setTimeout(r, 300)); // both observers are fire-and-forget
    const logs = ((await db.from('trinity_agent_logs').select('*')).data ?? []) as any[];
    return {
      decisions: JSON.parse(JSON.stringify(decisions)),
      ownerCeilingRows: logs.filter((l) => l.action === 'owner_ceiling_shadow').length,
      stakeAuthorityLines: lines.filter((l) => l.includes('[stake-authority-shadow]')).length,
    };
  } finally {
    spies.forEach((s) => s.mockRestore());
    try { db.close?.(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('x402 gate: the two production-off shadows change no payment decision', () => {
  const saved = Object.fromEntries(FLAGS.map((f) => [f, process.env[f]]));
  let A: World, B: World, C: World;

  beforeAll(async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    A = await world(false);
    B = await world(true);
    C = await world(false);
  });

  afterAll(() => {
    for (const f of FLAGS) {
      if (saved[f] === undefined) delete process.env[f];
      else process.env[f] = saved[f];
    }
  });

  it('the requests span authorised and several distinct denials, so equality is not trivial', () => {
    const outcomes = new Set(A.decisions.map((d: any) => d.denial_reason ?? 'authorized'));
    expect(outcomes.has('authorized')).toBe(true);
    expect(outcomes.size).toBeGreaterThanOrEqual(5);
  });

  it('stability control: two worlds with the shadows off decide identically', () => {
    expect(C.decisions).toEqual(A.decisions);
  });

  it('the shadows did not run with the flags off, and both ran with them on', () => {
    expect([A.ownerCeilingRows, A.stakeAuthorityLines]).toEqual([0, 0]);
    expect(B.ownerCeilingRows).toBeGreaterThan(0);
    expect(B.stakeAuthorityLines).toBeGreaterThan(0);
  });

  it('PURITY: every decision is identical with both shadows on', () => {
    expect(B.decisions).toEqual(A.decisions);
  });
});
