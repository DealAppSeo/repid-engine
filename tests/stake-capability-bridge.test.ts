/**
 * Unit tests for the stake→capability bridge (sprint 2026-05-28, Phase 3).
 *
 * Mocks src/db so the bridge runs without Supabase. Verifies:
 *   - applyStakeCapability: micro→USDC conversion, per-agent stake row + cap.
 *   - lock preservation (available_amount=0 when a slash-lock exists).
 *   - slashAgentStake: reduces bonded stake, zeroes available, locks to claim.
 *   - slashAgentStake no-op when the agent has no active stake.
 *
 * Mock state lives on globalThis to avoid the jest.mock hoisting TDZ trap.
 */

(global as any).__sb = {
  agents: [] as any[],         // repid_agents rows returned for builder lookup
  existingStake: null as any,  // repid_agent_stakes maybeSingle result
  inserts: [] as any[],
  updates: [] as Array<{ table: string; payload: any }>,
};

function reset() {
  (global as any).__sb = { agents: [], existingStake: null, inserts: [], updates: [] };
}

jest.mock('../src/db', () => {
  const makeChain = (result: any): any => {
    const c: any = {
      select: () => c,
      eq: () => c,
      limit: () => c,
      order: () => c,
      maybeSingle: async () => result,
      single: async () => result,
      then: (resolve: any) => resolve(result), // `await chain` resolves to result
    };
    return c;
  };
  return {
    db: {
      from: (table: string) => ({
        select: () =>
          makeChain(
            table === 'repid_agents'
              ? { data: (global as any).__sb.agents, error: null }
              : { data: (global as any).__sb.existingStake, error: null },
          ),
        insert: (payload: any) => {
          (global as any).__sb.inserts.push({ table, payload });
          return Promise.resolve({ data: null, error: null });
        },
        update: (payload: any) => ({
          eq: () => {
            (global as any).__sb.updates.push({ table, payload });
            return Promise.resolve({ data: null, error: null });
          },
        }),
      }),
    },
  };
});

import { applyStakeCapability, slashAgentStake } from '../src/services/stake-capability-bridge';

const AUTH = 9_980_000n;   // 9.98 USDC in micro
const STAKE = 100_000_000n; // 100 USDC in micro

describe('applyStakeCapability', () => {
  beforeEach(reset);

  it('writes one stake row + one cap update per owned agent (micro→USDC)', async () => {
    (global as any).__sb.agents = [{ id: 'agent-1' }, { id: 'agent-2' }];
    const r = await applyStakeCapability('builder-x', AUTH, STAKE, { isSimulated: true });

    expect(r.agents_updated).toBe(2);
    expect(r.per_agent_max_transaction_usdc).toBeCloseTo(9.98, 5);
    expect(r.autonomous_cap).toBe(9);

    const stakeInserts = (global as any).__sb.inserts.filter((i: any) => i.table === 'repid_agent_stakes');
    expect(stakeInserts).toHaveLength(2);
    expect(stakeInserts[0].payload).toMatchObject({
      agent_id: 'agent-1',
      custody_type: 'simulated',
      status: 'active',
      max_transaction_usdc: 9.98,
      available_amount: 9.98,
      stake_amount_usdc: 100,
      trustescrow_id: 'simulated:cc-2026-05-28',
    });

    const capUpdates = (global as any).__sb.updates.filter((u: any) => u.table === 'repid_agents');
    expect(capUpdates).toHaveLength(2);
    expect(capUpdates[0].payload).toEqual({ autonomous_cap: 9 });
  });

  it('updates (not inserts) when an active stake row already exists', async () => {
    (global as any).__sb.agents = [{ id: 'agent-1' }];
    (global as any).__sb.existingStake = { id: 42, locked_for_claim_id: null };
    await applyStakeCapability('builder-x', AUTH, STAKE, { isSimulated: true });

    const stakeInserts = (global as any).__sb.inserts.filter((i: any) => i.table === 'repid_agent_stakes');
    const stakeUpdates = (global as any).__sb.updates.filter((u: any) => u.table === 'repid_agent_stakes');
    expect(stakeInserts).toHaveLength(0);
    expect(stakeUpdates).toHaveLength(1);
  });

  it('keeps available_amount=0 when the stake is locked to a claim', async () => {
    (global as any).__sb.agents = [{ id: 'agent-1' }];
    (global as any).__sb.existingStake = { id: 42, locked_for_claim_id: 7 };
    await applyStakeCapability('builder-x', AUTH, STAKE, { isSimulated: true });

    const upd = (global as any).__sb.updates.find((u: any) => u.table === 'repid_agent_stakes');
    expect(upd.payload.available_amount).toBe(0);
    expect(upd.payload.max_transaction_usdc).toBe(9.98);
  });

  it('marks custody_type onchain when not simulated', async () => {
    (global as any).__sb.agents = [{ id: 'agent-1' }];
    await applyStakeCapability('builder-x', AUTH, STAKE, { isSimulated: false });
    const ins = (global as any).__sb.inserts.find((i: any) => i.table === 'repid_agent_stakes');
    expect(ins.payload.custody_type).toBe('onchain');
    expect(ins.payload.trustescrow_id).toBeNull();
  });
});

describe('slashAgentStake', () => {
  beforeEach(reset);

  it('reduces bonded stake, zeroes available, locks to claim', async () => {
    (global as any).__sb.existingStake = { id: 42, stake_amount_usdc: 100, max_transaction_usdc: 9.98, available_amount: 9.98 };
    const r = await slashAgentStake('agent-1', 12345, 0.1);

    expect(r.ok).toBe(true);
    expect(r.slashed_usdc).toBeCloseTo(10, 5);
    expect(r.remaining_stake_usdc).toBeCloseTo(90, 5);
    expect(r.locked_for_claim_id).toBe(12345);

    const upd = (global as any).__sb.updates.find((u: any) => u.table === 'repid_agent_stakes');
    expect(upd.payload).toMatchObject({ stake_amount_usdc: 90, available_amount: 0, locked_for_claim_id: 12345 });
  });

  it('is a no-op (ok=false) when the agent has no active stake', async () => {
    (global as any).__sb.existingStake = null;
    const r = await slashAgentStake('agent-1', 999, 0.1);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no active stake');
    expect((global as any).__sb.updates).toHaveLength(0);
  });
});
