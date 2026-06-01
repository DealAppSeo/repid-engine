/**
 * Builder W floor regression test.
 *
 * The `Builder W = 0 authority` bug shipped without a regression test:
 * a builder whose mean-active-RepID was below the BUILDER_FLOOR (5000)
 * had its authority correctly zeroed, but a future seed change could
 * silently re-introduce the inverted condition. This file pins the
 * three boundary cases and exercises both the real recomputeBuilderRepID
 * (to derive builder_repid from agent state) and computeAuthority (to
 * confirm the floor decision).
 */

let agentsTable: Array<{ id: string; last_active_at: string | null; current_repid: number }> = [];

jest.mock('../src/db', () => {
  const builder: any = {
    _table: '',
    select() { return this; },
    eq() { return this; },
    ilike() { return this; },
    update: () => ({ eq: async () => ({ data: null, error: null }) }),
    insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'new' }, error: null }) }) }),
    async maybeSingle() { return { data: null, error: null }; },
    async single() { return { data: null, error: null }; },
    // The recompute path does: db.from('repid_agents').select('...').eq('builder_id', builderId)
    // and awaits the result directly — so .eq() must resolve via thenable.
    then(resolve: (r: any) => void) {
      if (this._table === 'repid_agents') resolve({ data: agentsTable, error: null });
      else resolve({ data: null, error: null });
    },
  };
  return {
    db: {
      from(table: string) { builder._table = table; return builder; },
      rpc: async () => ({ data: null, error: null }),
    },
  };
});

import { recomputeBuilderRepID } from '../src/services/builder-registry';
import { computeAuthority, BUILDER_FLOOR } from '../src/services/stake-vault';

const recent = () => new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

function fiveActiveAgentsAt(repid: number) {
  return Array.from({ length: 5 }, (_, i) => ({
    id: `agent-${i}`,
    last_active_at: recent(),
    current_repid: repid,
  }));
}

const sampleAgent = { agentRepId: 6000, agentWisdom: 1500, agentCharacter: 1500 };
const sampleStake = 100_000_000n; // 100M units → sqrt = 10000

describe('builder W floor — regression for "authority = 0 below floor"', () => {
  it('builder with 5 agents at RepID 5500 → builder_repid >= 5000, authority > 0', async () => {
    agentsTable = fiveActiveAgentsAt(5500);
    const r = await recomputeBuilderRepID('builder-x');
    expect(r.builder_repid).toBe(5500);
    expect(r.builder_repid).toBeGreaterThanOrEqual(BUILDER_FLOOR);

    const a = computeAuthority({
      stakeAmount: sampleStake,
      ...sampleAgent,
      builderRepId: r.builder_repid,
    });
    expect(a.breakdown.builderFloorPassed).toBe(true);
    expect(a.authority > 0n).toBe(true);
  });

  it('builder with 5 agents at RepID 400 → builder_repid < 500, authority === 0n', async () => {
    agentsTable = fiveActiveAgentsAt(400);
    const r = await recomputeBuilderRepID('builder-y');
    expect(r.builder_repid).toBe(400);
    expect(r.builder_repid).toBeLessThan(BUILDER_FLOOR);

    const a = computeAuthority({
      stakeAmount: sampleStake,
      ...sampleAgent,
      builderRepId: r.builder_repid,
    });
    expect(a.breakdown.builderFloorPassed).toBe(false);
    expect(a.authority).toBe(0n);
    expect(a.breakdown.reason).toMatch(/below floor/i);
  });

  it('boundary: 5 agents at RepID 5000 exactly → builder_repid >= 5000, authority > 0', async () => {
    agentsTable = fiveActiveAgentsAt(5000);
    const r = await recomputeBuilderRepID('builder-z');
    expect(r.builder_repid).toBe(5000);
    expect(r.builder_repid).toBeGreaterThanOrEqual(BUILDER_FLOOR);

    const a = computeAuthority({
      stakeAmount: sampleStake,
      ...sampleAgent,
      builderRepId: r.builder_repid,
    });
    expect(a.breakdown.builderFloorPassed).toBe(true);
    expect(a.authority > 0n).toBe(true);
  });

  it('boundary - 1: builder repid 4999 → authority === 0n (proves the >= comparison)', () => {
    const a = computeAuthority({
      stakeAmount: sampleStake,
      ...sampleAgent,
      builderRepId: BUILDER_FLOOR - 1,
    });
    expect(a.authority).toBe(0n);
    expect(a.breakdown.builderFloorPassed).toBe(false);
  });
});
