/**
 * The zero-delta trap in `insertScoreEvent({ applier: 'trigger' })`.
 *
 * `applier: 'trigger'` was a guaranteed `23502` for every zero-delta event, and
 * zero-delta is the MAJORITY class of this ledger (79,842 of 152,084 rows, 52.5%,
 * most recent today). Verified live 2026-08-03 against `pg_proc` /
 * `information_schema`, then probed inside an aborted transaction so no row was
 * left behind:
 *
 *   A  delta 0,                          applier trigger  → FAIL 23502
 *   B  delta 0 + repid_before/after,     applier trigger  → OK, agent 501 → 501
 *   C  delta 3,                          applier trigger  → OK, before 501 after 504 applied 3
 *
 * The trigger source is the decisive artifact, so this suite does not mock a
 * vaguely-DB-shaped object — `applyTriggerAndConstraints()` below is a transcription
 * of `apply_repid_score_event()` as `pg_get_functiondef` returned it, plus the two
 * NOT NULL columns. If the real trigger changes, this fake is what needs updating.
 */

/** The live agent score the fake DB starts from — probe A/B/C used a real 501. */
const START_SCORE = 501;

let agentScore = START_SCORE;
let agentMissing = false;
let readError: { message: string } | null = null;

/** Rows that actually survived the trigger + NOT NULL constraints. */
const committed: Array<Record<string, unknown>> = [];
/** Every row the helper handed the DB, survivor or not. */
const attempted: Array<Record<string, unknown>> = [];

class PgError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Transcription of `apply_repid_score_event()` (BEFORE INSERT on
 * repid_score_events) followed by the `repid_before` / `repid_after` NOT NULL
 * checks. Mutates `agentScore` exactly where the real trigger UPDATEs
 * `repid_agents`, so a test can assert that a score did NOT move.
 */
function applyTriggerAndConstraints(row: Record<string, unknown>): Record<string, unknown> {
  const NEW = { ...row };

  //   IF NEW.repid_delta_applied IS NOT NULL THEN RETURN NEW; END IF;
  const alreadyApplied = NEW['repid_delta_applied'];
  const standDown = alreadyApplied !== undefined && alreadyApplied !== null;

  if (!standDown) {
    //   v_delta := COALESCE(NEW.repid_delta_calculated, NEW.delta, 0);
    const calc = NEW['repid_delta_calculated'];
    const vDelta =
      calc !== undefined && calc !== null ? Number(calc) : Number(NEW['delta'] ?? 0);

    //   IF v_delta = 0 THEN RETURN NEW; END IF;   ← stamps NOTHING
    if (vDelta !== 0) {
      const before = agentScore;
      agentScore = before + vDelta; // UPDATE repid_agents SET current_repid = ...
      NEW['repid_before'] = before;
      NEW['repid_after'] = agentScore;
      NEW['repid_delta_applied'] = vDelta;
    }
  }

  // repid_before / repid_after are integer NOT NULL with NO default.
  for (const col of ['repid_before', 'repid_after']) {
    const v = NEW[col];
    if (v === undefined || v === null) {
      throw new PgError(
        '23502',
        `null value in column "${col}" of relation "repid_score_events" violates not-null constraint`,
      );
    }
  }

  return NEW;
}

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const q: any = {};

      if (table === 'repid_agents') {
        q.select = () => q;
        q.eq = () => q;
        q.single = async () => {
          if (readError) return { data: null, error: readError };
          if (agentMissing) return { data: null, error: null };
          return { data: { current_repid: agentScore }, error: null };
        };
        return q;
      }

      let pending: Record<string, unknown> = {};
      q.insert = (row: Record<string, unknown>) => {
        pending = row;
        attempted.push(row);
        return q;
      };
      q.select = () => q;
      q.single = async () => {
        try {
          const stamped = applyTriggerAndConstraints(pending);
          committed.push(stamped);
          return { data: { id: 'evt-1' }, error: null };
        } catch (err) {
          const e = err as PgError;
          return { data: null, error: { message: e.message, code: e.code } };
        }
      };
      return q;
    },
  },
}));

import { insertScoreEvent, effectiveTriggerDelta } from '../src/scoring/score-event-writer';

beforeEach(() => {
  agentScore = START_SCORE;
  agentMissing = false;
  readError = null;
  committed.length = 0;
  attempted.length = 0;
});

/** The row shape the helper built BEFORE the fix: no before/after/applied at all. */
function legacyTriggerRow(delta: number): Record<string, unknown> {
  return { agent_id: 'a1', event_type: 'SELF_MONITOR', delta, metadata: {} };
}

describe('the bug: zero-delta + applier trigger was a guaranteed 23502', () => {
  it('REPRODUCES it — the pre-fix row shape dies on repid_before NOT NULL', () => {
    // This is the failure the WRITERS lane probed live, reproduced against a
    // transcription of the real trigger. No row, no rollback needed.
    expect(() => applyTriggerAndConstraints(legacyTriggerRow(0))).toThrow(
      /null value in column "repid_before"/,
    );
    try {
      applyTriggerAndConstraints(legacyTriggerRow(0));
    } catch (err) {
      expect((err as PgError).code).toBe('23502');
    }
  });

  it('and the same shape with a NON-zero delta was always fine — so the delta is the trigger', () => {
    const stamped = applyTriggerAndConstraints(legacyTriggerRow(3));
    expect(stamped['repid_before']).toBe(501);
    expect(stamped['repid_after']).toBe(504);
    expect(stamped['repid_delta_applied']).toBe(3);
  });

  it('FIXED: the helper now writes a zero-delta event successfully', async () => {
    const r = await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'SELF_MONITOR',
      delta: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(committed).toHaveLength(1);
  });

  it('stamps a snapshot that reconciles: before == after, applied == 0', async () => {
    await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'SELF_MONITOR',
      delta: 0,
    });
    const row = committed[0]!;
    expect(row['repid_before']).toBe(501);
    expect(row['repid_after']).toBe(501);
    expect(row['repid_delta_applied']).toBe(0);
    expect(Number(row['repid_after']) - Number(row['repid_before'])).toBe(0);
  });

  it('does NOT move the score — this is why the change needs no flag', async () => {
    await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'SELF_MONITOR',
      delta: 0,
    });
    // repid_delta_applied is non-NULL, so the trigger stands down at its FIRST
    // guard and never reaches the UPDATE. Probe B saw the same: 501 → 501.
    expect(agentScore).toBe(START_SCORE);
  });
});

describe("the precedence trap: COALESCE(repid_delta_calculated, delta)", () => {
  it('treats delta 5 + repid_delta_calculated 0 as ZERO, because the trigger does', () => {
    // Probed live: this shape also returned 23502, even though `delta` is 5.
    expect(
      effectiveTriggerDelta({
        applier: 'trigger',
        agent_id: 'a1',
        event_type: 'SELF_MONITOR',
        delta: 5,
        extra: { repid_delta_calculated: 0 },
      }),
    ).toBe(0);
  });

  it('and writes it successfully instead of dying', async () => {
    const r = await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'SELF_MONITOR',
      delta: 5,
      extra: { repid_delta_calculated: 0 },
    });
    expect(r.ok).toBe(true);
    expect(committed[0]!['repid_before']).toBe(501);
    expect(agentScore).toBe(START_SCORE);
  });

  it('does not mistake a non-zero calculated delta for zero', () => {
    expect(
      effectiveTriggerDelta({
        applier: 'trigger',
        agent_id: 'a1',
        event_type: 'SELF_MONITOR',
        delta: 0,
        extra: { repid_delta_calculated: -9 },
      }),
    ).toBe(-9);
  });
});

describe('the non-zero path is unchanged — byte for byte', () => {
  it('still OMITS before/after/applied, which is what lets the trigger act', async () => {
    await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'SERVICE_FULFILLED',
      delta: 10,
    });
    const row = attempted[0]!;
    expect('repid_before' in row).toBe(false);
    expect('repid_after' in row).toBe(false);
    expect('repid_delta_applied' in row).toBe(false);
  });

  it('builds exactly the same key set the pre-fix helper built', async () => {
    await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'STAKE',
      delta: 5,
      metadata: { note: 'x' },
      idempotency_key: 'k1',
    });
    expect(Object.keys(attempted[0]!).sort()).toEqual(
      ['agent_id', 'delta', 'event_type', 'idempotency_key', 'metadata'].sort(),
    );
  });

  it('and the trigger still applies it, moving the score', async () => {
    await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'SERVICE_FULFILLED',
      delta: 10,
    });
    expect(agentScore).toBe(511);
    expect(committed[0]!['repid_delta_applied']).toBe(10);
  });

  it('leaves applier: caller alone entirely, including its zero-delta case', async () => {
    const r = await insertScoreEvent({
      applier: 'caller',
      agent_id: 'a1',
      event_type: 'HAL_SCORE_EVENT',
      delta: 0,
      repid_before: 500,
      repid_after: 500,
      repid_delta_applied: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.applier).toBe('caller');
    expect(agentScore).toBe(START_SCORE);
  });
});

describe('it refuses rather than writing a row that does not add up', () => {
  it('rejects a zero-delta event whose supplied before/after differ', async () => {
    const r = await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'SELF_MONITOR',
      delta: 0,
      extra: { repid_before: 500, repid_after: 490 },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not reconcile/);
    expect(attempted).toHaveLength(0);
  });

  it('respects a supplied snapshot that DOES add up, without re-reading', async () => {
    const r = await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'SELF_MONITOR',
      delta: 0,
      extra: { repid_before: 1268, repid_after: 1268 },
    });
    expect(r.ok).toBe(true);
    expect(committed[0]!['repid_before']).toBe(1268);
    expect(committed[0]!['repid_delta_applied']).toBe(0);
  });
});

describe('when the snapshot cannot be read, it says why', () => {
  it('reports the read failure, not a misleading 23502', async () => {
    readError = { message: 'connection terminated' };
    const r = await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'a1',
      event_type: 'SELF_MONITOR',
      delta: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/connection terminated/);
    expect(r.error).toMatch(/repid_before is NOT NULL/);
    // And it did not fire a doomed insert.
    expect(attempted).toHaveLength(0);
  });

  it('names the agent when there is no such agent', async () => {
    agentMissing = true;
    const r = await insertScoreEvent({
      applier: 'trigger',
      agent_id: 'ghost-agent',
      event_type: 'SELF_MONITOR',
      delta: 0,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ghost-agent/);
    expect(attempted).toHaveLength(0);
  });
});
