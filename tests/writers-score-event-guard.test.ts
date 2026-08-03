/**
 * The guard, behaviourally.
 *
 * `trg_apply_repid_score_event` (live, BEFORE INSERT on repid_score_events,
 * verified via pg_get_functiondef 2026-08-03) applies EVERY delta unless the
 * inserting code pre-sets `repid_delta_applied`, and it re-reads `current_repid`
 * at insert time:
 *
 *     IF NEW.repid_delta_applied IS NOT NULL THEN RETURN NEW; END IF;
 *     IF v_delta = 0 THEN RETURN NEW; END IF;
 *     SELECT current_repid INTO v_before FROM repid_agents WHERE id = ... FOR UPDATE;
 *     UPDATE repid_agents SET current_repid = COALESCE(v_before,0) + v_delta ...
 *
 * So a writer that updates current_repid ITSELF and then inserts the event gets
 * the delta applied twice. Measured on prod inside a rolled-back transaction with
 * redteam-adjudication's exact sequence: read 699 → caller wrote 706 → final 713.
 *
 * These tests fail if a writer regresses to the unguarded form — i.e. stops
 * setting repid_delta_applied while still writing current_repid.
 */

const scoreEvents: Array<Record<string, unknown>> = [];
const insertScoreEventCalls: Array<Record<string, unknown>> = [];
const agentScores = new Map<string, number>();

jest.mock('../src/db', () => {
  // Minimal chainable stand-in for the supabase-js builder, with enough state
  // that an UPDATE to current_repid is visible to the following read-back — the
  // property the double-apply depends on.
  const makeAgentQuery = () => {
    const q: any = {
      _name: null as string | null,
      select: () => q,
      eq: (_col: string, val: string) => {
        q._name = val;
        return q;
      },
      maybeSingle: async () => ({
        data: { id: `uuid-${q._name}`, current_repid: agentScores.get(String(q._name)) ?? 100 },
        error: null,
      }),
      single: async () => ({
        data: { id: `uuid-${q._name}`, current_repid: agentScores.get(String(q._name)) ?? 100 },
        error: null,
      }),
      update: (payload: any) => {
        q._pendingUpdate = payload;
        return q;
      },
      then: undefined,
    };
    return q;
  };

  return {
    db: {
      from: (table: string) => {
        if (table === 'repid_agents') {
          const q = makeAgentQuery();
          // `await db.from(...).update(...).eq(...)` — eq must both record the
          // agent and commit the pending update.
          const origEq = q.eq;
          q.eq = (col: string, val: string) => {
            origEq(col, val);
            if (q._pendingUpdate && q._pendingUpdate.current_repid !== undefined) {
              agentScores.set(String(val), q._pendingUpdate.current_repid);
              q._pendingUpdate = null;
            }
            return q;
          };
          return q;
        }
        if (table === 'repid_score_events') {
          return {
            insert: async (row: Record<string, unknown>) => {
              scoreEvents.push(row);
              return { data: { id: 1 }, error: null };
            },
          };
        }
        // red_team_results
        return {
          insert: () => ({
            select: () => ({ maybeSingle: async () => ({ data: { id: 7 }, error: null }) }),
          }),
        };
      },
    },
  };
});

jest.mock('../src/scoring/score-event-writer', () => ({
  insertScoreEvent: async (e: Record<string, unknown>) => {
    insertScoreEventCalls.push(e);
    return { ok: true, applier: e.applier, id: '1' };
  },
  reconciles: (e: any) => e.repid_after - e.repid_before === e.repid_delta_applied,
}));

jest.mock('../src/services/onchain-outbox', () => ({
  emitOnChainOutboxEvent: async () => ({ ok: true }),
}));

import { scoreEventGuardMode, scoreEventGuardEnforced } from '../src/routes/score-event-guard';
import { adjudicate, REDTEAM_REWARDS } from '../src/testing/redteam-adjudication';

const ORIGINAL = process.env.SCORE_EVENT_GUARD_MODE;

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.SCORE_EVENT_GUARD_MODE;
  else process.env.SCORE_EVENT_GUARD_MODE = ORIGINAL;
});

beforeEach(() => {
  scoreEvents.length = 0;
  insertScoreEventCalls.length = 0;
  agentScores.clear();
});

describe('SCORE_EVENT_GUARD_MODE resolution', () => {
  it('defaults to off when unset — a missing flag must never mean enforce', () => {
    delete process.env.SCORE_EVENT_GUARD_MODE;
    expect(scoreEventGuardMode()).toBe('off');
    expect(scoreEventGuardEnforced()).toBe(false);
  });

  it('only the exact token enables it — no truthy-string near-misses', () => {
    // The failure mode of guessing is double-counted reputation, so anything
    // that is not literally "enforce" stays off.
    for (const v of ['', 'true', '1', 'on', 'yes', 'enforced', 'shadow', 'garbage']) {
      process.env.SCORE_EVENT_GUARD_MODE = v;
      expect(scoreEventGuardMode()).toBe('off');
    }
  });

  it('accepts enforce case-insensitively and with surrounding whitespace', () => {
    for (const v of ['enforce', 'ENFORCE', ' Enforce ']) {
      process.env.SCORE_EVENT_GUARD_MODE = v;
      expect(scoreEventGuardEnforced()).toBe(true);
    }
  });
});

describe('redteam-adjudication participates in the structural guard', () => {
  it('OFF: writes a raw event with NO repid_delta_applied — the unguarded form', async () => {
    process.env.SCORE_EVENT_GUARD_MODE = 'off';
    agentScores.set('subj', 500);

    await adjudicate({ case: 'lazy_subject', subject: 'subj', challenge_id: 'c-off' } as any);

    expect(insertScoreEventCalls).toHaveLength(0);
    expect(scoreEvents).toHaveLength(1);
    // This is what makes the trigger the applier — documented, not endorsed.
    expect(scoreEvents[0]).not.toHaveProperty('repid_delta_applied');
  });

  it('ENFORCE: routes through insertScoreEvent as the caller-applier', async () => {
    process.env.SCORE_EVENT_GUARD_MODE = 'enforce';
    agentScores.set('subj', 500);

    await adjudicate({ case: 'lazy_subject', subject: 'subj', challenge_id: 'c-on' } as any);

    expect(scoreEvents).toHaveLength(0); // no raw insert survives
    expect(insertScoreEventCalls).toHaveLength(1);
    const call = insertScoreEventCalls[0] as any;
    expect(call.applier).toBe('caller');
    // Presence of this field is the entire double-count guard.
    expect(call.repid_delta_applied).toBeDefined();
    expect(call.repid_delta_applied).not.toBeNull();
  });

  it('ENFORCE: the payload reconciles — after - before === repid_delta_applied', async () => {
    process.env.SCORE_EVENT_GUARD_MODE = 'enforce';
    agentScores.set('subj', 500);

    await adjudicate({ case: 'lazy_subject', subject: 'subj', challenge_id: 'c-rec' } as any);

    const call = insertScoreEventCalls[0] as any;
    expect(call.repid_after - call.repid_before).toBe(call.repid_delta_applied);
    // And it reflects the real movement, not the nominal delta: the subject was
    // penalised, so the applied amount is negative.
    expect(call.repid_delta_applied).toBe(-REDTEAM_REWARDS.SUBJECT_PENALTY);
  });

  it('ENFORCE: repid_delta_applied tracks the ACTUAL movement, not the raw delta', async () => {
    // A floor/clamp between the write and the read-back makes (after - before)
    // smaller than the nominal delta. Quoting the raw delta would produce a row
    // that does not add up, which insertScoreEvent refuses. Simulate by starting
    // the agent low enough that the harness's own Math.max(0, ...) clamps.
    process.env.SCORE_EVENT_GUARD_MODE = 'enforce';
    agentScores.set('subj', 3); // penalty is larger than the balance

    await adjudicate({ case: 'lazy_subject', subject: 'subj', challenge_id: 'c-clamp' } as any);

    const call = insertScoreEventCalls[0] as any;
    expect(call.repid_before).toBe(3);
    expect(call.repid_after).toBe(0); // clamped by Math.max(0, ...)
    expect(call.repid_delta_applied).toBe(-3); // NOT -SUBJECT_PENALTY
    expect(call.repid_after - call.repid_before).toBe(call.repid_delta_applied);
    // The nominal delta is still recorded, separately, for audit.
    expect(call.repid_delta_calculated).toBe(-REDTEAM_REWARDS.SUBJECT_PENALTY);
  });

  it('ENFORCE: both parties in a good_catch are guarded, not just one', async () => {
    process.env.SCORE_EVENT_GUARD_MODE = 'enforce';
    agentScores.set('finder', 800);
    agentScores.set('subj', 800);

    await adjudicate({
      case: 'good_catch',
      finder: 'finder',
      subject: 'subj',
      challenge_id: 'c-both',
    } as any);

    expect(insertScoreEventCalls).toHaveLength(2);
    for (const call of insertScoreEventCalls as any[]) {
      expect(call.applier).toBe('caller');
      expect(call.repid_after - call.repid_before).toBe(call.repid_delta_applied);
    }
  });
});
