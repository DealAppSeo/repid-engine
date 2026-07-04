/**
 * Tests for the EAS Anchor Worker (feat/cc-2026-07-04-eas-anchor-worker).
 *
 * Fully mocked: no network (EAS client is a stub), no DB (pgQuery + audit sink
 * are injected fns). Covers batch selection, merkle-root construction (via the
 * reused src/zkp/merkle-root builder), uid writeback, the key-missing DEGRADE
 * path, the deferred (attest-failed) path, and the backfill estimate/drain loop.
 */

import { EasAnchorWorker, EAS_ANCHOR_SCHEMA_LABEL } from '../src/workers/eas-anchor-worker';
import type { UnanchoredProofRow, EasClient, BatchAuditSink } from '../src/workers/eas-anchor-worker';
import { rootFromCommitments } from '../src/zkp/merkle-root';

function proof(id: number, commitment: string): UnanchoredProofRow {
  return { id, agent_id: `agent-${id}`, tier_proven: 'ESTABLISHED', zk_commitment: commitment };
}

/** Mock pgQuery driven by a per-test script keyed on SQL fragments. */
function makePgMock(script: {
  count?: number;
  selectBatches?: UnanchoredProofRow[][]; // successive selectBatch() results
  writebackCount?: (ids: number[]) => number;
}) {
  let selectCall = 0;
  const calls: { text: string; params: any[] }[] = [];
  const fn = (async (text: string, params: any[] = []) => {
    calls.push({ text, params });
    if (/count\(\*\)/i.test(text)) return [{ n: String(script.count ?? 0) }];
    if (/UPDATE repid_zkp_proofs/i.test(text)) {
      const ids: number[] = params[2] ?? [];
      const n = script.writebackCount ? script.writebackCount(ids) : ids.length;
      return ids.slice(0, n).map((id) => ({ id }));
    }
    if (/SELECT id, agent_id, tier_proven, zk_commitment/i.test(text)) {
      const batch = script.selectBatches?.[selectCall] ?? [];
      selectCall++;
      return batch;
    }
    return [];
  }) as any;
  fn.calls = calls;
  return fn;
}

function makeEas(opts: {
  hasKey: boolean;
  result?: { uid: string | null; txHash: string | null; error?: string };
}): EasClient & { attestCalls: any[] } {
  const attestCalls: any[] = [];
  return {
    attestCalls,
    hasAttesterKey: () => opts.hasKey,
    attestProof: async (input) => {
      attestCalls.push(input);
      return opts.result ?? { uid: '0xUID', txHash: '0xTX' };
    },
  };
}

function makeAudit(): BatchAuditSink & { rows: any[] } {
  const rows: any[] = [];
  return {
    rows,
    async insertBatchRow(row) {
      rows.push(row);
      return { error: null };
    },
  };
}

describe('EasAnchorWorker.buildBatchRoot', () => {
  it('reproduces the reused merkle-root builder output (keccak256)', () => {
    const rows = [proof(1, 'c-a'), proof(2, 'c-b'), proof(3, 'c-c')];
    const w = new EasAnchorWorker({ easClient: makeEas({ hasKey: true }), auditSink: makeAudit() });
    const { root, scheme } = w.buildBatchRoot(rows);
    const expected = rootFromCommitments(['c-a', 'c-b', 'c-c'], 'keccak256');
    expect(root).toBe(expected.root);
    expect(scheme).toBe('keccak256');
    expect(root).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic and order-sensitive', () => {
    const w = new EasAnchorWorker({ easClient: makeEas({ hasKey: true }), auditSink: makeAudit() });
    const r1 = w.buildBatchRoot([proof(1, 'x'), proof(2, 'y')]);
    const r2 = w.buildBatchRoot([proof(1, 'x'), proof(2, 'y')]);
    const r3 = w.buildBatchRoot([proof(2, 'y'), proof(1, 'x')]);
    expect(r1.root).toBe(r2.root);
    expect(r1.root).not.toBe(r3.root);
  });
});

describe('EasAnchorWorker.runBatch — key missing → DEGRADE loud, no-op', () => {
  it('returns degraded, never attests, never writes back', async () => {
    const eas = makeEas({ hasKey: false });
    const audit = makeAudit();
    const pg = makePgMock({ selectBatches: [[proof(1, 'c')]] });
    const w = new EasAnchorWorker({ easClient: eas, auditSink: audit, pgQueryImpl: pg });
    const r = await w.runBatch();
    expect(r.status).toBe('degraded');
    expect(r.reason).toMatch(/attester key missing/i);
    expect(eas.attestCalls.length).toBe(0);
    expect(audit.rows.length).toBe(0);
  });
});

describe('EasAnchorWorker.runBatch — no un-anchored work', () => {
  it('returns no_work when the batch select is empty', async () => {
    const w = new EasAnchorWorker({
      easClient: makeEas({ hasKey: true }),
      auditSink: makeAudit(),
      pgQueryImpl: makePgMock({ selectBatches: [[]] }),
    });
    const r = await w.runBatch();
    expect(r.status).toBe('no_work');
    expect(r.batchCount).toBe(0);
  });
});

describe('EasAnchorWorker.runBatch — success path', () => {
  it('attests the merkle root, writes uid back to all rows, and audits the batch', async () => {
    const rows = [proof(10, 'c10'), proof(11, 'c11'), proof(12, 'c12')];
    const eas = makeEas({ hasKey: true, result: { uid: '0xABCUID', txHash: '0xTXHASH' } });
    const audit = makeAudit();
    const pg = makePgMock({ selectBatches: [rows] });
    const w = new EasAnchorWorker({ easClient: eas, auditSink: audit, pgQueryImpl: pg });

    const r = await w.runBatch();

    expect(r.status).toBe('anchored');
    expect(r.batchCount).toBe(3);
    expect(r.easUid).toBe('0xABCUID');
    expect(r.txHash).toBe('0xTXHASH');
    expect(r.proofIdMin).toBe(10);
    expect(r.proofIdMax).toBe(12);
    expect(r.rowsWrittenBack).toBe(3);

    // Attested exactly once, with the reused-builder root.
    expect(eas.attestCalls.length).toBe(1);
    const expectedRoot = rootFromCommitments(['c10', 'c11', 'c12'], 'keccak256').root;
    expect(eas.attestCalls[0].merkleRoot).toBe(expectedRoot);
    expect(eas.attestCalls[0].proofId).toBe(10);

    // Writeback UPDATE ran with the batch ids + the uid + the schema label.
    const upd = pg.calls.find((c: any) => /UPDATE repid_zkp_proofs/i.test(c.text));
    expect(upd).toBeTruthy();
    expect(upd.params[0]).toBe('0xABCUID');
    expect(upd.params[1]).toBe(EAS_ANCHOR_SCHEMA_LABEL);
    expect(upd.params[2]).toEqual([10, 11, 12]);

    // One audit row, status anchored, exact id range + ids recorded.
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]).toMatchObject({
      merkle_root: expectedRoot, hash_scheme: 'keccak256', eas_uid: '0xABCUID',
      tx_hash: '0xTXHASH', proof_id_min: 10, proof_id_max: 12, proof_count: 3,
      proof_ids: [10, 11, 12], status: 'anchored',
    });
  });
});

describe('EasAnchorWorker.runBatch — attest yields no uid → deferred, no writeback', () => {
  it('audits the failed attempt and leaves rows un-anchored', async () => {
    const rows = [proof(20, 'c20')];
    const eas = makeEas({ hasKey: true, result: { uid: null, txHash: null, error: 'broadcast failed' } });
    const audit = makeAudit();
    const pg = makePgMock({ selectBatches: [rows] });
    const w = new EasAnchorWorker({ easClient: eas, auditSink: audit, pgQueryImpl: pg });

    const r = await w.runBatch();
    expect(r.status).toBe('deferred');
    expect(r.reason).toMatch(/broadcast failed/);
    expect(r.rowsWrittenBack).toBe(0);
    // No writeback UPDATE ran.
    expect(pg.calls.some((c: any) => /UPDATE repid_zkp_proofs/i.test(c.text))).toBe(false);
    // Audit row records the failure.
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].status).toBe('failed');
    expect(audit.rows[0].eas_uid).toBeNull();
  });
});

describe('EasAnchorWorker.backfill', () => {
  it('logs an estimate and no-ops (returns degraded reason) when key is missing', async () => {
    const eas = makeEas({ hasKey: false });
    const pg = makePgMock({ count: 250, selectBatches: [] });
    const w = new EasAnchorWorker({ easClient: eas, auditSink: makeAudit(), pgQueryImpl: pg, batchSize: 100 });
    const res = await w.backfill();
    expect(res.batchesRun).toBe(0);
    expect(res.proofsAnchored).toBe(0);
    expect(res.stoppedReason).toMatch(/no attester key/i);
    // Estimate came from the count query.
    expect(pg.calls.some((c: any) => /count\(\*\)/i.test(c.text))).toBe(true);
  });

  it('drains successive batches until no_work when key present', async () => {
    const b1 = [proof(1, 'a'), proof(2, 'b')];
    const b2 = [proof(3, 'c')];
    const eas = makeEas({ hasKey: true, result: { uid: '0xU', txHash: '0xT' } });
    const audit = makeAudit();
    const pg = makePgMock({ count: 3, selectBatches: [b1, b2, []] });
    const w = new EasAnchorWorker({ easClient: eas, auditSink: audit, pgQueryImpl: pg, batchSize: 2 });

    const res = await w.backfill();
    expect(res.stoppedReason).toBe('drained');
    expect(res.batchesRun).toBe(2);
    expect(res.proofsAnchored).toBe(3); // 2 + 1 rows written back
    expect(audit.rows.length).toBe(2);
    expect(eas.attestCalls.length).toBe(2);
  });

  it('respects maxBatches', async () => {
    const eas = makeEas({ hasKey: true, result: { uid: '0xU', txHash: '0xT' } });
    const pg = makePgMock({
      count: 10,
      selectBatches: [[proof(1, 'a')], [proof(2, 'b')], [proof(3, 'c')]],
    });
    const w = new EasAnchorWorker({ easClient: eas, auditSink: makeAudit(), pgQueryImpl: pg, batchSize: 1 });
    const res = await w.backfill({ maxBatches: 2 });
    expect(res.batchesRun).toBe(2);
    expect(res.stoppedReason).toMatch(/maxBatches/);
  });

  it('stops on a deferred batch rather than spinning forever', async () => {
    const eas = makeEas({ hasKey: true, result: { uid: null, txHash: null, error: 'no gas' } });
    const pg = makePgMock({ count: 5, selectBatches: [[proof(1, 'a')]] });
    const w = new EasAnchorWorker({ easClient: eas, auditSink: makeAudit(), pgQueryImpl: pg, batchSize: 1 });
    const res = await w.backfill();
    expect(res.batchesRun).toBe(0);
    expect(res.stoppedReason).toMatch(/deferred/);
  });
});
