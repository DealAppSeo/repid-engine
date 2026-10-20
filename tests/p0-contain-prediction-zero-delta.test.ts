/**
 * P0 CONTAIN (Trust Harness, 2026-10-19) — POST /score PREDICTION_RESOLVE earns 0 official RepID.
 *
 * Drives the REAL updateRepId() against a fake DB whose repid_score_events insert runs a
 * TRANSCRIPTION of the live BEFORE INSERT trigger apply_repid_score_event() (body as recorded in
 * src/routes/score-event-guard.ts and tests/scoring2-zero-delta.test.ts; the trigger itself is not
 * in this repo). So the test sees BOTH appliers: the trigger's relative add at insert time and the
 * engine's absolute repid_agents update after it. Pinned:
 *
 *   1. "always claim 1%" and "always claim 100%" each earn 0 official RepID, right or wrong, over
 *      many events; the trigger applies nothing and the score never moves.
 *   2. The prediction row carries delta 0 and NO repid_delta_calculated (the column the trigger
 *      reads first), so neither applier has a non-zero delta to apply.
 *   3. The shadow Brier score lands in metadata.prediction_shadow, only for an outcome resolved by
 *      someone other than the actor, and it is strictly proper (honest reporting maximises it).
 */

// Neutralise the scoring layers so only the PREDICTION_RESOLVE branch matters.
jest.mock('../src/layers/ecosystem-need', () => ({
  getEcosystemNeedWeight: jest.fn().mockResolvedValue(1.0),
  updateSupplyRate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/layers/challenge-scoring', () => ({ scoreChallengeOutcome: jest.fn() }));
jest.mock('../src/layers/decay', () => ({
  applyDecay: (repid: number) => repid, // no decay, so any movement is a delta
  computeRedemptionModifier: jest.fn().mockResolvedValue(1.0),
}));
jest.mock('../src/layers/constitutional-audit', () => ({
  auditConstitutionalCompliance: jest.fn().mockResolvedValue({
    enabled: false, passed: null, complianceScore: null, rulesChecked: [],
    halMode: 0, easAttestationId: 'eas-stub', easSchema: 'v1', processingMs: 0,
    mirrorTestPassed: true,
  }),
}));
jest.mock('../src/engine/badges', () => ({ checkAndAwardBadges: jest.fn().mockResolvedValue([]) }));

const START = 1000;
const store = {
  agent: { id: 'agent-1', agent_name: 'P0AGENT', current_repid: START, activity_30d: 5 },
  rows: [] as Array<Record<string, unknown>>,
  triggerApplied: [] as number[],
};

/** apply_repid_score_event(), transcribed. Mutates the agent exactly where the trigger UPDATEs it. */
function applyTrigger(row: Record<string, unknown>): Record<string, unknown> {
  const NEW = { ...row };
  if (NEW.repid_delta_applied !== undefined && NEW.repid_delta_applied !== null) return NEW;
  const calc = NEW.repid_delta_calculated;
  const vDelta = calc !== undefined && calc !== null ? Number(calc) : Number(NEW.delta ?? 0);
  if (vDelta === 0) return NEW;
  const before = store.agent.current_repid;
  store.agent.current_repid = before + vDelta;
  store.triggerApplied.push(vDelta);
  NEW.repid_before = before;
  NEW.repid_after = store.agent.current_repid;
  NEW.repid_delta_applied = vDelta;
  return NEW;
}

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: { ...store.agent }, error: null }) }) }),
          update: (patch: Record<string, unknown>) => ({
            eq: async () => {
              Object.assign(store.agent, patch); // the engine's ABSOLUTE write
              return { error: null };
            },
          }),
        };
      }
      if (table === 'repid_score_events') {
        return {
          insert: async (row: Record<string, unknown>) => {
            store.rows.push(applyTrigger(row));
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  },
}));

import { updateRepId, shadowPredictionScore, type RepIdUpdateInput } from '../src/engine/repid-update';
import { properScoreReward } from '../src/decisioning/anfis-poa-feed';

beforeEach(() => {
  store.agent.current_repid = START;
  store.agent.activity_30d = 5;
  store.rows = [];
  store.triggerApplied = [];
});

async function run(input: Partial<RepIdUpdateInput>) {
  return updateRepId({ agentId: 'agent-1', eventType: 'PREDICTION_RESOLVE', ...input } as RepIdUpdateInput);
}

describe('PREDICTION_RESOLVE earns 0 official RepID for every stated-confidence strategy', () => {
  const strategies: Array<[string, number]> = [
    ['always claim 1%', 0.01],
    ['always claim 100%', 1.0],
  ];

  for (const [name, pStated] of strategies) {
    it(`${name}: 20 resolved predictions (half right, half wrong) move the score by exactly 0`, async () => {
      for (let i = 0; i < 20; i++) {
        const r = await run({ pStated, pCorrect: i % 2 === 0 ? 1 : 0, predictionDaysAgo: 0, networkImportance: 3 });
        expect(r.delta).toBe(0);
        expect(r.repIdAfter).toBe(START);
      }
      expect(store.agent.current_repid).toBe(START);
      expect(store.triggerApplied).toEqual([]); // the DB applier never fired
      expect(store.rows).toHaveLength(20); // still recorded: every event has its audit row
      for (const row of store.rows) {
        expect(row.delta).toBe(0);
        expect(row.repid_delta_calculated).toBeUndefined();
        expect(row.repid_before).toBe(START);
        expect(row.repid_after).toBe(START);
      }
    });
  }

  it('the event still counts as activity (activity_30d advances), only the score is held', async () => {
    await run({ pStated: 0.01, pCorrect: 1 });
    expect(store.agent.activity_30d).toBe(6);
    expect(store.agent.current_repid).toBe(START);
  });
});

describe('caller and DB trigger cannot both apply a prediction delta', () => {
  it('the trigger sees delta 0 and no repid_delta_calculated, so it returns before touching the score', async () => {
    await run({ pStated: 0.01, pCorrect: 1, predictionResolvedBy: 'operator_key' });
    const row = store.rows[0];
    expect(row.delta).toBe(0);
    expect('repid_delta_calculated' in row).toBe(false);
    expect(store.triggerApplied).toEqual([]);
    // The shadow number lives ONLY in metadata, which the trigger does not read.
    expect((row.metadata as any).prediction_shadow.brier_reward).toBeGreaterThan(0);
  });
});

describe('shadow Brier score (metadata only, eligibility-gated)', () => {
  it('eligible only when resolved by a party other than the actor', async () => {
    await run({ pStated: 0.8, pCorrect: 1, predictionResolvedBy: 'operator_key' });
    await run({ pStated: 0.8, pCorrect: 1, predictionResolvedBy: 'actor' });
    await run({ pStated: 0.8, pCorrect: 1 }); // resolver unknown
    const shadows = store.rows.map((r) => (r.metadata as any).prediction_shadow);
    expect(shadows[0]).toMatchObject({ eligible: true, official_delta: 0, resolved_by: 'operator_key', correct: true });
    expect(shadows[0].brier_reward).toBeCloseTo(properScoreReward(0.8, true), 10);
    expect(shadows[1]).toMatchObject({ eligible: false, reason: 'resolved_by_actor' });
    expect(shadows[2]).toMatchObject({ eligible: false, reason: 'resolver_unknown', resolved_by: null });
    expect(shadows[1].brier_reward).toBeUndefined();
    expect(shadows[2].brier_reward).toBeUndefined();
  });

  it('missing inputs are ineligible, never a guessed score', () => {
    expect(shadowPredictionScore({ predictionResolvedBy: 'operator_key', pStated: 0.7 })).toMatchObject({
      eligible: false,
      reason: 'missing_inputs',
    });
  });

  it('is strictly proper: for a true probability q, reporting q beats claiming 1% or 100%', () => {
    const expected = (p: number, q: number) => {
      const right = shadowPredictionScore({ predictionResolvedBy: 'operator_key', pStated: p, pCorrect: 1 }).brier_reward!;
      const wrong = shadowPredictionScore({ predictionResolvedBy: 'operator_key', pStated: p, pCorrect: 0 }).brier_reward!;
      return q * right + (1 - q) * wrong;
    };
    for (const q of [0.2, 0.5, 0.7, 0.9]) {
      expect(expected(q, q)).toBeGreaterThan(expected(0.01, q));
      expect(expected(q, q)).toBeGreaterThan(expected(1.0, q));
    }
  });

  it('non-prediction events carry no prediction_shadow key (their row shape is unchanged)', async () => {
    await updateRepId({ agentId: 'agent-1', eventType: 'STAKE' } as RepIdUpdateInput);
    expect('prediction_shadow' in (store.rows[0].metadata as any)).toBe(false);
  });
});
