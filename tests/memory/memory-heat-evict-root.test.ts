/**
 * Tests for evictAndUpdateRoot — the "root preserved" leg of item 13's acceptance test.
 *
 * All Supabase I/O is stubbed; performHeatEviction is called through injected evictLeafFn
 * and fetchFn so no DB is required.
 */

import { evictAndUpdateRoot } from '../../src/memory/memory-heat-evict-root';
import type { FetchLeavesResult } from '../../src/memory/memory-heat-db-sweep';
import type { MemoryLeafRow } from '../../src/memory/memory-root-store';

// Minimal stub supabase — only used as an opaque handle passed through to injected fns
const stubSupabase = {} as any;

const AGENT_ID = 'agent-abc';

// A cold leaf candidate returned by the sweep
const COLD_LEAF = { id: 'leaf-1', root_epoch: 1, last_accessed_at: new Date(0).toISOString(), access_count: 0 };
// A hot leaf that should NOT be evicted
const HOT_LEAF = { id: 'leaf-2', root_epoch: 1, last_accessed_at: new Date().toISOString(), access_count: 50 };

function makeFetchFn(leaves: FetchLeavesResult['rows']): (s: any, a: string) => Promise<FetchLeavesResult> {
  return async () => ({ rows: leaves, anchoredEpochs: new Set() });
}

function makeEvictFn(idsThatSucceed: Set<string>): (s: any, id: string) => Promise<number> {
  return async (_s, id) => (idsThatSucceed.has(id) ? 1 : 0);
}

const REMAINING_LEAF_ROWS: MemoryLeafRow[] = [
  { leaf_index: 0, value: '0', next: '0', tombstoned: false },
  { leaf_index: 1, value: '42', next: '0', tombstoned: false },
];

describe('evictAndUpdateRoot', () => {
  beforeEach(() => {
    delete process.env['HEAT_EVICTION_ENABLED'];
  });
  afterEach(() => {
    delete process.env['HEAT_EVICTION_ENABLED'];
  });

  test('flag off → skipped, no root fetch or store called', async () => {
    const fetchRootLeaves = jest.fn();
    const storeRoot = jest.fn();

    const result = await evictAndUpdateRoot(
      stubSupabase,
      AGENT_ID,
      undefined,
      makeFetchFn([HOT_LEAF]),
      makeEvictFn(new Set()),
      fetchRootLeaves,
      storeRoot,
    );

    expect(result.skipped).toBe(true);
    expect(result.evictedCount).toBe(0);
    expect(result.newRoot).toBeUndefined();
    expect(result.newEpoch).toBeUndefined();
    expect(fetchRootLeaves).not.toHaveBeenCalled();
    expect(storeRoot).not.toHaveBeenCalled();
  });

  test('flag on, no cold candidates → evictedCount=0, no root update', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchRootLeaves = jest.fn();
    const storeRoot = jest.fn();

    const result = await evictAndUpdateRoot(
      stubSupabase,
      AGENT_ID,
      undefined,
      makeFetchFn([HOT_LEAF]),
      makeEvictFn(new Set()),
      fetchRootLeaves,
      storeRoot,
    );

    expect(result.skipped).toBe(false);
    expect(result.evictedCount).toBe(0);
    expect(result.newRoot).toBeUndefined();
    expect(result.newEpoch).toBeUndefined();
    expect(fetchRootLeaves).not.toHaveBeenCalled();
    expect(storeRoot).not.toHaveBeenCalled();
  });

  test('flag on, 1 cold leaf evicted → fetchRootLeaves called, storeRoot called with correct args, newRoot and newEpoch returned', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const capturedStoreArgs: any[] = [];
    const fetchRootLeaves = jest.fn().mockResolvedValue(REMAINING_LEAF_ROWS);
    const storeRoot = jest.fn().mockImplementation(async (_s, agentId, root, leafCount) => {
      capturedStoreArgs.push({ agentId, root, leafCount });
      return 7;
    });

    const result = await evictAndUpdateRoot(
      stubSupabase,
      AGENT_ID,
      undefined,
      makeFetchFn([COLD_LEAF]),
      makeEvictFn(new Set(['leaf-1'])),
      fetchRootLeaves,
      storeRoot,
    );

    expect(result.skipped).toBe(false);
    expect(result.evictedCount).toBe(1);
    expect(result.evictedIds).toEqual(['leaf-1']);
    expect(result.newRoot).toBeDefined();
    expect(typeof result.newRoot).toBe('string');
    expect(result.newEpoch).toBe(7);

    expect(fetchRootLeaves).toHaveBeenCalledWith(stubSupabase, AGENT_ID);
    expect(capturedStoreArgs[0]).toMatchObject({
      agentId: AGENT_ID,
      root: result.newRoot,
      leafCount: REMAINING_LEAF_ROWS.length,
    });
  });

  test('fetchRootLeaves error propagated', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchRootLeaves = jest.fn().mockRejectedValue(new Error('db down'));
    const storeRoot = jest.fn();

    await expect(
      evictAndUpdateRoot(
        stubSupabase,
        AGENT_ID,
        undefined,
        makeFetchFn([COLD_LEAF]),
        makeEvictFn(new Set(['leaf-1'])),
        fetchRootLeaves,
        storeRoot,
      ),
    ).rejects.toThrow('db down');
    expect(storeRoot).not.toHaveBeenCalled();
  });

  test('storeRoot error propagated', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchRootLeaves = jest.fn().mockResolvedValue(REMAINING_LEAF_ROWS);
    const storeRoot = jest.fn().mockRejectedValue(new Error('insert failed'));

    await expect(
      evictAndUpdateRoot(
        stubSupabase,
        AGENT_ID,
        undefined,
        makeFetchFn([COLD_LEAF]),
        makeEvictFn(new Set(['leaf-1'])),
        fetchRootLeaves,
        storeRoot,
      ),
    ).rejects.toThrow('insert failed');
  });

  test('newRoot is deterministic across two calls with same leaves', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchRootLeaves = jest.fn().mockResolvedValue(REMAINING_LEAF_ROWS);
    const storeRoot = jest.fn().mockResolvedValue(1);

    const r1 = await evictAndUpdateRoot(
      stubSupabase,
      AGENT_ID,
      undefined,
      makeFetchFn([COLD_LEAF]),
      makeEvictFn(new Set(['leaf-1'])),
      fetchRootLeaves,
      storeRoot,
    );

    fetchRootLeaves.mockResolvedValue(REMAINING_LEAF_ROWS);
    storeRoot.mockResolvedValue(2);

    const r2 = await evictAndUpdateRoot(
      stubSupabase,
      AGENT_ID,
      undefined,
      makeFetchFn([COLD_LEAF]),
      makeEvictFn(new Set(['leaf-1'])),
      fetchRootLeaves,
      storeRoot,
    );

    expect(r1.newRoot).toBe(r2.newRoot);
  });

  test('storeRoot receives correct supabase handle', async () => {
    process.env['HEAT_EVICTION_ENABLED'] = 'true';
    const fetchRootLeaves = jest.fn().mockResolvedValue(REMAINING_LEAF_ROWS);
    let receivedSupabase: any;
    const storeRoot = jest.fn().mockImplementation(async (s) => {
      receivedSupabase = s;
      return 1;
    });

    await evictAndUpdateRoot(
      stubSupabase,
      AGENT_ID,
      undefined,
      makeFetchFn([COLD_LEAF]),
      makeEvictFn(new Set(['leaf-1'])),
      fetchRootLeaves,
      storeRoot,
    );

    expect(receivedSupabase).toBe(stubSupabase);
  });
});
