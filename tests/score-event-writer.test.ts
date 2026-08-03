/**
 * insertScoreEvent — making the invisible contract impossible to get wrong.
 *
 * `trg_apply_repid_score_event` applies every delta unless the inserting code
 * pre-sets `repid_delta_applied`. Omitting one field silently changes WHO applies
 * the score, and nothing at a call site says so. Three of eleven writers got it
 * right by luck of style.
 *
 * So the helper has no default for `applier`. A default would recreate the bug —
 * the whole failure mode is that absence means something.
 */

const inserted: Array<Record<string, unknown>> = [];
let insertError: { message: string } | null = null;

jest.mock('../src/db', () => ({
  db: {
    from: () => {
      const q: any = {};
      q.insert = (row: Record<string, unknown>) => {
        inserted.push(row);
        return q;
      };
      q.select = () => q;
      q.single = async () =>
        insertError ? { data: null, error: insertError } : { data: { id: 'evt-1' }, error: null };
      return q;
    },
  },
}));

import { insertScoreEvent, reconciles } from '../src/scoring/score-event-writer';

beforeEach(() => {
  inserted.length = 0;
  insertError = null;
});

describe("applier: 'trigger' — the DB applies", () => {
  it('OMITS repid_delta_applied, which is what lets the trigger act', () => {
    // This is the whole mechanism. If the field appeared, the trigger would stand
    // down and nothing would apply the delta at all.
    return insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'SERVICE_FULFILLED',
      delta: 10,
    }).then(() => {
      expect(inserted).toHaveLength(1);
      expect('repid_delta_applied' in inserted[0]!).toBe(false);
      expect('repid_before' in inserted[0]!).toBe(false);
      expect('repid_after' in inserted[0]!).toBe(false);
    });
  });

  it('still records the delta and metadata', async () => {
    await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'STAKE',
      delta: 5,
      metadata: { note: 'x' },
      idempotency_key: 'k1',
    });
    expect(inserted[0]!.delta).toBe(5);
    expect(inserted[0]!.metadata).toEqual({ note: 'x' });
    expect(inserted[0]!.idempotency_key).toBe('k1');
  });
});

describe("applier: 'caller' — the caller already applied", () => {
  it('SETS repid_delta_applied so the trigger stands down', async () => {
    await insertScoreEvent({
      applier: 'caller',
      agent_id: 'a1',
      event_type: 'HAL_SCORE_EVENT',
      delta: -9,
      repid_before: 1268,
      repid_after: 1259,
      repid_delta_applied: -9,
    });
    expect(inserted[0]!.repid_delta_applied).toBe(-9);
    expect(inserted[0]!.repid_before).toBe(1268);
    expect(inserted[0]!.repid_after).toBe(1259);
  });
});

describe('the reconciliation invariant — the one that caught the decay defect', () => {
  it('accepts a row whose numbers add up', () => {
    expect(
      reconciles({
        applier: 'caller',
        agent_id: 'a',
        event_type: 'X',
        delta: -9,
        repid_before: 1268,
        repid_after: 1259,
        repid_delta_applied: -9,
      }),
    ).toBe(true);
  });

  it('REFUSES the exact shape decay enforce would have produced', async () => {
    // #315 in enforce mode: decay removes 25, the delta is -9, and
    // repid_delta_applied carries only the delta. The audit row would have shown
    // -9 beside a 34-point drop, and agent_repid_history would have disagreed too.
    const r = await insertScoreEvent({
      applier: 'caller',
      agent_id: 'a1',
      event_type: 'HAL_SCORE_EVENT',
      delta: -9,
      repid_before: 1268,
      repid_after: 1234, // decay -25 then delta -9
      repid_delta_applied: -9, // ← only the delta
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not reconcile/);
    expect(r.error).toMatch(/decay/);
    // And critically: nothing was written.
    expect(inserted).toHaveLength(0);
  });

  it('writes nothing at all when it refuses — a non-adding ledger is worse than a gap', async () => {
    await insertScoreEvent({
      applier: 'caller',
      agent_id: 'a1',
      event_type: 'X',
      delta: 5,
      repid_before: 100,
      repid_after: 200,
      repid_delta_applied: 5,
    });
    expect(inserted).toHaveLength(0);
  });

  it('accepts a zero-delta no-op that reconciles', async () => {
    const r = await insertScoreEvent({
      applier: 'caller',
      agent_id: 'a1',
      event_type: 'X',
      delta: 0,
      repid_before: 500,
      repid_after: 500,
      repid_delta_applied: 0,
    });
    expect(r.ok).toBe(true);
  });
});

describe('failure reporting', () => {
  it('surfaces a DB error rather than claiming success', async () => {
    insertError = { message: 'duplicate key value violates unique constraint' };
    const r = await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'X',
      delta: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/duplicate key/);
  });

  it('reports which applier was used, so a caller can assert it', async () => {
    const t = await insertScoreEvent({ applier: 'trigger', agent_id: 'a', event_type: 'X', delta: 1 });
    expect(t.applier).toBe('trigger');
    const c = await insertScoreEvent({
      applier: 'caller',
      agent_id: 'a',
      event_type: 'X',
      delta: 1,
      repid_before: 10,
      repid_after: 11,
      repid_delta_applied: 1,
    });
    expect(c.applier).toBe('caller');
  });
});
