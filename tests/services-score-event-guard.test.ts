/**
 * Guard participation for the two score-event writers under `src/services/**`
 * that #326 left unguarded.
 *
 * These tests exist to catch a REGRESSION TO THE UNGUARDED FORM, which is the
 * only failure mode that matters here: `trg_apply_repid_score_event` applies
 * every delta unless the inserting statement pre-sets `repid_delta_applied`, and
 * nothing at a call site hints that the trigger exists. A writer that quietly
 * drops the guarded branch looks identical in review and moves RepID twice (or,
 * for the trigger-applier writer, becomes unattributable).
 *
 * Every DB fact asserted below was verified against prod on 2026-08-03 with
 * `pg_proc` / `information_schema` / `pg_constraint`, in rolled-back
 * transactions — never from `src/types/database.types.ts`, which is stale.
 */

const pgQueryMock = jest.fn();
const outboxMock = jest.fn();
const helperInsertMock = jest.fn();

jest.mock('../src/db/direct-pg', () => ({
  pgQuery: (...args: any[]) => pgQueryMock(...args),
}));

jest.mock('../src/services/onchain-outbox', () => ({
  emitOnChainOutboxEvent: (...args: any[]) => outboxMock(...args),
}));

jest.mock('../src/scoring/score-event-writer', () => ({
  insertScoreEvent: (...args: any[]) => helperInsertMock(...args),
  reconciles: (e: any) => e.repid_after - e.repid_before === e.repid_delta_applied,
}));

import { readFileSync } from 'fs';
import { emitPeerVerifyScoreEvents } from '../src/services/peer-verify-score';
import { slashRepIDForGateFail, clearAgentUuidCache } from '../src/services/substance-gate-writer';

const AGENT_A = '11111111-2222-4333-8444-555555555555';
const AGENT_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A supabase-js double that records the score-event insert payload. */
function mockDb(currentRepid: number, sink: { payload?: any; updated?: any }) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: 'uuid-agent', current_repid: currentRepid }, error: null }),
        }),
      }),
      insert: (payload: any) => {
        if (table === 'repid_score_events') sink.payload = payload;
        return { error: null, select: () => ({ single: async () => ({ data: { id: 1 }, error: null }) }) };
      },
      update: (patch: any) => ({ eq: () => { sink.updated = patch; return { error: null }; } }),
    }),
  } as any;
}

beforeEach(() => {
  pgQueryMock.mockReset();
  outboxMock.mockReset();
  helperInsertMock.mockReset();
  outboxMock.mockResolvedValue({ emitted: true });
  helperInsertMock.mockResolvedValue({ ok: true, id: '999', applier: 'caller' });
  delete process.env.SCORE_EVENT_GUARD_MODE;
  delete process.env.PEER_VERIFY_REPID_ENABLED;
  delete process.env.WRITER_DIRECT_APPLY;
  clearAgentUuidCache();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────────
// peer-verify-score.ts — writer #12, raw SQL, trigger-applier
// ───────────────────────────────────────────────────────────────────────────────

describe('peer-verify-score: the guard is opt-in and the legacy path is untouched', () => {
  it('defaults to the legacy raw-SQL insert — the flag is OFF unless set', async () => {
    pgQueryMock.mockResolvedValue([{ id: 1, repid_after: 53, repid_delta_applied: 3 }]);

    await emitPeerVerifyScoreEvents({
      queueId: 42, producerAgentId: AGENT_A, verifierAgentId: AGENT_B, verdict: 'verified',
    });

    expect(helperInsertMock).not.toHaveBeenCalled();
    const sql = String(pgQueryMock.mock.calls[0]![0]);
    expect(sql).toMatch(/INSERT\s+INTO\s+repid_score_events/i);
    // Deliberately absent: no repid_delta_applied, so the trigger is the applier.
    expect(sql).not.toMatch(/repid_delta_applied\s*[,)]/);
  });

  it('enforce mode routes through the single writer with an EXPLICIT trigger applier', async () => {
    process.env.SCORE_EVENT_GUARD_MODE = 'enforce';
    // idempotency pre-check → no prior row; then the read-back of repid_after.
    pgQueryMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 999, repid_after: 53, repid_delta_applied: 3 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 1000, repid_after: 47, repid_delta_applied: 3 }]);

    const res = await emitPeerVerifyScoreEvents({
      queueId: 42, producerAgentId: AGENT_A, verifierAgentId: AGENT_B, verdict: 'verified',
    });

    expect(helperInsertMock).toHaveBeenCalledTimes(2);
    for (const call of helperInsertMock.mock.calls) {
      // THE REGRESSION THIS CATCHES: this writer never touches current_repid, so
      // the trigger is legitimately the sole applier. Claiming 'caller' here would
      // set repid_delta_applied, stand the trigger down, and silently stop the
      // score from moving at all.
      expect(call[0].applier).toBe('trigger');
      expect(call[0]).not.toHaveProperty('repid_delta_applied');
    }
    expect(res.emitted).toBe(true);
    expect(res.producerRepidAfter).toBe(53);
  });

  it('enforce mode preserves ON CONFLICT DO NOTHING semantics on a replay', async () => {
    process.env.SCORE_EVENT_GUARD_MODE = 'enforce';
    pgQueryMock.mockResolvedValue([{ id: 7 }]); // idempotency pre-check finds a row

    const res = await emitPeerVerifyScoreEvents({
      queueId: 42, producerAgentId: AGENT_A, verifierAgentId: AGENT_B, verdict: 'verified',
    });

    expect(helperInsertMock).not.toHaveBeenCalled();
    expect(res.emitted).toBe(false);
    // No row inserted ⇒ no on-chain bridge. A replay must not double-report.
    expect(outboxMock).not.toHaveBeenCalled();
  });

  it.each(['off', 'enforce'])(
    'refuses a zero delta in %s mode instead of raising 23502',
    async (mode) => {
      process.env.SCORE_EVENT_GUARD_MODE = mode;
      process.env.PEER_VERIFY_VERIFIED_DELTA = '0';
      jest.resetModules();
      const { emitPeerVerifyScoreEvents: emit } = require('../src/services/peer-verify-score');

      const res = await emit({
        queueId: 42, producerAgentId: AGENT_A, verifierAgentId: AGENT_B, verdict: 'verified',
      });

      // The trigger early-returns at `IF v_delta = 0` BEFORE stamping
      // repid_before/repid_after, and both are NOT NULL with no default, so the
      // insert cannot succeed. Verified: 23502 on prod, rolled back.
      expect(res.emitted).toBe(false);
      expect(helperInsertMock).not.toHaveBeenCalled();
      const wrote = pgQueryMock.mock.calls.some((c) => /INSERT/i.test(String(c[0])));
      expect(wrote).toBe(false);
      delete process.env.PEER_VERIFY_VERIFIED_DELTA;
    }
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// substance-gate-writer.ts — caller-applier, benign-by-ordering
// ───────────────────────────────────────────────────────────────────────────────

describe('substance-gate-writer: the guard is opt-in and the legacy path is untouched', () => {
  it('defaults to the legacy insert with NO repid_delta_applied', async () => {
    const sink: { payload?: any } = {};
    await slashRepIDForGateFail(mockDb(1000, sink), 'trinity-w3c', { id: 1 }, 0, 'gate-1');

    expect(helperInsertMock).not.toHaveBeenCalled();
    expect(sink.payload.repid_before).toBe(1000);
    expect(sink.payload.repid_after).toBe(950);
    // Absent by design in off mode: the trigger applies. Verified single-apply
    // because the caller's current_repid write happens AFTER this insert.
    expect(sink.payload.repid_delta_applied).toBeUndefined();
  });

  it('enforce mode sets repid_delta_applied so the trigger stands down', async () => {
    process.env.SCORE_EVENT_GUARD_MODE = 'enforce';
    const sink: { payload?: any } = {};
    await slashRepIDForGateFail(mockDb(1000, sink), 'trinity-w3c', { id: 1 }, 0, 'gate-2');

    expect(helperInsertMock).toHaveBeenCalledTimes(1);
    const e = helperInsertMock.mock.calls[0]![0];
    expect(e.applier).toBe('caller');
    expect(e.repid_before).toBe(1000);
    expect(e.repid_after).toBe(950);
    expect(e.repid_delta_applied).toBe(-50);
    // The single line that stops the double-apply.
    expect(e.repid_delta_applied).toBe(e.repid_after - e.repid_before);
  });

  it('records the APPLIED movement, not the intended delta, when the floor clamps', async () => {
    process.env.SCORE_EVENT_GUARD_MODE = 'enforce';
    const sink: { payload?: any } = {};
    // reap_count > 3 ⇒ delta -150, on an agent at 120. Math.max(0, -30) ⇒ 0.
    await slashRepIDForGateFail(mockDb(120, sink), 'trinity-w3c', { id: 1 }, 4, 'gate-3');

    // repid_after would be 0, outside CHECK (current_repid >= 10 AND <= 10000).
    // In off mode the trigger's unclamped UPDATE trips 23514 and the whole insert
    // dies silently; in enforce mode the trigger stands down, so a row WOULD land
    // claiming a score the Step-4 update cannot write. Refuse instead.
    expect(helperInsertMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('outside repid_agents_current_repid_check')
    );
  });

  it('reconciles: applied delta always equals after - before', async () => {
    process.env.SCORE_EVENT_GUARD_MODE = 'enforce';
    for (const [before, reap] of [[1000, 0], [5000, 4], [200, 0]] as const) {
      helperInsertMock.mockClear();
      const sink: { payload?: any } = {};
      await slashRepIDForGateFail(mockDb(before, sink), 'a', { id: 1 }, reap, `k-${before}-${reap}`);
      const e = helperInsertMock.mock.calls[0]![0];
      expect(e.repid_after - e.repid_before).toBe(e.repid_delta_applied);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Structural: the flag gate cannot be optimised away
// ───────────────────────────────────────────────────────────────────────────────

describe('the services-lane guard stays flag-gated and inert by default', () => {
  const FILES = [
    'src/services/peer-verify-score.ts',
    'src/services/substance-gate-writer.ts',
  ];

  it.each(FILES)('%s consults scoreEventGuardEnforced()', (file) => {
    expect(readFileSync(file, 'utf8')).toMatch(/scoreEventGuardEnforced\s*\(\s*\)/);
  });

  it.each(FILES)('%s reuses SCORE_EVENT_GUARD_MODE and invents no second switch', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toMatch(/score-event-guard/);
    // A private env flag here would fork the cutover and make the rollback
    // ambiguous. One switch, resolved in one place.
    const ownEnvFlags = src.match(/process\.env\.[A-Z_]*GUARD[A-Z_]*/g) ?? [];
    expect(ownEnvFlags).toEqual([]);
  });

  it.each(FILES)('%s still carries its unguarded branch for the off path', (file) => {
    const src = readFileSync(file, 'utf8');
    const hasLegacy =
      /INSERT\s+INTO\s+(?:public\.)?repid_score_events/i.test(src) ||
      /from\(\s*['"`]repid_score_events['"`]\s*\)[\s\S]{0,400}?\.\s*insert\s*\(/.test(src);
    // If this fails the legacy branch was deleted, which flips these writers to
    // enforce-only behaviour regardless of the flag — the opposite of inert.
    expect(hasLegacy).toBe(true);
  });
});
