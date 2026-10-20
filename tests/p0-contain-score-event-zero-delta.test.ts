/**
 * P0 CONTAIN (Trust Harness, 2026-10-19) — the certainty-scaled score-event reward earns 0.
 *
 * POST /api/v1/agents/:id/score-event used baseDelta = round(certainty*10) and never read the
 * reported `outcome`. This drives the REAL route end to end (HAL signal extraction, side effects
 * and the API-key lookup mocked; reward formula, earn gate, vesting and insert logic real) against a
 * fake DB whose score-event insert runs a TRANSCRIPTION of the apply_repid_score_event trigger, and
 * pins:
 *   - "always full certainty" (certainty 1.0) earns 0, whatever outcome is reported, in both
 *     SCORE_EVENT_GUARD_MODE branches (legacy raw insert and guarded insertScoreEvent);
 *   - the old non-approval penalty is also 0 (it was -round(certainty*10): claim 0, escape it);
 *   - the trigger never applies anything, so the caller and the trigger cannot both apply;
 *   - the event is still recorded, with the withheld number in metadata only.
 * Plus the /score resolver binding: a body cannot claim to be a third-party resolver.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../src/auth/api-keys', () => ({
  ...jest.requireActual('../src/auth/api-keys'),
  validateAgentApiKey: jest.fn().mockResolvedValue({ agent_id: 'agent-1', scopes: ['score_event'] }),
}));

// HAL signals are an input here, not the subject: fix them so the decision is "approved" by default.
const signals = { value: { harm_probability: 0, epistemic_uncertainty: 0, evidence_quality: 1, scope_appropriateness: 1, prompt_category: 'opinion' } };
jest.mock('../src/services/hal-signals', () => ({
  extractHALSignals: jest.fn(() => signals.value),
  extractHALSignalsWithCrossLLM: jest.fn(async () => signals.value),
}));
jest.mock('../src/services/graph-rag/hal-memory-hook', () => ({ writeDecisionMemory: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/engine/deception-emitter', () => ({ emitDeceptionShadow: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/webhook-delivery', () => ({ deliverSignedWebhook: jest.fn() }));

const START = 1000;
const store = {
  agent: { id: 'agent-1', agent_name: 'P0AGENT', current_repid: START, activity_30d: 5, vested_repid: 0, vesting_cliff_ends_at: null, wisdom_score: 1000, vdr_count: 0 } as Record<string, any>,
  rows: [] as Array<Record<string, any>>,
  triggerApplied: [] as number[],
};

function applyTrigger(row: Record<string, any>): Record<string, any> {
  const NEW = { ...row };
  if (NEW.repid_delta_applied !== undefined && NEW.repid_delta_applied !== null) return NEW;
  const calc = NEW.repid_delta_calculated;
  const vDelta = calc !== undefined && calc !== null ? Number(calc) : Number(NEW.delta ?? 0);
  if (vDelta === 0) return NEW;
  const before = store.agent.current_repid;
  store.agent.current_repid = before + vDelta;
  store.triggerApplied.push(vDelta);
  return { ...NEW, repid_before: before, repid_after: store.agent.current_repid, repid_delta_applied: vDelta };
}

jest.mock('../src/db', () => {
  const chain = (result: any) => {
    const q: any = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'gte', 'in']) q[m] = () => q;
    q.single = async () => result;
    q.maybeSingle = async () => result;
    q.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej);
    return q;
  };
  return {
    db: {
      rpc: jest.fn(async () => ({ data: 0, error: null })),
      from: (table: string) => {
        if (table === 'repid_agents') {
          return {
            select: () => chain({ data: { ...store.agent }, error: null }),
            update: (patch: Record<string, unknown>) => ({
              eq: async () => {
                Object.assign(store.agent, patch);
                return { error: null };
              },
            }),
          };
        }
        if (table === 'repid_score_events') {
          return {
            insert: (row: Record<string, any>) => {
              store.rows.push(applyTrigger(row));
              return chain({ data: { id: store.rows.length }, error: null });
            },
          };
        }
        if (table === 'repid_config') return chain({ data: null, error: null }); // code fallbacks
        return { insert: () => chain({ data: null, error: null }), ...chain({ data: null, error: null }) };
      },
    },
  };
});

import agentsExternalRouter from '../src/routes/agents-external';

const app = express();
app.use(express.json());
app.use('/api/v1/agents', agentsExternalRouter);

function post(body: Record<string, unknown>) {
  return request(app)
    .post('/api/v1/agents/agent-1/score-event')
    .set('Authorization', 'Bearer ts_live_test')
    .send({ llm_provider: 'test', decision_text: 'a deliverable', task_domain: 'finance', ...body });
}

const savedGuard = process.env.SCORE_EVENT_GUARD_MODE;
beforeEach(() => {
  store.agent.current_repid = START;
  store.agent.activity_30d = 5;
  store.rows = [];
  store.triggerApplied = [];
  signals.value = { harm_probability: 0, epistemic_uncertainty: 0, evidence_quality: 1, scope_appropriateness: 1, prompt_category: 'opinion' };
});
afterAll(() => {
  if (savedGuard === undefined) delete process.env.SCORE_EVENT_GUARD_MODE;
  else process.env.SCORE_EVENT_GUARD_MODE = savedGuard;
});

describe.each(['off', 'enforce'])('score-event earns 0 official RepID (SCORE_EVENT_GUARD_MODE=%s)', (mode) => {
  beforeEach(() => {
    process.env.SCORE_EVENT_GUARD_MODE = mode;
  });

  it('"always full certainty": 10 events at certainty 1.0, any reported outcome → score never moves', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await post({ certainty: 1.0, outcome: i % 2 ? 'success' : 'failure' });
      expect(res.status).toBe(200);
      expect(res.body.delta).toBe(0);
      expect(res.body.new_score).toBe(START);
    }
    expect(store.agent.current_repid).toBe(START);
    expect(store.triggerApplied).toEqual([]);
    expect(store.rows).toHaveLength(10);
    for (const row of store.rows) {
      expect(row.delta).toBe(0);
      expect(row.repid_delta_calculated ?? 0).toBe(0); // the column the trigger reads first
      expect(row.metadata.p0_contain.official_delta).toBe(0);
      expect(row.metadata.prediction_shadow).toMatchObject({ eligible: false, reason: 'resolved_by_actor' });
    }
    // Withheld, not erased: the number the old code would have applied is still auditable.
    expect(store.rows[0].metadata.p0_contain.withheld_certainty_scaled_delta).toBeGreaterThan(0);
  });

  it('the non-approval penalty is contained too (it was -round(certainty*10))', async () => {
    // dissonance = (0.4*0.5 + 0.3*0.5 + 0.2*0.5) * comma ≈ 0.456: above approve (0.43), below block (0.55).
    signals.value = { harm_probability: 0.5, epistemic_uncertainty: 0.5, evidence_quality: 0.5, scope_appropriateness: 1, prompt_category: 'opinion' };
    const res = await post({ certainty: 1.0, outcome: 'failure' });
    expect(res.status).toBe(200);
    expect(res.body.hal_approved).toBe(false);
    expect(res.body.delta).toBe(0);
    expect(store.rows[0].metadata.p0_contain.withheld_certainty_scaled_delta).toBe(-10);
    expect(store.agent.current_repid).toBe(START);
    expect(store.triggerApplied).toEqual([]);
  });

  it('still recorded as activity', async () => {
    await post({ certainty: 0.5, outcome: 'success' });
    expect(store.agent.activity_30d).toBe(6);
  });
});

describe('/score: the shadow-score resolver comes from the key, never the body', () => {
  it('a bound key cannot pass itself off as a third-party resolver', async () => {
    let scoreHandler: any;
    let updateRepId: any;
    jest.isolateModules(() => {
      jest.doMock('../src/engine/repid-update', () => ({ updateRepId: jest.fn(async () => ({ delta: 0 })) }));
      scoreHandler = require('../src/routes/score').scoreHandler;
      updateRepId = require('../src/engine/repid-update').updateRepId;
    });
    const res: any = { status() { return this; }, json() { return this; } };

    await scoreHandler({ body: { agentId: 'agent-1', eventType: 'PREDICTION_RESOLVE', predictionResolvedBy: 'operator_key' }, agent_id: 'agent-1' } as any, res);
    await scoreHandler({ body: { agentId: 'agent-2', eventType: 'PREDICTION_RESOLVE', predictionResolvedBy: 'actor' } } as any, res);

    const calls = (updateRepId as jest.Mock).mock.calls;
    expect(calls[0][0].predictionResolvedBy).toBe('actor');        // bound key = the actor
    expect(calls[1][0].predictionResolvedBy).toBe('operator_key'); // non-bound key = another party
  });
});
