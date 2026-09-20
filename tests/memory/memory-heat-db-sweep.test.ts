/**
 * Tests for memory-heat-db-sweep.ts (item 13).
 * All Supabase I/O is stubbed — no live DB required.
 */

import {
  rowsToHeatLeaves,
  runHeatEvictionSweepForAgent,
  type AgentMemoryLeafRow,
  type FetchLeavesResult,
} from '../../src/memory/memory-heat-db-sweep';

const AGENT_ID = '00000000-0000-0000-0000-000000000001';

// A stub SupabaseClient placeholder — never actually called; fetchFn is injected.
const supabase = {} as any;

// Helper: ISO timestamp N days ago
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// Helper: build a minimal row
function makeRow(id: number, epoch: number, daysOld: number, accessCount = 3): AgentMemoryLeafRow {
  return { id, root_epoch: epoch, last_accessed_at: daysAgo(daysOld), access_count: accessCount };
}

describe('rowsToHeatLeaves', () => {
  test('empty rows → empty HeatLeaf array', () => {
    expect(rowsToHeatLeaves([], new Set())).toEqual([]);
  });

  test('maps id as string', () => {
    const row = makeRow(42, 1, 1);
    const [leaf] = rowsToHeatLeaves([row], new Set());
    expect(leaf.id).toBe('42');
  });

  test('maps last_accessed_at to lastAccessedMs', () => {
    const ts = new Date(Date.now() - 5000).toISOString();
    const row: AgentMemoryLeafRow = { id: 1, root_epoch: 1, last_accessed_at: ts, access_count: 1 };
    const [leaf] = rowsToHeatLeaves([row], new Set());
    expect(leaf.lastAccessedMs).toBe(new Date(ts).getTime());
  });

  test('maps access_count correctly', () => {
    const row = makeRow(1, 1, 0, 7);
    const [leaf] = rowsToHeatLeaves([row], new Set());
    expect(leaf.accessCount).toBe(7);
  });

  test('isAnchored true when root_epoch is in anchoredEpochs', () => {
    const row = makeRow(1, 5, 1);
    const [leaf] = rowsToHeatLeaves([row], new Set([5]));
    expect(leaf.isAnchored).toBe(true);
  });

  test('isAnchored false when root_epoch not in anchoredEpochs', () => {
    const row = makeRow(1, 5, 1);
    const [leaf] = rowsToHeatLeaves([row], new Set([99]));
    expect(leaf.isAnchored).toBe(false);
  });

  test('mixed anchored epochs — correct per-leaf', () => {
    const rows = [makeRow(1, 1, 1), makeRow(2, 2, 1), makeRow(3, 2, 1)];
    const leaves = rowsToHeatLeaves(rows, new Set([2]));
    expect(leaves[0]!.isAnchored).toBe(false);
    expect(leaves[1]!.isAnchored).toBe(true);
    expect(leaves[2]!.isAnchored).toBe(true);
  });
});

describe('runHeatEvictionSweepForAgent', () => {
  function makeFetch(result: FetchLeavesResult) {
    return jest.fn().mockResolvedValue(result);
  }

  test('empty agent → empty report', async () => {
    const fetchFn = makeFetch({ rows: [], anchoredEpochs: new Set() });
    const report = await runHeatEvictionSweepForAgent(supabase, AGENT_ID, {}, fetchFn);
    expect(report.stats.total).toBe(0);
    expect(report.evictionCandidates).toHaveLength(0);
  });

  test('hot leaf → not in eviction candidates', async () => {
    // Accessed 0 days ago → heat ≈ 0.618 (recency) + 0.382 * (3/50) → > 0.6 → hot
    const fetchFn = makeFetch({
      rows: [makeRow(1, 1, 0, 3)],
      anchoredEpochs: new Set(),
    });
    const report = await runHeatEvictionSweepForAgent(supabase, AGENT_ID, {}, fetchFn);
    expect(report.stats.hotCount).toBe(1);
    expect(report.evictionCandidates).toHaveLength(0);
  });

  test('cold leaf → in eviction candidates', async () => {
    // Accessed 90 days ago, count=1 → heat ≈ very low → cold
    const fetchFn = makeFetch({
      rows: [makeRow(1, 1, 90, 1)],
      anchoredEpochs: new Set(),
    });
    const report = await runHeatEvictionSweepForAgent(supabase, AGENT_ID, {}, fetchFn);
    expect(report.stats.coldCount).toBe(1);
    expect(report.evictionCandidates).toHaveLength(1);
  });

  test('anchored leaf → on_chain tier, never evicted', async () => {
    const fetchFn = makeFetch({
      rows: [makeRow(1, 5, 90, 1)],
      anchoredEpochs: new Set([5]),
    });
    const report = await runHeatEvictionSweepForAgent(supabase, AGENT_ID, {}, fetchFn);
    expect(report.stats.onChainCount).toBe(1);
    expect(report.evictionCandidates).toHaveLength(0);
  });

  test('DB error propagates — leaves query throws', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('[HEAT-DB-SWEEP] leaves query failed: connection refused'));
    await expect(runHeatEvictionSweepForAgent(supabase, AGENT_ID, {}, fetchFn)).rejects.toThrow(
      'leaves query failed',
    );
  });

  test('fetchFn called with supabase + agentId', async () => {
    const fetchFn = makeFetch({ rows: [], anchoredEpochs: new Set() });
    await runHeatEvictionSweepForAgent(supabase, AGENT_ID, {}, fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(supabase, AGENT_ID);
  });

  test('opts passed through to runHeatEvictionSweep (evictionLimit respected)', async () => {
    // Three cold leaves: all candidates; limit=1 should return only one
    const rows = [makeRow(1, 1, 90, 1), makeRow(2, 1, 80, 1), makeRow(3, 1, 70, 1)];
    const fetchFn = makeFetch({ rows, anchoredEpochs: new Set() });
    const report = await runHeatEvictionSweepForAgent(supabase, AGENT_ID, { evictionLimit: 1 }, fetchFn);
    expect(report.evictionCandidates).toHaveLength(1);
  });
});
