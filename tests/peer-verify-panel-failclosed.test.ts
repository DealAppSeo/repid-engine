/**
 * Panel majority path fails CLOSED (XC1 round-2 NOT-YET on #1366, fixed forward).
 *
 *  1. The assigned-ballot lookup runs ONCE, before the close. The old code re-ran it after setting
 *     panel_resolved, so a throw there left the row closed and unscored for good.
 *  2. If scoring fails before any event is written, the row is reopened (in_review, unscored,
 *     retryable). A partial failure is not reopened (a retry would double-score) and says so.
 *  3. The lookups fail fast (one attempt, 2 s) and are bounded by LIMIT.
 *  4. The majority HTTP body is counts only — no per-verifier score events.
 *  5. PEER_VERIFY_ASSIGNED_ONLY: 'enforce' by default (what #1366 deployed), 'off' as the rollback.
 */
import crypto from 'crypto';

type Ballot = { verifier_agent_id: string; verifier_agent_name: string; provider: string; verdict: string };
const PANEL = ['trinity-gcm', 'trinity-mel', 'trinity-shofet'];
const g = global as any;
g.__votes = [] as Ballot[];
g.__fetchFailOnCall = 0; // 1-based call number that throws; 0 = never

let fetchCalls = 0;
const pgQueryMock = jest.fn(async (_sql: string, _params: any[], opts?: any) => {
  switch (opts?.label) {
    case 'panel-fetch-queue':
      return [{
        id: 142077,
        source_agent_id: '11111111-2222-4333-8444-555555555555',
        source_response_id: '77777777-6666-4555-8444-333333333333',
        claim_text: 'a claim',
        certainty_at_claim: 0.7,
        verification_status: 'in_review',
      }];
    case 'panel-insert-vote':
      return [{ id: 1 }];
    case 'panel-fetch-votes':
      fetchCalls++;
      if (g.__fetchFailOnCall === fetchCalls) throw new Error('[direct-pg] query timeout after 2000ms: panel-fetch-votes');
      return [{ assigned: PANEL, ballots: g.__votes }];
    case 'panel-close-queue':
      return [{ id: 142077 }];
    default:
      return [];
  }
});
jest.mock('../src/db/direct-pg', () => ({
  pgQuery: (...a: any[]) => pgQueryMock(...(a as [any, any, any])),
  pgPing: jest.fn(async () => true),
}));

g.__scoreFailOnCall = 0; // 1-based applyValidationEvent call that throws; 0 = never
let scoreCalls = 0;
const applyValidationEventMock = jest.fn(async () => {
  scoreCalls++;
  if (g.__scoreFailOnCall === scoreCalls) throw new Error('repid_score_events insert failed');
  return {};
});
jest.mock('../src/scoring/pipeline', () => ({
  applyValidationEvent: (...a: any[]) => applyValidationEventMock(...(a as [])),
}));
jest.mock('../src/services/peer-verify-score', () => ({
  emitPeerVerifyScoreEvents: jest.fn(async () => ({ emitted: false })),
}));
jest.mock('../src/db', () => ({
  db: {
    from: () => ({
      select: () => ({
        or: () => ({
          single: async () => ({
            data: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', agent_name: 'trinity-mel' },
            error: null,
          }),
        }),
      }),
    }),
    rpc: async () => ({ data: null, error: null }),
  },
}));

import request from 'supertest';
import express from 'express';
import peerVerificationRouter from '../src/routes/peer-verification';
import { PANEL_LOOKUP_OPTS, panelModesBootLine } from '../src/services/peer-verify-consensus';

const SECRET = 'test-panel-hmac-secret';
const RESPONSE_UUID = '99999999-8888-4777-8666-555555555555';
const ballot = (name: string, verdict: string, i = 0): Ballot => ({
  verifier_agent_id: `0000000${i}-0000-4000-8000-000000000000`,
  verifier_agent_name: name,
  provider: 'groq',
  verdict,
});
const ballots = (...verdicts: string[]): Ballot[] => verdicts.map((v, i) => ballot(PANEL[i]!, v, i));

async function castVote(verdict: string) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/peer-verify', peerVerificationRouter);
  const signature = crypto.createHmac('sha256', SECRET).update(`142077:${RESPONSE_UUID}:${verdict}`).digest('hex');
  return request(app).post('/api/v1/peer-verify/respond').send({
    queue_id: 142077,
    verifier_agent_id: 'trinity-mel',
    verifier_response_id: RESPONSE_UUID,
    verdict,
    signature,
  });
}
const callsFor = (label: string) => pgQueryMock.mock.calls.filter((c) => c[2]?.label === label);
const noNames = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/trinity-|0000000\d-|agent_id|agreed/);

describe('panel majority path fails closed', () => {
  let errSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    pgQueryMock.mockClear();
    applyValidationEventMock.mockClear();
    fetchCalls = 0;
    scoreCalls = 0;
    g.__fetchFailOnCall = 0;
    g.__scoreFailOnCall = 0;
    process.env.PEER_VERIFY_PANEL_ENABLED = 'true';
    process.env.PEER_VERIFY_HMAC_SECRET = SECRET;
    delete process.env.PEER_VERIFY_ASSIGNED_ONLY;
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    delete process.env.PEER_VERIFY_PANEL_ENABLED;
    delete process.env.PEER_VERIFY_HMAC_SECRET;
    delete process.env.PEER_VERIFY_ASSIGNED_ONLY;
  });

  it('the assigned-ballot lookup runs once, BEFORE the close — a second read that would throw is never made', async () => {
    g.__votes = ballots('verified', 'verified', 'disputed');
    g.__fetchFailOnCall = 2; // the old code's post-close re-read
    const res = await castVote('verified');

    expect(res.status).toBe(200);
    expect(callsFor('panel-fetch-votes')).toHaveLength(1);
    expect(callsFor('panel-close-queue')).toHaveLength(1);
    expect(applyValidationEventMock).toHaveBeenCalled();
    expect(res.body).toMatchObject({ consensus_reached: true, consensus_verdict: 'verified', scored: true });
  });

  it('a lookup throw leaves the row untouched and unscored (no close)', async () => {
    g.__votes = ballots('verified', 'verified', 'disputed');
    g.__fetchFailOnCall = 1;
    const res = await castVote('verified');

    expect(res.status).toBe(500);
    expect(callsFor('panel-close-queue')).toHaveLength(0);
    expect(applyValidationEventMock).not.toHaveBeenCalled();
  });

  it('scoring fails before any event is written → row REOPENED (in_review), 503 retryable', async () => {
    g.__votes = ballots('verified', 'verified', 'disputed');
    g.__scoreFailOnCall = 1;
    const res = await castVote('verified');

    expect(res.status).toBe(503);
    expect(res.body.retryable).toBe(true);
    const [sql, params] = callsFor('panel-reopen-unscored')[0]!;
    expect(sql).toMatch(/SET verification_status = 'in_review'/);
    expect(sql).toMatch(/AND verification_status = 'panel_resolved'/); // reopens only what this request closed
    expect(params).toEqual([142077]);
  });

  it('scoring fails part-way → NOT reopened (a retry would double-score), 500, logged for reconciliation', async () => {
    g.__votes = ballots('verified', 'verified', 'disputed');
    g.__scoreFailOnCall = 2;
    const res = await castVote('verified');

    expect(res.status).toBe(500);
    expect(res.body.retryable).toBe(false);
    expect(callsFor('panel-reopen-unscored')).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/PANEL scoring PARTIAL — queue 142077: 1\/\d+ events written/));
  });

  it('majority HTTP body is counts only — per-verifier events stay in the log', async () => {
    g.__votes = ballots('verified', 'verified', 'disputed');
    const res = await castVote('verified');

    expect(res.body.score_events).toBeUndefined();
    expect(res.body.score_events_count).toBeGreaterThan(0);
    expect(res.body.tally).toEqual({ verified: 2, disputed: 1, timeout: 0 });
    noNames(res.body);
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/PANEL consensus=verified queue=142077 .*events=\[/));
  });

  it('lookups fail fast (one attempt, 2 s) and are bounded by LIMIT', async () => {
    g.__votes = ballots('verified', 'verified', 'disputed');
    await castVote('verified');

    const [sql, , opts] = callsFor('panel-fetch-votes')[0]!;
    expect(opts).toMatchObject({ retries: 1, timeoutMs: 2000 });
    expect(PANEL_LOOKUP_OPTS).toEqual({ retries: 1, timeoutMs: 2000 });
    expect(sql).toMatch(/LIMIT 10/); // assigned set
    expect(sql).toMatch(/LIMIT 50/); // ballots on the queue row
  });

  it("PEER_VERIFY_ASSIGNED_ONLY default 'enforce': an extra identity cannot swing the majority", async () => {
    g.__votes = [...ballots('verified', 'disputed', 'timeout'), ballot('trinity-outsider', 'verified', 7)];
    const res = await castVote('timeout');
    expect(res.body.consensus_reached).toBe(false);
    expect(applyValidationEventMock).not.toHaveBeenCalled();
  });

  it("PEER_VERIFY_ASSIGNED_ONLY='off' (rollback lever): every verifier's first ballot counts again", async () => {
    process.env.PEER_VERIFY_ASSIGNED_ONLY = 'off';
    g.__votes = [...ballots('verified', 'disputed', 'timeout'), ballot('trinity-outsider', 'verified', 7)];
    const res = await castVote('timeout');
    expect(res.body.consensus_reached).toBe(true);
    expect(res.body.consensus_verdict).toBe('verified');
  });

  it('boot line names every panel switch and its resolved value', () => {
    expect(panelModesBootLine()).toBe(
      '[peer-verify/panel] PEER_VERIFY_PANEL_ENABLED=true PEER_VERIFY_ASSIGNED_ONLY=enforce PANEL_CLOSE_NO_MAJORITY=shadow',
    );
    process.env.PEER_VERIFY_ASSIGNED_ONLY = ' OFF ';
    expect(panelModesBootLine()).toMatch(/PEER_VERIFY_ASSIGNED_ONLY=off/);
  });
});
