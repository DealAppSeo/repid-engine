/**
 * Peer verification: why a queued row gets ZERO votes, and what lets ONE row get votes and settle.
 * Synthetic ids only; in-memory store; no network and no database.
 *
 * Hops under test (names, not line numbers, so this file does not rot):
 *   reader   processPeerVerificationQueue  (src/services/peer-verification-reader.ts)
 *   ballot   POST /respond                 (src/routes/peer-verification.ts)
 *   settle   resolvePanel / closePanelWithToken / applyPanelScoreEvents (src/services/peer-verify-consensus.ts)
 */
import crypto from 'crypto';

const g = global as any;

type Row = Record<string, any>;
const store = {
  queue: [] as Row[],
  tasks: [] as Row[],
  votes: [] as Row[],
  scoreEvents: [] as Row[],
  // The CHECK on peer_verification_queue.verification_status. The repo's own migration allows only the
  // first five; prod has since been given 'panel_resolved' out of band (no migration in this repo adds it).
  allowedStatuses: ['pending', 'in_review', 'verified', 'disputed', 'timeout'] as string[],
};

const PRODUCER = '11111111-1111-4111-8111-111111111111';
const AGENTS: Record<string, string> = {
  'trinity-mel': '0000000a-0000-4000-8000-00000000000a',
  'trinity-shofet': '0000000b-0000-4000-8000-00000000000b',
  'trinity-gcm': '0000000c-0000-4000-8000-00000000000c',
};
const QUEUE_ID = 9001;
const SOURCE_RESPONSE = '77777777-6666-4555-8444-333333333333';

// ---- fake supabase-js (just the chain shapes the reader uses) ---------------------------------
function makeDb() {
  const tables: Record<string, Row[]> = {
    peer_verification_queue: store.queue,
    trinity_tasks: store.tasks,
    repid_agents: [
      { id: PRODUCER, agent_name: 'trinity-producer' },
      ...Object.entries(AGENTS).map(([agent_name, id]) => ({ id, agent_name })),
    ],
  };
  return {
    from(table: string) {
      const st = { op: 'select', filters: [] as Array<(r: Row) => boolean>, payload: null as any, lim: Infinity };
      const run = () => {
        const rows = tables[table]!;
        if (st.op === 'insert') {
          const row = { id: rows.length + 1, ...st.payload };
          rows.push(row);
          return { data: [row], error: null };
        }
        const hit = rows.filter((r) => st.filters.every((f) => f(r))).slice(0, st.lim);
        if (st.op === 'update') hit.forEach((r) => Object.assign(r, st.payload));
        return { data: hit, error: null };
      };
      const b: any = {
        select: () => b,
        insert: (p: Row) => ((st.op = 'insert'), (st.payload = p), b),
        update: (p: Row) => ((st.op = 'update'), (st.payload = p), b),
        eq: (c: string, v: any) => (st.filters.push((r) => r[c] === v), b),
        is: (c: string, v: any) => (st.filters.push((r) => (v === null ? r[c] == null : r[c] === v)), b),
        // SQL semantics: NULL < x is never true. This is the whole reason legacy rows are unreachable.
        lt: (c: string, v: any) => (st.filters.push((r) => r[c] != null && r[c] < v), b),
        in: (c: string, vs: any[]) => (st.filters.push((r) => vs.includes(r[c])), b),
        limit: (n: number) => ((st.lim = n), b),
        single: () => {
          const res = run();
          const row = res.data[0];
          return Promise.resolve({ data: row ?? null, error: row ? null : { message: 'no row' } });
        },
        then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
      };
      return b;
    },
  };
}

// ---- direct-pg fake, keyed by the labels the code passes --------------------------------------
const assignedFor = (qid: number) =>
  [...new Set(store.tasks.filter((t) => t.task_type === 'peer_verify' && t.metadata?.panel === 'blind_2of3' && String(t.metadata?.peer_verification_queue_id) === String(qid)).map((t) => t.agent_assigned as string))].sort();

const pgQueryMock = jest.fn(async (_sql: string, p: any[], opts?: any) => {
  const q = store.queue.find((r) => String(r.id) === String(p?.[0]));
  switch (opts?.label) {
    case 'panel-fetch-queue':
      return q ? [q] : [];
    case 'panel-insert-vote': {
      const [source_response_id, queue_id, verifier_agent_id, verifier_agent_name, provider, verdict, signature, verifier_response_id] = p;
      if (store.votes.some((v) => v.source_response_id === source_response_id && v.verifier_agent_id === verifier_agent_id)) return [];
      store.votes.push({ id: store.votes.length + 1, source_response_id, queue_id, verifier_agent_id, verifier_agent_name, provider, verdict, signature, verifier_response_id });
      return [{ id: store.votes.length }];
    }
    case 'panel-fetch-votes':
      return [{ assigned: assignedFor(Number(p[0])), ballots: store.votes.filter((v) => String(v.queue_id) === String(p[0])) }];
    case 'panel-close-queue': {
      if (!q || !['pending', 'in_review'].includes(q.verification_status)) return [];
      if (!store.allowedStatuses.includes('panel_resolved')) {
        throw new Error('new row for relation "peer_verification_queue" violates check constraint "peer_verification_queue_verification_status_check"');
      }
      q.verification_status = 'panel_resolved';
      q.closure_reason = p[1];
      return [{ id: q.id }];
    }
    case 'panel-close-reread':
      return q ? [{ verification_status: q.verification_status, closure_reason: q.closure_reason ?? null }] : [];
    case 'panel-close-no-majority':
      return [];
    case 'panel-score-events-written':
      return [{ n: store.scoreEvents.filter((e) => e.metadata?.panel_close_token === p[1]).length }];
    default:
      return [];
  }
});
jest.mock('../src/db/direct-pg', () => ({
  pgQuery: (...a: any[]) => pgQueryMock(...(a as [any, any, any])),
  pgPing: jest.fn(async () => true),
}));
jest.mock('../src/scoring/pipeline', () => ({
  applyValidationEvent: jest.fn(async (agent_id: string, event_type: string, delta: number, metadata: any) => {
    store.scoreEvents.push({ agent_id, event_type, delta, metadata });
    return {};
  }),
}));
jest.mock('../src/services/peer-verify-score', () => ({ emitPeerVerifyScoreEvents: jest.fn(async () => ({ emitted: false })) }));
jest.mock('../src/services/emergency-halt', () => ({ shouldParkForHalt: jest.fn(async () => false) }));
jest.mock('../src/services/birth-rate-breaker', () => ({ checkBirthRate: jest.fn(async () => ({ exceeded: false, halted: false })) }));
jest.mock('../src/db', () => ({
  db: {
    from: () => ({
      select: () => ({
        or: (clause: string) => ({
          single: async () => {
            const name = clause.replace('agent_name.eq.', '');
            return AGENTS[name] ? { data: { id: AGENTS[name], agent_name: name }, error: null } : { data: null, error: { message: 'nf' } };
          },
        }),
      }),
    }),
  },
}));

import request from 'supertest';
import express from 'express';
import peerVerificationRouter from '../src/routes/peer-verification';
import { processPeerVerificationQueue } from '../src/services/peer-verification-reader';
import { computeConsensus } from '../src/services/peer-verify-consensus';

const SECRET = 'synthetic-test-secret';
const app = express();
app.use(express.json());
app.use('/api/v1/peer-verification', peerVerificationRouter);

let n = 0;
async function castVote(verifier: string, verdict: string) {
  const responseId = `99999999-8888-4777-8666-${String(++n).padStart(12, '0')}`;
  const signature = crypto.createHmac('sha256', SECRET).update(`${QUEUE_ID}:${responseId}:${verdict}`).digest('hex');
  return request(app).post('/api/v1/peer-verification/respond').send({
    queue_id: QUEUE_ID, verifier_agent_id: verifier, verifier_response_id: responseId, verdict, signature,
  });
}

const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const seedRow = (over: Row) =>
  store.queue.push({
    id: QUEUE_ID, source_agent_id: PRODUCER, source_response_id: SOURCE_RESPONSE, certainty_at_claim: 0.7,
    claim_text: 'The synthetic registry contract is deployed at the synthetic address on the synthetic chain.',
    verification_status: 'in_review', verifier_agent_id: null, reclaim_count: 0, claimed_at: null, ...over,
  });

describe('peer verification: zero-vote symptom and the piece that fixes it', () => {
  beforeEach(() => {
    store.queue.length = 0; store.tasks.length = 0; store.votes.length = 0; store.scoreEvents.length = 0;
    store.allowedStatuses = ['pending', 'in_review', 'verified', 'disputed', 'timeout', 'panel_resolved'];
    pgQueryMock.mockClear();
    process.env.PEER_VERIFY_HMAC_SECRET = SECRET;
    process.env.PEER_VERIFY_PANEL_ENABLED = 'true';
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.PEER_VERIFY_HMAC_SECRET;
    delete process.env.PEER_VERIFY_PANEL_ENABLED;
  });

  it('ZERO VOTES: an in_review row with no lease stamp (claimed_at NULL) is never dispatched, so no ballot can exist', async () => {
    seedRow({ claimed_at: null });
    await processPeerVerificationQueue(makeDb() as any);
    await processPeerVerificationQueue(makeDb() as any);
    expect(store.tasks).toHaveLength(0);
    expect(store.votes).toHaveLength(0);
    expect(store.queue[0]!.verification_status).toBe('in_review');
  });

  it('ZERO VOTES: with the panel switch OFF even an expired lease is not reclaimed (breaker 2.4)', async () => {
    process.env.PEER_VERIFY_PANEL_ENABLED = 'false';
    seedRow({ claimed_at: HOURS_AGO(2) });
    await processPeerVerificationQueue(makeDb() as any);
    expect(store.tasks).toHaveLength(0);
    expect(store.votes).toHaveLength(0);
  });

  it('SETTLES: with a stale lease stamp and the panel on, the reader assigns 3 verifiers; 2 matching ballots settle the row and move RepID', async () => {
    seedRow({ claimed_at: HOURS_AGO(2) });
    await processPeerVerificationQueue(makeDb() as any);
    expect(store.tasks.map((t) => t.agent_assigned).sort()).toEqual(['trinity-gcm', 'trinity-mel', 'trinity-shofet']);
    expect(store.queue[0]!.reclaim_count).toBe(1);

    const first = await castVote('trinity-mel', 'verified');
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ consensus_reached: false });
    expect(store.queue[0]!.verification_status).toBe('in_review');
    expect(store.scoreEvents).toHaveLength(0);

    const second = await castVote('trinity-shofet', 'verified');
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ consensus_reached: true, consensus_verdict: 'verified', scored: true });
    expect(store.queue[0]!.verification_status).toBe('panel_resolved');
    // producer +3 (VALIDATION_PASSED) and each agreeing verifier +3 (VALIDATOR_REWARD): the only RepID movement
    expect(store.scoreEvents.map((e) => `${e.event_type}:${e.delta}`).sort()).toEqual([
      'VALIDATION_PASSED:3', 'VALIDATOR_REWARD:3', 'VALIDATOR_REWARD:3',
    ]);
  });

  it('STUCK AT 2: two matching ballots do NOT settle while the status CHECK lacks panel_resolved (the July failure); the third voter is irrelevant', async () => {
    store.allowedStatuses = ['pending', 'in_review', 'verified', 'disputed', 'timeout']; // the repo migration's CHECK
    seedRow({ claimed_at: HOURS_AGO(2) });
    await processPeerVerificationQueue(makeDb() as any);
    await castVote('trinity-gcm', 'disputed');
    const second = await castVote('trinity-shofet', 'disputed');
    expect(second.status).toBe(503); // prod's July code surfaced the same failure as a 500
    expect(store.queue[0]!.verification_status).toBe('in_review');
    expect(store.votes).toHaveLength(2);
    expect(store.scoreEvents).toHaveLength(0);

    store.allowedStatuses.push('panel_resolved'); // the missing piece: the CHECK accepts the close
    const retry = await castVote('trinity-shofet', 'disputed'); // idempotent ballot, re-evaluates consensus
    expect(retry.body).toMatchObject({ consensus_reached: true, consensus_verdict: 'disputed' });
    expect(store.queue[0]!.verification_status).toBe('panel_resolved');
  });

  it('STUCK AT 2: with the third verifier silent, no split of two ballots closes (timeout+timeout, timeout+X, verified+disputed)', () => {
    const c = (...v: string[]) => computeConsensus(v.map((verdict, i) => ({ verifier_agent_id: `v${i}`, verdict: verdict as any })));
    expect(c('timeout', 'timeout').reached).toBe(false);
    expect(c('timeout', 'disputed').reached).toBe(false);
    expect(c('timeout', 'verified').reached).toBe(false);
    expect(c('verified', 'disputed').reached).toBe(false);
    expect(c('disputed', 'disputed').reached).toBe(true); // reached, but see the CHECK test above
    expect(c('verified', 'verified').reached).toBe(true);
  });
});
