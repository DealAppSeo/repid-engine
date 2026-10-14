/**
 * A full blind 2-of-3 panel with NO majority must be closed, not left waiting.
 *
 * [V 2026-10-14] 4 of the 7 real panels (queue 142077, 142080, 142081, 142083) got all three
 * ballots with no majority and stayed `in_review` for good. POST /respond answered the last voter
 * "202, wait for more votes", but one ballot per verifier means no more votes could come.
 *
 * XC1's NOT-YET (PR #1366 review), each pinned below:
 *   1. the panel is the verifiers the reader ASSIGNED to the queue row — an extra identity's
 *      ballot never completes or swings it;
 *   2. the enforce close is ONE statement that re-reads the assigned ballots and writes only if
 *      they still show all-in and no 2-of-3 — a stale snapshot cannot close a row a late
 *      majority finished;
 *   3. ballots are keyed by queue_id, not source_response_id;
 *   4. the HTTP body carries tally COUNTS only — never another verifier's name:verdict.
 *
 * Drives the real route through supertest, with pgQuery mocked by `label` (same harness as
 * peer-verification-respond.test.ts) and applyValidationEvent mocked, so the "never scored"
 * claim is checked rather than assumed. The SQL itself is not executed here; its predicate was
 * dry-run read-only against prod (see the PR).
 */
import crypto from 'crypto';

type Ballot = { verifier_agent_id: string; verifier_agent_name: string; provider: string; verdict: string };
const PANEL = ['trinity-gcm', 'trinity-mel', 'trinity-shofet'];
(global as any).__assigned = PANEL;
(global as any).__votes = [] as Ballot[];
(global as any).__closeRows = null as any[] | null;

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
      return [{ assigned: (global as any).__assigned, ballots: (global as any).__votes }];
    case 'panel-close-queue':
      return [{ id: 142077 }];
    case 'panel-close-no-majority':
      return (global as any).__closeRows ?? [];
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
import { assignedBallots, PANEL_VERIFIER_POOL } from '../src/services/peer-verify-consensus';

const SECRET = 'test-panel-hmac-secret';
const RESPONSE_UUID = '99999999-8888-4777-8666-555555555555';

const ballot = (name: string, verdict: string, i = 0): Ballot => ({
  verifier_agent_id: `0000000${i}-0000-4000-8000-000000000000`,
  verifier_agent_name: name,
  provider: 'groq',
  verdict,
});
/** One ballot per assigned verifier, in PANEL order. */
const ballots = (...verdicts: string[]): Ballot[] => verdicts.map((v, i) => ballot(PANEL[i]!, v, i));
/** What the close statement RETURNs when its re-read qualifies. */
const closedRow = (verified: number, disputed: number, timeout: number) => [{
  id: 142077, verified, disputed, timeout,
  closure_reason: `panel_no_majority(...) verified=${verified} disputed=${disputed} timeout=${timeout} | ...`,
}];

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
/** No verifier identity anywhere in the HTTP body: counts only. */
const noNames = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(/trinity-|0000000\d-/);

describe('panel with all assigned ballots in and no 2-of-3 majority', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    pgQueryMock.mockClear();
    applyValidationEventMock.mockClear();
    (global as any).__assigned = PANEL;
    (global as any).__closeRows = null;
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

  it('1-1-1 (enforce): ONE re-reading statement closes as timeout; HTTP gets counts only; never scores', async () => {
    process.env.PANEL_CLOSE_NO_MAJORITY = 'enforce';
    (global as any).__votes = ballots('verified', 'disputed', 'timeout');
    (global as any).__closeRows = closedRow(1, 1, 1);
    const res = await castLastVote('timeout');

    const [sql, params] = callFor('panel-close-no-majority')!;
    expect(sql).toMatch(/^\s*WITH\s/); // one statement: the re-read and the UPDATE together
    expect(sql).toMatch(/JOIN trinity_tasks t[\s\S]*metadata->>'peer_verification_queue_id' = pq\.id::text/); // assigned panel
    expect(sql).toMatch(/JOIN peer_verification_votes v\s+ON v\.queue_id = \$1\s+AND v\.verifier_agent_name = a\.name/);
    expect(sql).toMatch(/UPDATE peer_verification_queue q/);
    expect(sql).toMatch(/q\.verification_status IN \('pending','in_review'\)/); // never reopens a finished row
    expect(sql).toMatch(/t\.n_in = t\.n_assigned/);
    expect(sql).toMatch(/NOT \(\(t\.ver >= \$5 AND t\.ver > t\.dis\) OR \(t\.dis >= \$5 AND t\.dis > t\.ver\)\)/);
    expect(sql).toMatch(/closure_reason = format\(/); // built from the re-read, not from the snapshot
    // 'timeout', not 'disputed': compute_self_certainty() counts 'disputed' against the producer.
    expect(params).toEqual([142077, [...PANEL_VERIFIER_POOL], 'timeout', 3, 2]);

    expect(res.body.consensus_reached).toBe(false);
    expect(res.body.no_majority_close).toEqual({
      mode: 'enforce', closed: true, status: 'timeout', tally: { verified: 1, disputed: 1, timeout: 1 },
    });
    noNames(res.body);
    expect(labelsCalled()).not.toContain('panel-close-queue'); // not panel_resolved
    expect(applyValidationEventMock).not.toHaveBeenCalled(); // no RepID movement for anyone
  });

  it('all three abstain (the 142077 shape, enforce): closes as timeout', async () => {
    process.env.PANEL_CLOSE_NO_MAJORITY = 'enforce';
    (global as any).__votes = ballots('timeout', 'timeout', 'timeout');
    (global as any).__closeRows = closedRow(0, 0, 3);
    const res = await castLastVote('timeout');

    expect(callFor('panel-close-no-majority')![0]).toMatch(/CASE WHEN t\.ver \+ t\.dis = 0 THEN 'all_timeout'/);
    expect(res.body.no_majority_close).toMatchObject({ closed: true, status: 'timeout', tally: { timeout: 3 } });
    expect(applyValidationEventMock).not.toHaveBeenCalled();
  });

  it('ballots are fetched by queue_id with the assigned panel, not by source_response_id', async () => {
    (global as any).__votes = ballots('verified', 'disputed');
    await castLastVote('disputed');

    const [sql, params] = callFor('panel-fetch-votes')!;
    expect(sql).toMatch(/WHERE v\.queue_id = \$1/);
    expect(sql).not.toMatch(/source_response_id = \$1/);
    expect(sql).toMatch(/assigned AS/);
    expect(params).toEqual([142077, [...PANEL_VERIFIER_POOL]]);
  });

  it('an EXTRA identity cannot complete a panel: 2 assigned + 1 outsider stays open', async () => {
    process.env.PANEL_CLOSE_NO_MAJORITY = 'enforce';
    (global as any).__votes = [...ballots('timeout', 'timeout'), ballot('trinity-outsider', 'timeout', 7)];
    const res = await castLastVote('timeout');

    expect(labelsCalled()).not.toContain('panel-close-no-majority');
    expect(res.status).toBe(202);
    expect(res.body.votes_in).toBe(2); // the outsider is not counted
    expect(res.body.no_majority_close).toBeUndefined();
  });

  it('an EXTRA identity cannot swing a full panel into a majority', async () => {
    process.env.PANEL_CLOSE_NO_MAJORITY = 'enforce';
    // Counting every row would read verified=2 here and score a fake 2-of-3.
    (global as any).__votes = [...ballots('verified', 'disputed', 'timeout'), ballot('trinity-outsider', 'verified', 7)];
    (global as any).__closeRows = closedRow(1, 1, 1);
    const res = await castLastVote('timeout');

    expect(labelsCalled()).not.toContain('panel-close-queue');
    expect(res.body.consensus_reached).toBe(false);
    expect(res.body.no_majority_close).toMatchObject({ closed: true, tally: { verified: 1, disputed: 1, timeout: 1 } });
    expect(applyValidationEventMock).not.toHaveBeenCalled();
  });

  it('late-majority race: the snapshot says no-majority but the re-read does not qualify → not closed, and the majority still resolves', async () => {
    process.env.PANEL_CLOSE_NO_MAJORITY = 'enforce';
    // Request A: its snapshot is a full 1-1-1, but by the time its single statement runs the row was
    // finished by the majority path (or the re-read no longer qualifies) — 0 rows.
    (global as any).__votes = ballots('verified', 'disputed', 'timeout');
    (global as any).__closeRows = [];
    const a = await castLastVote('timeout');
    expect(a.body.no_majority_close).toMatchObject({ mode: 'enforce', closed: false });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NOT closed: already finished, or the assigned ballots no longer show/));
    expect(applyValidationEventMock).not.toHaveBeenCalled();
    noNames(a.body);

    // Request B: the late majority. Its own close to panel_resolved wins and it scores.
    pgQueryMock.mockClear();
    (global as any).__votes = ballots('verified', 'verified', 'disputed');
    const b = await castLastVote('verified');
    expect(callFor('panel-close-queue')![0]).toMatch(/verification_status = 'panel_resolved'/);
    expect(labelsCalled()).not.toContain('panel-close-no-majority');
    expect(b.body.consensus_verdict).toBe('verified');
    expect(applyValidationEventMock).toHaveBeenCalled();
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

  it('a panel the reader assigned only 2 verifiers is never closed here', async () => {
    process.env.PANEL_CLOSE_NO_MAJORITY = 'enforce';
    (global as any).__assigned = ['trinity-gcm', 'trinity-mel'];
    (global as any).__votes = ballots('verified', 'disputed');
    await castLastVote('disputed');
    expect(labelsCalled()).not.toContain('panel-close-no-majority');
  });

  it.each([
    ['unset', undefined],
    ["any value but 'enforce'", 'true'],
  ])('flag %s: shadow — logs what WOULD close, writes nothing, HTTP gets counts only', async (_label, value) => {
    if (value !== undefined) process.env.PANEL_CLOSE_NO_MAJORITY = value;
    (global as any).__votes = ballots('verified', 'disputed', 'timeout');
    const res = await castLastVote('timeout');

    expect(labelsCalled()).not.toContain('panel-close-no-majority');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/SHADOW .*queue 142077 WOULD close as 'timeout'/));
    expect(res.body.no_majority_close).toEqual({
      mode: 'shadow', closed: false, status: 'timeout', tally: { verified: 1, disputed: 1, timeout: 1 },
    });
    noNames(res.body);
    expect(applyValidationEventMock).not.toHaveBeenCalled();
  });
});

describe('assignedBallots', () => {
  it('keeps assigned verifiers only, first ballot each', () => {
    const out = assignedBallots(['a', 'b'], [
      ballot('a', 'verified'), ballot('x', 'verified'), ballot('a', 'disputed'), ballot('b', 'timeout'),
    ] as any);
    expect(out.map((v) => `${v.verifier_agent_name}:${v.verdict}`)).toEqual(['a:verified', 'b:timeout']);
  });
});
