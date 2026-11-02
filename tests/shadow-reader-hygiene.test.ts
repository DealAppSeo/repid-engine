/**
 * Shadow score rows are never read as canonical activity.
 *
 * `repid_score_events.is_shadow` rows record what a would-be policy WOULD have done. They move no
 * score. But today's shadow rows (the settlement-shadow DB trigger's SERVICE_SATISFIED) carry a
 * NONZERO `delta`, and once TRINITY_BRIDGE_KNOWN_ANSWER_MODE=shadow flips there will be many
 * HAL_SCORE_EVENT shadow rows too. Every reader that means "what this agent actually did" has to
 * filter them out, or a policy nobody enforces moves the badges, the counts, the proof cadence and
 * the numbers on the public card.
 *
 * Every test seeds one real row and one shadow row (nonzero delta) and asserts the reader answers
 * as if the shadow row did not exist. They fail on main for the reason stated in each name.
 */
import request from 'supertest';
import { makeFakeDb, realRow, shadowRow, NOW } from './helpers/fake-score-events-db';

const mockTables: Record<string, any[]> = {};
const mockPgSql: string[] = [];

jest.mock('../src/db', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { makeFakeDb: make } = require('./helpers/fake-score-events-db');
  return { db: make(mockTables) };
});
jest.mock('../src/middleware/auth', () => ({
  authMiddleware: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/db/direct-pg', () => ({
  ...jest.requireActual('../src/db/direct-pg'),
  pgQuery: jest.fn(async (sql: string) => { mockPgSql.push(sql); return []; }),
}));

/* eslint-disable @typescript-eslint/no-var-requires */
import app from '../src/index';
const { shouldTriggerProof } = require('../src/scoring/pipeline');
const { runRepidSync } = require('../src/services/reputation/repid-sync-aggregator');
const { computeEthics, checkAndAwardBadges } = require('../src/engine/badges');
const { computeRedemptionModifier } = require('../src/layers/decay');
const { updateSupplyRate } = require('../src/layers/ecosystem-need');
const { getRepIDHistory } = require('../src/repid/repid-service');
const { getRepidEventStats, getPeerVerificationStats } = require('../src/services/observability-queries');
const { countRecentFlags } = require('../src/services/chronic-flag-accumulator');
const { supabaseCapDataSource } = require('../src/services/durable-caps');
const { loadExchangeContext } = require('../src/services/exchange-red-team');
const { getMetricsSnapshot, resetMetricsCache } = require('../src/services/metrics-snapshot');
const { detectInflationOutliers } = require('../src/services/repid-inflation-detector');
const { SELECT_CANDIDATES_SQL } = require('../src/workers/proof-refresh-worker');
const { db } = require('../src/db');
/* eslint-enable @typescript-eslint/no-var-requires */

const A1 = '11111111-2222-3333-4444-555555555555';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function seed(events: Array<Record<string, any>>, extra: Record<string, any[]> = {}) {
  for (const k of Object.keys(mockTables)) delete mockTables[k];
  mockTables.repid_score_events = events.map((e, i) => ({ id: i + 1, ...e }));
  Object.assign(mockTables, extra);
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  mockPgSql.length = 0;
  resetMetricsCache();
});

describe('proof cadence', () => {
  it('shouldTriggerProof: the every-10th cadence counts canonical events only', async () => {
    // 6 real + 3 shadow: 9 rows on main, so the next event looks like the 10th. It is the 7th.
    seed([...Array(6)].map(() => realRow({ agent_id: A1 })).concat([...Array(3)].map(() => shadowRow({ agent_id: A1 }))));
    expect(await shouldTriggerProof(A1, 0)).toBe(false);
    // 9 real + 3 shadow: 12 rows on main, so the real 10th event is missed.
    seed([...Array(9)].map(() => realRow({ agent_id: A1 })).concat([...Array(3)].map(() => shadowRow({ agent_id: A1 }))));
    expect(await shouldTriggerProof(A1, 0)).toBe(true);
  });
});

describe('RepID sums and replay', () => {
  it('repid-sync-aggregator does not sum a shadow row into the proposed score', async () => {
    seed(
      [realRow({ agent_id: 'a1', delta: 5 }), shadowRow({ agent_id: 'a1', delta: 30 }), shadowRow({ agent_id: 'only-shadow', delta: 30 })],
      { repid_agents: [{ id: 'a1', agent_name: 'one', current_repid: 1000 }, { id: 'only-shadow', agent_name: 'two', current_repid: 1000 }] },
    );
    const r = await runRepidSync({ dryRun: true, lookbackHours: 24 });
    expect(r.totalNetDelta).toBe(5);
    expect(r.agentsScanned).toBe(1);
    expect(r.perAgent[0].proposed).toBe(1005);
    expect(r.perAgent[0].eventsConsidered).toBe(1);
  });

  it('getRepIDHistory does not list a shadow row as a score point', async () => {
    seed([realRow({ agent_id: A1 }), shadowRow({ agent_id: A1 })]);
    const h = await getRepIDHistory(A1);
    expect(h).toHaveLength(1);
    expect(h[0].repid_score).toBe(105);
  });

  it('inflation detector sums canonical rows only (the SQL excludes is_shadow)', async () => {
    await detectInflationOutliers('daily');
    expect(mockPgSql.join('\n')).toMatch(/e\.is_shadow\s*=\s*false/);
  });
});

describe('badges, ethics, redemption, supply', () => {
  it('computeEthics counts canonical events only', async () => {
    seed([realRow({ agent_id: A1 }), shadowRow({ agent_id: A1 })], { repid_agents: [{ id: A1, current_repid: 1000 }] });
    const e = await computeEthics(A1);
    expect(e.counts.totalEvents).toBe(1);
  });

  it('checkAndAwardBadges: three shadow gains after a real loss are not a Redemption Arc', async () => {
    const t = (ms: number) => ago(ms);
    seed(
      [
        realRow({ agent_id: A1, delta: -5, created_at: t(5000) }),
        ...[1, 2, 3].map((i) => shadowRow({ agent_id: A1, delta: 30, created_at: t(5000 - i * 1000) })),
      ],
      { repid_badges: [] },
    );
    const awarded = await checkAndAwardBadges(A1, 100, 100);
    expect(awarded.map((b: any) => b.name ?? b.badge_name)).not.toContain('Redemption Arc');
  });

  it('computeRedemptionModifier: shadow prosocial events do not earn redemption', async () => {
    const violation = realRow({ agent_id: A1, event_type: 'EPISTEMIC_VIOLATION', delta: -5, created_at: ago(1000) });
    const prosocial = (shadow: boolean) =>
      [...Array(50)].map(() => (shadow ? shadowRow : realRow)({ agent_id: A1, event_type: 'CHALLENGE_WIN', delta: 5, created_at: ago(1000) }));
    seed([violation, ...prosocial(false)]);
    const earned = await computeRedemptionModifier(A1);
    expect(earned).not.toBe(1.0); // precondition: real prosocial events DO earn it
    seed([violation, ...prosocial(true)]);
    expect(await computeRedemptionModifier(A1)).toBe(1.0);
  });

  it('updateSupplyRate counts canonical events only', async () => {
    seed([realRow({ event_type: 'REFERRAL' }), shadowRow({ event_type: 'REFERRAL' }), shadowRow({ event_type: 'REFERRAL' })], { repid_ecosystem_supply: [] });
    await updateSupplyRate('REFERRAL');
    expect(mockTables.repid_ecosystem_supply[0].supply_rate_7d).toBeCloseTo(1 / 7, 6);
  });

  it('countRecentFlags: a shadow "flagged" verdict is not a chronic flag', async () => {
    seed([realRow({ agent_id: A1, hal_decision: 'flagged' }), shadowRow({ agent_id: A1, hal_decision: 'flagged', event_type: 'HAL_SCORE_EVENT', delta: 0 })]);
    expect(await countRecentFlags(db, A1, 24)).toBe(1);
  });
});

describe('caps, red-team context, proof refresh', () => {
  it('durable caps: domain RepID is the latest canonical repid_after, not a shadow row', async () => {
    seed(
      [
        realRow({ agent_id: A1, task_domain: 'coding', repid_after: 6000, created_at: ago(5000) }),
        shadowRow({ agent_id: A1, task_domain: 'coding', repid_after: 7777, created_at: ago(1000) }),
      ],
      { repid_agents: [{ id: A1, agent_name: 'trinity-coder' }] },
    );
    const r = await supabaseCapDataSource(db).domainRepid('trinity-coder', 'coding');
    expect(r).toEqual({ readable: true, repid: 6000 });
  });

  it('a shadow-only domain history is "no domain RepID", not a number', async () => {
    seed([shadowRow({ agent_id: A1, task_domain: 'coding', repid_after: 7777 })], { repid_agents: [{ id: A1, agent_name: 'trinity-coder' }] });
    const r = await supabaseCapDataSource(db).domainRepid('trinity-coder', 'coding');
    expect(r.readable).toBe(false);
  });

  it('exchange red-team context: a shadow delta is not the contract RepID movement', async () => {
    seed(
      [
        realRow({ agent_id: 'prov-1', contract_id: 'c1', delta: 15 }),
        shadowRow({ agent_id: 'prov-1', contract_id: 'c1', delta: 30 }),
        shadowRow({ agent_id: 'buyer-1', contract_id: 'c1', delta: 15 }),
      ],
    );
    const ctx = await loadExchangeContext(db, { id: 'c1', buyer_agent_id: 'buyer-1', provider_agent_id: 'prov-1' } as any, {});
    expect(ctx.repidDeltas).toEqual({ buyer: null, provider: 15 });
  });

  it('proof-refresh candidate query takes the latest CANONICAL event', () => {
    expect(SELECT_CANDIDATES_SQL).toMatch(/s\.is_shadow\s*=\s*false/);
  });
});

describe('stats surfaces', () => {
  it('getRepidEventStats: 24h event counts and delta sum exclude shadow rows', async () => {
    seed([realRow({ delta: 5 }), shadowRow({ delta: 30 })]);
    const s = await getRepidEventStats();
    expect(s.eventsLast24hByType).toEqual({ SERVICE_SATISFIED: 1 });
    expect(s.deltaSumLast24h).toBe(5);
  });

  it('getPeerVerificationStats: the rate denominator is canonical events', async () => {
    seed([realRow(), shadowRow(), shadowRow()], {
      peer_verification_queue: [{ verification_status: 'pending', created_at: NOW(), completed_at: null }],
    });
    const s = await getPeerVerificationStats();
    expect(s.peer_verification_rate).toBe(1); // 1 queued / 1 real event
  });

  it('public metrics snapshot: active agents and the catch-rate denominator exclude shadow rows', async () => {
    seed([
      realRow({ agent_id: 'a1', hallucination_caught: true }),
      realRow({ agent_id: 'a1', hallucination_caught: false }),
      shadowRow({ agent_id: 'a2', hallucination_caught: false }),
      shadowRow({ agent_id: 'a3', hallucination_caught: true }),
    ]);
    const snap = await getMetricsSnapshot(db);
    expect(snap.active_agents_24h).toBe(1);
    expect(snap.hallucination_catch_rate).toBe(0.5); // 1 caught / 2 real events
  });
});

describe('public routes', () => {
  it('GET /api/v1/agents/:id/card: decision count, last event and provenance ignore shadow rows', async () => {
    seed(
      [
        realRow({ agent_id: A1, created_at: ago(60_000), hal_decision: 'clean', hal_score: 0.1 }),
        shadowRow({ agent_id: A1, created_at: ago(1_000), hal_decision: 'vetoed', hal_score: 0.9 }),
      ],
      { repid_agents: [{ id: A1, agent_name: 'trinity-x', current_repid: 1460 }] },
    );
    const res = await request(app).get(`/api/v1/agents/${A1}/card`);
    expect(res.status).toBe(200);
    expect(res.body.total_decisions).toBe(1);
    expect(res.body.provenance.sample_size).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain('SHADOW_NO_MUTATION');
  });

  it('GET /agents/:id/history lists canonical events only', async () => {
    seed([realRow({ agent_id: A1 }), shadowRow({ agent_id: A1 })]);
    const res = await request(app).get(`/agents/${A1}/history`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].delta).toBe(5);
  });

  it('GET /events/recent does not show a shadow event in the public feed', async () => {
    seed([realRow({ agent_id: A1 }), shadowRow({ agent_id: A1 })], { repid_agents: [{ id: A1, agent_name: 'trinity-x', constitution: {} }] });
    const res = await request(app).get('/events/recent');
    expect(res.status).toBe(200);
    const rows = Array.isArray(res.body) ? res.body : res.body.events;
    expect(rows).toHaveLength(1);
  });
});
