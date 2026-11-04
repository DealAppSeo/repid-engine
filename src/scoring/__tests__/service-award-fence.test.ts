/**
 * service-award-fence.test.ts — a SERVICE_* award may move canonical RepID only with a verified-good outcome,
 * established independence, AND an idempotency key; otherwise it demotes to shadow (never refused). Pure policy.
 */
import { fenceServiceAward, type ServiceAwardContext } from '../service-award-fence';

const ctx = (over: Partial<ServiceAwardContext> = {}): ServiceAwardContext => ({
  hal_decision: 'clean', independence: 'independent', idempotency_key: 'idem-1', ...over,
});

describe('fenceServiceAward — gate canonical RepID movement for SERVICE_* awards', () => {
  it('allows canonical only when verified-good AND independent AND idempotent', () => {
    const d = fenceServiceAward(ctx());
    expect(d.canonical).toBe(true);
    expect(d.reasons).toEqual([]);
  });

  it("today's SERVICE_FULFILLED (clean verdict, independence unknown, no idempotency) DEMOTES", () => {
    const d = fenceServiceAward(ctx({ independence: 'unknown', idempotency_key: null }));
    expect(d.canonical).toBe(false);
    expect(d.reasons).toEqual(expect.arrayContaining(['independence_not_established:unknown', 'no_idempotency_key']));
  });

  it('demotes an unverified outcome (abstain / none / vetoed / flagged — self-report or veto is not competence)', () => {
    for (const hal of ['abstain', null, 'vetoed', 'flagged'] as const) {
      const d = fenceServiceAward(ctx({ hal_decision: hal }));
      expect(d.canonical).toBe(false);
      expect(d.reasons).toContain(`unverified_outcome:${hal ?? 'none'}`);
    }
  });

  it('demotes a same-owner award (Sybil: same controller on both sides)', () => {
    const d = fenceServiceAward(ctx({ independence: 'same_owner' }));
    expect(d.canonical).toBe(false);
    expect(d.reasons).toContain('independence_not_established:same_owner');
  });

  it('demotes an award with no idempotency key (replayable)', () => {
    const d = fenceServiceAward(ctx({ idempotency_key: null }));
    expect(d.canonical).toBe(false);
    expect(d.reasons).toContain('no_idempotency_key');
  });

  it('leaves an already-shadow award shadow (nothing to demote)', () => {
    const d = fenceServiceAward(ctx({ already_shadow: true }));
    expect(d.canonical).toBe(false);
    expect(d.reasons).toEqual(['already_shadow']);
  });

  it('reports every failing reason at once', () => {
    const d = fenceServiceAward({ hal_decision: null, independence: 'same_owner', idempotency_key: null });
    expect(d.reasons).toEqual(expect.arrayContaining(['unverified_outcome:none', 'independence_not_established:same_owner', 'no_idempotency_key']));
  });
});
