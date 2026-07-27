import {
  HitlReconcileMode,
  ReconcileCandidate,
  STRANDING_HITL_STATUSES,
  classifyHitlQueueRow,
  parseHitlReconcileMode,
  reconcileExpiredHitlRows,
} from '../src/services/hitl-reconciliation';

describe('parseHitlReconcileMode', () => {
  it('defaults to shadow for undefined/null/empty/unknown', () => {
    for (const v of [undefined, null, '', '   ', 'bogus', 'SHADOW']) {
      expect(parseHitlReconcileMode(v as any)).toBe('shadow');
    }
  });
  it('parses off / enforce case-insensitively with trimming', () => {
    expect(parseHitlReconcileMode('off')).toBe('off');
    expect(parseHitlReconcileMode(' OFF ')).toBe('off');
    expect(parseHitlReconcileMode('enforce')).toBe('enforce');
    expect(parseHitlReconcileMode(' Enforce ')).toBe('enforce');
  });
});

describe('classifyHitlQueueRow', () => {
  it('reconciles a processing row whose hitl request is expired', () => {
    const d = classifyHitlQueueRow({ queueStatus: 'processing', hitlStatus: 'expired', alreadyFinalized: false });
    expect(d.reconcile).toBe(true);
    expect(d.toStatus).toBe('skipped');
    expect(d.reason).toContain('expired');
  });

  it('reconciles a processing row whose hitl request is cancelled', () => {
    const d = classifyHitlQueueRow({ queueStatus: 'processing', hitlStatus: 'cancelled', alreadyFinalized: false });
    expect(d.reconcile).toBe(true);
  });

  it('LEAVES a still-live pending request (the real new item must survive)', () => {
    const d = classifyHitlQueueRow({ queueStatus: 'processing', hitlStatus: 'pending', alreadyFinalized: false });
    expect(d.reconcile).toBe(false);
    expect(d.reason).toContain('pending');
  });

  it('LEAVES assigned/reviewing (still in a human review lifecycle)', () => {
    expect(classifyHitlQueueRow({ queueStatus: 'processing', hitlStatus: 'assigned', alreadyFinalized: false }).reconcile).toBe(false);
    expect(classifyHitlQueueRow({ queueStatus: 'processing', hitlStatus: 'reviewing', alreadyFinalized: false }).reconcile).toBe(false);
  });

  it('LEAVES a resolved request (worker finalize path owns it — must apply verdict, not skip)', () => {
    const d = classifyHitlQueueRow({ queueStatus: 'processing', hitlStatus: 'resolved', alreadyFinalized: false });
    expect(d.reconcile).toBe(false);
    expect(STRANDING_HITL_STATUSES).not.toContain('resolved' as any);
  });

  it('LEAVES a row already finalized by the worker', () => {
    const d = classifyHitlQueueRow({ queueStatus: 'processing', hitlStatus: 'expired', alreadyFinalized: true });
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('already-finalized');
  });

  it('LEAVES a non-processing row untouched', () => {
    expect(classifyHitlQueueRow({ queueStatus: 'completed', hitlStatus: 'expired', alreadyFinalized: false }).reconcile).toBe(false);
    expect(classifyHitlQueueRow({ queueStatus: 'pending', hitlStatus: 'expired', alreadyFinalized: false }).reconcile).toBe(false);
  });

  it('LEAVES a row with a broken/missing hitl link (does not guess)', () => {
    const d = classifyHitlQueueRow({ queueStatus: 'processing', hitlStatus: null, alreadyFinalized: false });
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('no-linked-hitl-request');
  });
});

// A live-shaped fixture: 13 expired + 1 pending (matches 2026-07-26 prod state).
function liveShapedCandidates(): ReconcileCandidate[] {
  const expired: ReconcileCandidate[] = Array.from({ length: 13 }, (_, i) => ({
    id: `vq-exp-${i}`,
    hitlStatus: 'expired',
    alreadyFinalized: false,
  }));
  const pending: ReconcileCandidate = { id: 'vq-pending-434999', hitlStatus: 'pending', alreadyFinalized: false };
  return [...expired, pending];
}

describe('reconcileExpiredHitlRows', () => {
  it('off mode: fetches nothing, mutates nothing', async () => {
    const fetchCandidates = jest.fn(async () => liveShapedCandidates());
    const markSkipped = jest.fn(async () => {});
    const r = await reconcileExpiredHitlRows({ fetchCandidates, markSkipped }, 'off');
    expect(fetchCandidates).not.toHaveBeenCalled();
    expect(markSkipped).not.toHaveBeenCalled();
    expect(r).toMatchObject({ mode: 'off', scanned: 0, reconciled: 0 });
  });

  it('shadow mode: counts would-reconcile but calls markSkipped ZERO times', async () => {
    const fetchCandidates = jest.fn(async () => liveShapedCandidates());
    const markSkipped = jest.fn(async () => {});
    const r = await reconcileExpiredHitlRows({ fetchCandidates, markSkipped, log: () => {} }, 'shadow');
    expect(fetchCandidates).toHaveBeenCalledTimes(1);
    expect(markSkipped).not.toHaveBeenCalled();
    expect(r.scanned).toBe(14);
    expect(r.wouldReconcile).toBe(13);
    expect(r.reconciled).toBe(0);
  });

  it('enforce mode: skips exactly the 13 expired, never the pending', async () => {
    const fetchCandidates = jest.fn(async () => liveShapedCandidates());
    const skippedIds: string[] = [];
    const markSkipped = jest.fn(async (id: string) => {
      skippedIds.push(id);
    });
    const r = await reconcileExpiredHitlRows({ fetchCandidates, markSkipped, log: () => {} }, 'enforce');
    expect(r.reconciled).toBe(13);
    expect(skippedIds).toHaveLength(13);
    expect(skippedIds).not.toContain('vq-pending-434999');
  });

  it('enforce mode: fail-open on fetch error (mutates nothing, does not throw)', async () => {
    const fetchCandidates = jest.fn(async () => {
      throw new Error('boom');
    });
    const markSkipped = jest.fn(async () => {});
    const r = await reconcileExpiredHitlRows({ fetchCandidates, markSkipped, log: () => {} }, 'enforce');
    expect(markSkipped).not.toHaveBeenCalled();
    expect(r.errors).toBe(1);
    expect(r.reconciled).toBe(0);
  });

  it('enforce mode: one mark failure is isolated (counts error, keeps going)', async () => {
    const fetchCandidates = jest.fn(async () => liveShapedCandidates());
    const markSkipped = jest.fn(async (id: string) => {
      if (id === 'vq-exp-0') throw new Error('row race');
    });
    const r = await reconcileExpiredHitlRows({ fetchCandidates, markSkipped, log: () => {} }, 'enforce');
    expect(r.errors).toBe(1);
    expect(r.reconciled).toBe(12); // 13 attempted, 1 failed
  });

  it('respects the batch limit argument passed to fetchCandidates', async () => {
    const fetchCandidates = jest.fn(async (limit: number) => liveShapedCandidates().slice(0, limit));
    const markSkipped = jest.fn(async () => {});
    await reconcileExpiredHitlRows({ fetchCandidates, markSkipped, log: () => {} }, 'shadow', 5);
    expect(fetchCandidates).toHaveBeenCalledWith(5);
  });
});
