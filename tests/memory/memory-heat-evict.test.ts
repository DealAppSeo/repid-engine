import { performHeatEviction, tombstoneLeaf, type EvictLeafFn } from '../../src/memory/memory-heat-evict';
import type { FetchLeavesFn, FetchLeavesResult } from '../../src/memory/memory-heat-db-sweep';
import type { SupabaseClient } from '@supabase/supabase-js';

const mockSupabase = {} as unknown as SupabaseClient;

// Cold leaf: 60-day-old access, 1 access → heat ≈ 0.25 (cold tier, eviction candidate)
const coldLeafRow = {
  id: 'leaf-cold-1',
  root_epoch: 1,
  last_accessed_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
  access_count: 1,
};

// Hot leaf: accessed 1 minute ago
const hotLeafRow = {
  id: 'leaf-hot-1',
  root_epoch: 1,
  last_accessed_at: new Date(Date.now() - 60 * 1000).toISOString(),
  access_count: 10,
};

function makeFetchFn(result: FetchLeavesResult): FetchLeavesFn {
  return async () => result;
}

const noopEvict: EvictLeafFn = async () => 1;

describe('performHeatEviction', () => {
  beforeEach(() => {
    delete process.env['HEAT_EVICTION_ENABLED'];
  });

  afterEach(() => {
    delete process.env['HEAT_EVICTION_ENABLED'];
  });

  it('returns skipped=true when HEAT_EVICTION_ENABLED is not set', async () => {
    const fetchFn = makeFetchFn({ rows: [coldLeafRow], anchoredEpochs: new Set() });
    const result = await performHeatEviction(mockSupabase, 'agent-1', {}, fetchFn, noopEvict);
    expect(result.skipped).toBe(true);
    expect(result.evictedCount).toBe(0);
    expect(result.evictedIds).toEqual([]);
  });

  it('returns skipped=true when HEAT_EVICTION_ENABLED is "false"', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'false';
    const fetchFn = makeFetchFn({ rows: [coldLeafRow], anchoredEpochs: new Set() });
    const result = await performHeatEviction(mockSupabase, 'agent-1', {}, fetchFn, noopEvict);
    expect(result.skipped).toBe(true);
    expect(result.evictedCount).toBe(0);
  });

  it('returns skipped=false and evicts cold candidate when HEAT_EVICTION_ENABLED=true', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchFn = makeFetchFn({ rows: [coldLeafRow], anchoredEpochs: new Set() });
    const evicted: string[] = [];
    const evictFn: EvictLeafFn = async (_, id) => { evicted.push(id); return 1; };
    const result = await performHeatEviction(mockSupabase, 'agent-1', {}, fetchFn, evictFn);
    expect(result.skipped).toBe(false);
    expect(result.evictedCount).toBe(1);
    expect(result.evictedIds).toEqual(['leaf-cold-1']);
    expect(evicted).toEqual(['leaf-cold-1']);
  });

  it('does not evict hot leaves when flag is on', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchFn = makeFetchFn({ rows: [hotLeafRow], anchoredEpochs: new Set() });
    const evicted: string[] = [];
    const evictFn: EvictLeafFn = async (_, id) => { evicted.push(id); return 1; };
    const result = await performHeatEviction(mockSupabase, 'agent-1', {}, fetchFn, evictFn);
    expect(result.skipped).toBe(false);
    expect(result.evictedCount).toBe(0);
    expect(evicted).toEqual([]);
  });

  it('does not count leaves where evictLeafFn returns 0 (already tombstoned)', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchFn = makeFetchFn({ rows: [coldLeafRow], anchoredEpochs: new Set() });
    const evictFn: EvictLeafFn = async () => 0; // row already tombstoned
    const result = await performHeatEviction(mockSupabase, 'agent-1', {}, fetchFn, evictFn);
    expect(result.evictedCount).toBe(0);
    expect(result.evictedIds).toEqual([]);
  });

  it('propagates error from evictLeafFn', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchFn = makeFetchFn({ rows: [coldLeafRow], anchoredEpochs: new Set() });
    const evictFn: EvictLeafFn = async () => { throw new Error('DB error'); };
    await expect(performHeatEviction(mockSupabase, 'agent-1', {}, fetchFn, evictFn)).rejects.toThrow('DB error');
  });

  it('respects evictionLimit option — only tombstones up to the limit', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    // Three cold leaves
    const rows = [1, 2, 3].map((i) => ({
      id: `leaf-cold-${i}`,
      root_epoch: 1,
      last_accessed_at: new Date(Date.now() - (60 + i) * 24 * 60 * 60 * 1000).toISOString(),
      access_count: 1,
    }));
    const fetchFn = makeFetchFn({ rows, anchoredEpochs: new Set() });
    const evicted: string[] = [];
    const evictFn: EvictLeafFn = async (_, id) => { evicted.push(id); return 1; };
    const result = await performHeatEviction(
      mockSupabase, 'agent-1', { evictionLimit: 2 }, fetchFn, evictFn,
    );
    expect(result.evictedCount).toBe(2);
    expect(evicted).toHaveLength(2);
  });
});

describe('tombstoneLeaf', () => {
  it('is exported (smoke test for wiring)', () => {
    expect(typeof tombstoneLeaf).toBe('function');
  });
});
