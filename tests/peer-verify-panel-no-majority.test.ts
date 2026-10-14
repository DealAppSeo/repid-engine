/**
 * A full blind 2-of-3 panel with NO majority must be closed, not left waiting.
 *
 * [V 2026-10-14] 4 of the 7 real panels (queue 142077, 142080, 142081, 142083) got all three
 * ballots with no majority and stayed `in_review` for good. POST /respond answered the last voter
 * "202, wait for more votes", but one ballot per verifier means no more votes could come.
 *
 * Drives the real route through supertest, with pgQuery mocked by `label` (same harness as
 * peer-verification-respond.test.ts) and applyValidationEvent mocked, so the "never scored"
 * claim is checked rather than assumed.
 */
import crypto from 'crypto';

type Ballot = { verifier_agent_id: string; verifier_agent_name: string; provider: string; verdict: string };
(global as any).__votes = [] as Ballot[];

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
      return (global as any).__votes;
    case 'panel-close-queue':
    case 'panel-close-no-majority':
      return [{ id: 142077 }];
    default:
      return [];
  }
});
jest.mock('../src/db/direct-pg', () => ({
  pgQuery: (...a: any[]) => pgQueryMock(...(a as [any, any, any])),
  pgPing: jest.fn(async () => true),
}));

const applyValidationEventMock = jest.fn(async () => ({}));
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

const SECRET = 'test-panel-hmac-secret';
const RESPONSE_UUID = '99999999-8888-4777-8666-555555555555';

function ballots(...verdicts: string[]): Ballot[] {
  const names = ['trinity-shofet', 'trinity-gcm', 'trinity-mel'];
  return verdicts.map((verdict, i) => ({
    verifier_agent_id: `0000000${i}-0000-4000-8000-000000000000`,
    verifier_agent_name: names[i]!,
    provider: 'groq',
    verdict,
  }));
}

async function castLastVote(verdict: string) {
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

const labelsCalled = () => pgQueryMock.mock.calls.map((c) => c[2]?.label);
const callFor = (label: string) => pgQueryMock.mock.calls.find((c) => c[2]?.label === label);

describe('panel with all ballots in and no 2-of-3 majority', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    pgQueryMock.mockClear();
    applyValidationEventMock.mockClear();
    process.env.PEER_VERIFY_PANEL_ENABLED = 'true';
    process.env.PEER_VERIFY_HMAC_SECRET = SECRET;
    delete process.env.PANEL_CLOSE_NO_MAJORITY;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    delete process.env.PEER_VERIFY_PANEL_ENABLED;
    delete process.env.PEER_VERIFY_HMAC_SECRET;
    delete process.env.PANEL_CLOSE_NO_MAJORITY;
  });

  it('1-1-1 (enforce): closes the row as timeout, records tally + ballots, never scores', async () => {
    process.env.PANEL_CLOSE_NO_MAJORITY = 'enforce';
    (global as any).__votes = ballots('verified', 'disputed', 'timeout');
    const res = await castLastVote('timeout');

    const close = callFor('panel-close-no-majority');
    expect(close).toBeDefined();
    const [sql, params] = close!;
    expect(sql).toMatch(/UPDATE peer_verification_queue/);
    expect(sql).toMatch(/verification_status IN \('pending','in_review'\)/); // never reopens a closed row
    expect(params[0]).toBe(142077);
    // 'timeout', not 'disputed': compute_self_certainty() counts 'disputed' against the producer.
    expect(params[1]).toBe('timeout');
    expect(params[2]).toBe(
      'panel_no_majority(no_majority) verified=1 disputed=1 timeout=1 | ' +
        'trinity-shofet:verified, trinity-gcm:disputed, trinity-mel:timeout',
    );

    expect(res.body.consensus_reached).toBe(false);
    expect(res.body.no_majority_close).toMatchObject({ mode: 'enforce', closed: true, status: 'timeout' });
    expect(labelsCalled()).not.toContain('panel-close-queue'); // not panel_resolved
    expect(applyValidationEventMock).not.toHaveBeenCalled(); // no RepID movement for anyone
  });

  it('all three abstain (the 142077 shape, enforce): closes as timeout', async () => {
    process.env.PANEL_CLOSE_NO_MAJORITY = 'enforce';
    (global as any).__votes = ballots('timeout', 'timeout', 'timeout');
    const res = await castLastVote('timeout');

    expect(callFor('panel-close-no-majority')![1][2]).toMatch(/^panel_no_majority\(all_timeout\) verified=0 disputed=0 timeout=3/);
    expect(res.body.no_majority_close).toMatchObject({ closed: true, status: 'timeout' });
    expect(applyValidationEventMock).not.toHaveBeenCalled();
  });

  it('2-1 still resolves as panel_resolved and scores, untouched by the new path', async () => {
    process.env.PANEL_CLOSE_NO_MAJORITY = 'enforce';
    (global as any).__votes = ballots('verified', 'verified', 'disputed');
    const res = await castLastVote('disputed');

    expect(callFor('panel-close-queue')![0]).toMatch(/verification_status = 'panel_resolved'/);
    expect(labelsCalled()).not.toContain('panel-close-no-majority');
    expect(res.body.consensus_reached).toBe(true);
    expect(res.body.consensus_verdict).toBe('verified');
    expect(res.body.no_majority_close).toBeUndefined();
    expect(applyValidationEventMock).toHaveBeenCalled();
  });

  it('fewer than 3 ballots stays open, even under enforce', async () => {
    process.env.PANEL_CLOSE_NO_MAJORITY = 'enforce';
    (global as any).__votes = ballots('verified', 'disputed');
    const res = await castLastVote('disputed');

    expect(labelsCalled()).not.toContain('panel-close-no-majority');
    expect(labelsCalled()).not.toContain('panel-close-queue');
    expect(res.status).toBe(202);
    expect(res.body.reason).toBe('insufficient_votes');
    expect(res.body.no_majority_close).toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/WOULD close/));
  });

  it.each([
    ['unset', undefined],
    ["any value but 'enforce'", 'true'],
  ])('flag %s: shadow — logs what WOULD close and writes nothing', async (_label, value) => {
    if (value !== undefined) process.env.PANEL_CLOSE_NO_MAJORITY = value;
    (global as any).__votes = ballots('verified', 'disputed', 'timeout');
    const res = await castLastVote('timeout');

    expect(labelsCalled()).not.toContain('panel-close-no-majority');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/SHADOW .*queue 142077 WOULD close as 'timeout'/));
    expect(res.body.no_majority_close).toMatchObject({ mode: 'shadow', closed: false });
    expect(applyValidationEventMock).not.toHaveBeenCalled();
  });
});
