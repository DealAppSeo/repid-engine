/**
 * Reponomics — paper trade resolution tests.
 *
 * Smoke-level: verifies resolveOpenPaperTrades handles an empty queue
 * cleanly. Deeper resolver tests are integration-shaped (touch
 * resolveBet → apply_linked_bet_resolution RPC, requires Supabase) and
 * are run as part of the live demo walkthrough rather than unit tests.
 */

jest.mock('../src/db', () => {
  const tbl: any = {
    select: () => tbl,
    eq: () => tbl,
    order: () => tbl,
    in: () => tbl,
    limit: async () => ({ data: [], error: null }),
    update: () => ({ eq: async () => ({ data: null, error: null }) }),
    insert: () => ({
      select: () => ({ single: async () => ({ data: { id: 'x' }, error: null }) }),
    }),
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
  };
  return {
    db: {
      from: () => tbl,
      rpc: async () => ({ data: { id: 1, current_entry_hash: 'mock' }, error: null }),
    },
  };
});

import { resolveOpenPaperTrades } from '../src/services/paper-trade-resolver';

describe('paper-trade-resolver — empty queue', () => {
  it('returns inspected=0 resolved=0 when no open orders', async () => {
    const r = await resolveOpenPaperTrades({ limit: 10 });
    expect(r.ok).toBe(true);
    expect(r.inspected).toBe(0);
    expect(r.resolved).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.resolutions).toEqual([]);
  });
});
