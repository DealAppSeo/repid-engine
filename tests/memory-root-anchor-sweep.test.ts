/**
 * The orchestration layer between item 9 (off-peak batching) and item 10 (EAS anchoring) —
 * both primitives untouched, injected fetch/attest/writeback so no live DB or chain is needed.
 */
import { runMemoryRootAnchorSweep, type PendingRootRow } from '../src/memory/memory-root-anchor-sweep';
import type { AttestFn } from '../src/memory/memory-root-anchor';

const ROOT_A = '0x' + 'aa'.repeat(32);
const ROOT_B = '0x' + 'bb'.repeat(32);

const rows: PendingRootRow[] = [
  { id: 1, agentId: 'agent-1', tier: 'ESTABLISHED', root: ROOT_A, epoch: 1, repidSnapshot: 1200 },
  { id: 2, agentId: 'agent-2', tier: 'EARNING', root: ROOT_B, epoch: 3, repidSnapshot: 600 },
];

const PEAK_HOUR = 15; // inside default busy window [13,23)
const OFFPEAK_HOUR = 2;

describe('runMemoryRootAnchorSweep', () => {
  it('anchors and writes back every chosen row when off-peak', async () => {
    const attested: string[] = [];
    const written: Array<{ id: number; uid: string; txHash: string | null }> = [];
    const attestFn: AttestFn = async (input) => {
      attested.push(input.agentId);
      return { uid: `0xUID-${input.agentId}`, txHash: `0xTX-${input.agentId}` };
    };

    const result = await runMemoryRootAnchorSweep({
      fetchPending: async () => rows,
      writeback: async (id, uid, txHash) => { written.push({ id, uid, txHash }); },
      attestFn,
      nowHourUtc: OFFPEAK_HOUR,
    });

    expect(result.isOffPeak).toBe(true);
    expect(result.consideredCount).toBe(2);
    expect(result.chosenCount).toBe(2);
    expect(attested).toEqual(['agent-1', 'agent-2']);
    expect(written).toEqual([
      { id: 1, uid: '0xUID-agent-1', txHash: '0xTX-agent-1' },
      { id: 2, uid: '0xUID-agent-2', txHash: '0xTX-agent-2' },
    ]);
    expect(result.results.every((r) => r.anchored)).toBe(true);
  });

  it('chooses nothing and calls neither attestFn nor writeback during peak hours', async () => {
    let attestCalled = false;
    let writebackCalled = false;

    const result = await runMemoryRootAnchorSweep({
      fetchPending: async () => rows,
      writeback: async () => { writebackCalled = true; },
      attestFn: async () => { attestCalled = true; return { uid: '0xUID', txHash: '0xTX' }; },
      nowHourUtc: PEAK_HOUR,
    });

    expect(result.isOffPeak).toBe(false);
    expect(result.chosenCount).toBe(0);
    expect(result.results).toEqual([]);
    expect(attestCalled).toBe(false);
    expect(writebackCalled).toBe(false);
  });

  it('dryRun reports what would be chosen but never calls attestFn or writeback', async () => {
    let attestCalled = false;
    let writebackCalled = false;

    const result = await runMemoryRootAnchorSweep({
      fetchPending: async () => rows,
      writeback: async () => { writebackCalled = true; },
      attestFn: async () => { attestCalled = true; return { uid: '0xUID', txHash: '0xTX' }; },
      nowHourUtc: OFFPEAK_HOUR,
      dryRun: true,
    });

    expect(result.chosenCount).toBe(2);
    expect(result.results).toEqual([{ id: 1, anchored: false }, { id: 2, anchored: false }]);
    expect(attestCalled).toBe(false);
    expect(writebackCalled).toBe(false);
  });

  it('caps the batch at maxBatch and continues past a single row failure without throwing', async () => {
    const three = [...rows, { id: 3, agentId: 'agent-3', tier: 'ESTABLISHED', root: ROOT_A, epoch: 2, repidSnapshot: null }];
    const written: number[] = [];

    const result = await runMemoryRootAnchorSweep({
      fetchPending: async () => three,
      writeback: async (id) => { written.push(id); },
      attestFn: async (input) => {
        if (input.agentId === 'agent-2') throw new Error('rpc timeout');
        return { uid: `0xUID-${input.agentId}`, txHash: null };
      },
      nowHourUtc: OFFPEAK_HOUR,
      maxBatch: 2,
    });

    expect(result.consideredCount).toBe(3);
    expect(result.chosenCount).toBe(2); // capped, row 3 never considered
    expect(result.results).toEqual([
      { id: 1, anchored: true, uid: '0xUID-agent-1', error: undefined },
      { id: 2, anchored: false, error: 'rpc timeout' },
    ]);
    expect(written).toEqual([1]); // only the row that actually anchored got a writeback
  });

  it('does not write back a row whose anchor attempt did not return a uid', async () => {
    let writebackCalled = false;
    const result = await runMemoryRootAnchorSweep({
      fetchPending: async () => [rows[0]!],
      writeback: async () => { writebackCalled = true; },
      attestFn: async () => ({ uid: null, txHash: null, error: 'no attester wallet' }),
      nowHourUtc: OFFPEAK_HOUR,
    });

    expect(result.results).toEqual([{ id: 1, anchored: false, uid: null, error: 'no attester wallet' }]);
    expect(writebackCalled).toBe(false);
  });
});
