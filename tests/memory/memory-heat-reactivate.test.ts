import { reactivateLeaves, reactivateLeaf, type ReactivateLeafFn } from '../../src/memory/memory-heat-reactivate';
import type { FetchLeavesFn, FetchLeavesResult } from '../../src/memory/memory-heat-db-sweep';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockSupabase = {} as unknown as SupabaseClient;

// "Warmed-up cold" leaf: 60-day-old access but 15 accesses →
//   recency = 2^(−2) ≈ 0.25; frequency = 15/50 = 0.3
//   heat ≈ 0.618*0.25 + 0.382*0.3 ≈ 0.269 — cold tier (< 0.3) but >= reactivationMinHeat (0.25)
const reactivationCandidateRow = {
  id: 'leaf-reactivate-1',
  root_epoch: 1,
  last_accessed_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
  access_count: 15,
};

// Fully cold leaf: 60-day-old, 0 accesses → heat ≈ 0.155 (< 0.25, NOT a reactivation candidate)
const fullyColdLeafRow = {
  id: 'leaf-cold-1',
  root_epoch: 1,
  last_accessed_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
  access_count: 0,
};

// Hot leaf: accessed 1 minute ago → not in cold list, never a reactivation candidate
const hotLeafRow = {
  id: 'leaf-hot-1',
  root_epoch: 1,
  last_accessed_at: new Date(Date.now() - 60 * 1000).toISOString(),
  access_count: 10,
};

function makeFetchFn(result: FetchLeavesResult): FetchLeavesFn {
  return async () => result;
}

const noopReactivate: ReactivateLeafFn = async () => 1;

describe('reactivateLeaves', () => {
  beforeEach(() => {
    delete process.env['HEAT_EVICTION_ENABLED'];
  });

  afterEach(() => {
    delete process.env['HEAT_EVICTION_ENABLED'];
  });

  it('returns skipped=true when HEAT_EVICTION_ENABLED is not set', async () => {
    const fetchFn = makeFetchFn({ rows: [reactivationCandidateRow], anchoredEpochs: new Set() });
    const result = await reactivateLeaves(mockSupabase, 'agent-1', {}, fetchFn, noopReactivate);
    expect(result.skipped).toBe(true);
    expect(result.reactivatedCount).toBe(0);
    expect(result.reactivatedIds).toEqual([]);
  });

  it('returns skipped=true when HEAT_EVICTION_ENABLED is "false"', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'false';
    const fetchFn = makeFetchFn({ rows: [reactivationCandidateRow], anchoredEpochs: new Set() });
    const result = await reactivateLeaves(mockSupabase, 'agent-1', {}, fetchFn, noopReactivate);
    expect(result.skipped).toBe(true);
    expect(result.reactivatedCount).toBe(0);
  });

  it('promotes a warmed-up cold leaf when HEAT_EVICTION_ENABLED=true', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchFn = makeFetchFn({ rows: [reactivationCandidateRow], anchoredEpochs: new Set() });
    const promoted: string[] = [];
    const reactivateFn: ReactivateLeafFn = async (_, id) => { promoted.push(id); return 1; };
    const result = await reactivateLeaves(mockSupabase, 'agent-1', {}, fetchFn, reactivateFn);
    expect(result.skipped).toBe(false);
    expect(result.reactivatedCount).toBe(1);
    expect(result.reactivatedIds).toEqual(['leaf-reactivate-1']);
    expect(promoted).toEqual(['leaf-reactivate-1']);
  });

  it('does not reactivate a fully cold leaf (heat below reactivationMinHeat)', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchFn = makeFetchFn({ rows: [fullyColdLeafRow], anchoredEpochs: new Set() });
    const promoted: string[] = [];
    const reactivateFn: ReactivateLeafFn = async (_, id) => { promoted.push(id); return 1; };
    const result = await reactivateLeaves(mockSupabase, 'agent-1', {}, fetchFn, reactivateFn);
    expect(result.skipped).toBe(false);
    expect(result.reactivatedCount).toBe(0);
    expect(promoted).toEqual([]);
  });

  it('does not reactivate hot leaves (not in cold list)', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchFn = makeFetchFn({ rows: [hotLeafRow], anchoredEpochs: new Set() });
    const promoted: string[] = [];
    const reactivateFn: ReactivateLeafFn = async (_, id) => { promoted.push(id); return 1; };
    const result = await reactivateLeaves(mockSupabase, 'agent-1', {}, fetchFn, reactivateFn);
    expect(result.skipped).toBe(false);
    expect(result.reactivatedCount).toBe(0);
    expect(promoted).toEqual([]);
  });

  it('does not count leaves where reactivateFn returns 0 (already warm or not cold)', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchFn = makeFetchFn({ rows: [reactivationCandidateRow], anchoredEpochs: new Set() });
    const reactivateFn: ReactivateLeafFn = async () => 0;
    const result = await reactivateLeaves(mockSupabase, 'agent-1', {}, fetchFn, reactivateFn);
    expect(result.reactivatedCount).toBe(0);
    expect(result.reactivatedIds).toEqual([]);
  });

  it('propagates error from reactivateFn', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchFn = makeFetchFn({ rows: [reactivationCandidateRow], anchoredEpochs: new Set() });
    const reactivateFn: ReactivateLeafFn = async () => { throw new Error('DB error'); };
    await expect(reactivateLeaves(mockSupabase, 'agent-1', {}, fetchFn, reactivateFn)).rejects.toThrow('DB error');
  });

  it('returns correct reactivatedIds for multiple candidates', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    // One clock reading. A later Date.now() is warmer and sorts first.
    const lastAccessedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const rows = [1, 2].map((i) => ({
      id: `leaf-reactivate-${i}`,
      root_epoch: 1,
      last_accessed_at: lastAccessedAt,
      access_count: 15,
    }));
    const fetchFn = makeFetchFn({ rows, anchoredEpochs: new Set() });
    const promoted: string[] = [];
    const reactivateFn: ReactivateLeafFn = async (_, id) => { promoted.push(id); return 1; };
    const result = await reactivateLeaves(mockSupabase, 'agent-1', {}, fetchFn, reactivateFn);
    expect(result.reactivatedCount).toBe(2);
    expect(result.reactivatedIds).toEqual(['leaf-reactivate-1', 'leaf-reactivate-2']);
  });
});

describe('reactivateLeaf', () => {
  it('is exported (smoke test for wiring)', () => {
    expect(typeof reactivateLeaf).toBe('function');
  });
});
