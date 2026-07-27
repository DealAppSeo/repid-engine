/**
 * P3 — EAS-anchor the proof-carrying memory root. Tests the mapping, the anchor path
 * (chain write injected), verification (match fn injected), and off-peak batching.
 * No chain / no DB — the injected fns stand in for the real EAS rail.
 */
import {
  buildMemoryRootAttest, anchorMemoryRoot, verifyMemoryRootAnchor,
  isOffPeakHour, selectOffPeakBatch, MEMORY_ROOT_PROOF_TYPE,
  type MemoryRootAnchorParams, type AttestFn, type MatchFn,
} from '../src/memory/memory-root-anchor';

const ROOT = '0x' + 'ab'.repeat(32); // valid 0x+64hex
const params: MemoryRootAnchorParams = { agentId: 'agent-1', tier: 'ESTABLISHED', root: ROOT, epoch: 7, repidSnapshot: 1200 };

describe('memory-root-anchor — mapping onto the existing EAS schema', () => {
  it('maps a memory root to the proof schema with PCR_MEMORY_ROOT proofType', () => {
    const a = buildMemoryRootAttest(params);
    expect(a.proofType).toBe(MEMORY_ROOT_PROOF_TYPE);
    expect(a.merkleRoot).toBe(ROOT);
    expect(a.proofId).toBe(7);
    expect(a.agentId).toBe('agent-1');
    expect(a.tier).toBe('ESTABLISHED');
  });
});

describe('memory-root-anchor — anchor path (chain write injected)', () => {
  it('anchors a valid root via the injected attest fn', async () => {
    const attest: AttestFn = async (input) => {
      expect(input.proofType).toBe(MEMORY_ROOT_PROOF_TYPE);
      return { uid: '0xUID', txHash: '0xTX' };
    };
    const r = await anchorMemoryRoot(params, attest);
    expect(r.anchored).toBe(true);
    expect(r.uid).toBe('0xUID');
    expect(r.txHash).toBe('0xTX');
  });

  it('rejects a malformed root without calling the chain', async () => {
    let called = false;
    const attest: AttestFn = async () => { called = true; return { uid: '0xUID', txHash: '0xTX' }; };
    const r = await anchorMemoryRoot({ ...params, root: '0xnothex' }, attest);
    expect(r.anchored).toBe(false);
    expect(r.error).toMatch(/invalid memory root/);
    expect(called).toBe(false); // never hit the chain on bad input
  });

  it('surfaces an attester error (e.g. missing key) as not-anchored', async () => {
    const attest: AttestFn = async () => ({ uid: null, txHash: null, error: 'attester key missing' });
    const r = await anchorMemoryRoot(params, attest);
    expect(r.anchored).toBe(false);
    expect(r.error).toBe('attester key missing');
  });
});

describe('memory-root-anchor — read-only verification (match fn injected)', () => {
  it('passes through an on-chain match verdict', async () => {
    const matchFn: MatchFn = async (row) => {
      expect(row.merkle_root).toBe(ROOT);
      expect(row.eas_attestation_uid).toBe('0xUID');
      return { match: true, details: 'PAYLOAD_MATCH', explorer: 'https://base-sepolia.easscan.org/attestation/view/0xUID' };
    };
    const v = await verifyMemoryRootAnchor('0xUID', ROOT, 'agent-1', 'ESTABLISHED', matchFn);
    expect(v.match).toBe(true);
  });

  it('reports a mismatch (wrong root on-chain)', async () => {
    const matchFn: MatchFn = async () => ({ match: false, details: 'MISMATCH' });
    const v = await verifyMemoryRootAnchor('0xUID', ROOT, 'agent-1', 'ESTABLISHED', matchFn);
    expect(v.match).toBe(false);
  });
});

describe('memory-root-anchor — off-peak batching (SCHEDULE axis)', () => {
  it('isOffPeakHour: inside the busy window is NOT off-peak; outside IS', () => {
    expect(isOffPeakHour(15)).toBe(false); // 13..23 busy
    expect(isOffPeakHour(3)).toBe(true);
    expect(isOffPeakHour(23)).toBe(true); // boundary is exclusive-end
  });

  it('selectOffPeakBatch: nothing when on-peak, capped batch when off-peak', () => {
    const pending = Array.from({ length: 25 }, (_, i) => ({ ...params, epoch: i }));
    expect(selectOffPeakBatch(pending, false).length).toBe(0);
    expect(selectOffPeakBatch(pending, true, 10).length).toBe(10);
    expect(selectOffPeakBatch(pending, true, 100).length).toBe(25);
  });
});
