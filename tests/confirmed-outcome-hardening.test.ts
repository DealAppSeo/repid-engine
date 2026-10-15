/**
 * confirmed-outcome-hardening.test.ts — XC1's farm paths (2026-10-14 red-team), each driven through
 * the REAL updateRepId() with the flag ON, against an in-memory DB that models the three tables the
 * path touches. Every block goes RED with its fix reverted:
 *
 *   (A) SERVER RESULT WINS. A FAILED receipt + `abstained`, `settledBy:'vote'`, `result:'right'`,
 *       `selfReportedMiss` + low confidence + a fresh domain, a mismatched settler or a misplaced
 *       penalty flag → the server's wrong is applied and the receipt is consumed. (Before: each one
 *       returned before the server verdict, scored 0, and left the receipt unspent.)
 *   (B) CONTENT KEY. N receipts, same subject + same args_hash, different ids → ONE gain. The fake
 *       models the partial unique index in migrations/2026-10-14-kernel-receipts-content-claim.sql;
 *       block (B) also pins that the .sql declares exactly that index.
 *   (C) THE CAP IS ON THE SCORE PATH. Gains past the per-day / per-domain cap in one UTC day are
 *       capped, a gain capped to zero claims nothing, and the day boundary is a CALENDAR UTC day
 *       (pinned at 23:59:59.999Z vs 00:00:00.000Z — a rolling 24h window would fail it).
 *   (D) EXPIRY. A receipt past the TTL moves nothing and is not consumed; the TTL knob is read and a
 *       garbage value fails closed, loudly.
 *   (E) FLAG OFF is today: neither kernel_receipts nor the cap readers are touched.
 *   (F) GROUNDING_MODE=enforce cannot zero a spent server-settled wrong (it still zeroes a gain).
 *   (G) The indexer writes args_hash (the write half of the content key).
 *
 * Magnitudes are PINNED test values (scoring-tuning-not-in-repo discipline):
 *   gain 5, lossBase -15, confidence weight 40 → a server-settled wrong is -55; rubber-stamp -120;
 *   per-day cap 12, per-domain cap 8.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

// Plain functions, not jest.fn(): afterEach restores the Date.now / console spies, and these must survive it.
jest.mock('../src/layers/ecosystem-need', () => ({
  getEcosystemNeedWeight: async () => 1.0,
  updateSupplyRate: async () => undefined,
}));
jest.mock('../src/layers/challenge-scoring', () => ({ scoreChallengeOutcome: () => 0 }));
jest.mock('../src/layers/prediction-scoring', () => ({ scorePrediction: () => 0 }));
jest.mock('../src/layers/decay', () => ({
  applyDecay: (repid: number) => repid,
  computeRedemptionModifier: async () => 1.0,
}));
jest.mock('../src/layers/constitutional-audit', () => ({
  auditConstitutionalCompliance: async () => ({
    enabled: false, passed: null, complianceScore: null, rulesChecked: [],
    halMode: 0, easAttestationId: 'eas-stub', easSchema: 'v1', processingMs: 0,
    mirrorTestPassed: true,
  }),
}));
jest.mock('../src/engine/badges', () => ({ checkAndAwardBadges: async () => [] }));

type Row = Record<string, any>;
const AGENT = 'agent-1';
const st = {
  agent: { id: AGENT, agent_name: 'TESTAGENT', current_repid: 1000, activity_30d: 5 } as Row,
  receipts: [] as Row[],
  events: [] as Row[],
  upserts: [] as Row[],
  krReads: 0,
  claimAttempts: 0,
  eventReads: 0,
  budget: new Map<string, number>(),
  rpcCalls: 0,
};

/** PostgREST-style column path: `a->b->>c` walks jsonb; `->>` yields text. */
function col(row: Row, path: string): unknown {
  let v: any = row;
  for (const k of path.split(/->>?/)) v = v == null ? undefined : v[k];
  return path.includes('->>') ? (v == null ? null : String(v)) : v;
}

jest.mock('../src/db', () => ({
  db: {
    // public.claim_confirmed_gain, modelled in tests/helpers/fake-claim-confirmed-gain.ts: the atomic
    // receipt claim + day/domain budget reservation every confirmed GAIN now goes through.
    rpc: (fn: string, args: any) => {
      st.rpcCalls++;
      return require('./helpers/fake-claim-confirmed-gain').fakeRpc(() => st.receipts, st.budget)(fn, args);
    },
    from: (table: string) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: { ...st.agent }, error: null }), maybeSingle: async () => ({ data: { ...st.agent }, error: null }) }) }),
          update: (p: Row) => ({ eq: async () => { Object.assign(st.agent, p); return { error: null }; } }),
        };
      }
      if (table === 'kernel_receipts') {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => {
                st.krReads++;
                const r = st.receipts.find((x) => x['receipt_id'] === id);
                return { data: r ? { ...r } : null, error: null };
              },
            }),
          }),
          // UPDATE ... WHERE receipt_id=$1 AND consumed_at IS NULL RETURNING receipt_id, with the
          // partial unique index (subject_agent_id, args_hash) WHERE consumed_at IS NOT NULL AND
          // verification_status = 'VERIFIED' enforced exactly as Postgres would (23505, no write).
          update: (p: Row) => {
            st.claimAttempts++;
            const where: Array<(r: Row) => boolean> = [];
            const chain: any = {
              eq: (c: string, v: unknown) => { where.push((r) => r[c] === v); return chain; },
              is: (c: string, v: unknown) => { where.push((r) => (v === null ? r[c] == null : r[c] === v)); return chain; },
              select: async () => {
                const hits = st.receipts.filter((r) => where.every((w) => w(r)));
                for (const r of hits) {
                  const next = { ...r, ...p };
                  const inIndex = (x: Row) => x['consumed_at'] != null && x['verification_status'] === 'VERIFIED';
                  if (inIndex(next) && st.receipts.some((o) => o !== r && inIndex(o) &&
                      o['subject_agent_id'] === next['subject_agent_id'] && o['args_hash'] === next['args_hash'])) {
                    return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "kernel_receipts_one_gain_per_content"' } };
                  }
                }
                for (const r of hits) Object.assign(r, p);
                return { data: hits.map((r) => ({ receipt_id: r['receipt_id'] })), error: null };
              },
            };
            return chain;
          },
          upsert: async (row: Row) => { st.upserts.push(row); return { error: null }; },
        };
      }
      if (table === 'repid_score_events') {
        return {
          insert: async (row: Row) => { st.events.push({ ...row, created_at: new Date(Date.now()).toISOString() }); return { error: null }; },
          select: () => {
            st.eventReads++;
            const where: Array<(r: Row) => boolean> = [];
            const chain: any = {
              eq: (c: string, v: unknown) => { where.push((r) => col(r, c) === v); return chain; },
              gte: (c: string, v: string) => { where.push((r) => Date.parse(String(col(r, c))) >= Date.parse(v)); return chain; },
              gt: (c: string, v: number) => { where.push((r) => Number(col(r, c)) > v); return chain; },
              then: (ok: (x: unknown) => unknown, ko?: (e: unknown) => unknown) =>
                Promise.resolve({ data: st.events.filter((r) => where.every((w) => w(r))).map((r) => ({ delta: r['delta'] })), error: null }).then(ok, ko),
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  },
}));

import { updateRepId } from '../src/engine/repid-update';
import { __resetConfirmedParamsCache } from '../src/scoring/confirmed-outcome';
import { __resetSmallGainCapParamsCache } from '../src/scoring/small-gain-cap';
import { indexKernelReceiptToDb } from '../src/kernel/receipt-db-index';
import { sealedRow } from './helpers/sealed-gate-receipt';
import type { KernelReceipt } from '../src/kernel/types';

const PINNED: Record<string, string> = {
  REPID_CONFIRMED_GAIN_BASE: '5',
  REPID_CONFIRMED_LOSS_BASE: '-15',
  REPID_CONFIRMED_CONFIDENCE_LOSS_WEIGHT: '40',
  REPID_CONFIRMED_RUBBER_STAMP_PENALTY: '-120',
  REPID_CONFIRMED_BAND_TIGHTEN_BASE: '-8',
  REPID_CONFIRMED_SELF_REPORT_MISS_FACTOR: '0.5',
  REPID_CONFIRMED_NEED_WEIGHT_CAP: '2',
  REPID_SMALL_GAIN_PER_DAY_CAP: '12',
  REPID_SMALL_GAIN_PER_DOMAIN_CAP: '8',
  REPID_SMALL_GAIN_PREDICTION_REFERENCE: '200',
  REPID_SMALL_GAIN_CEILING_FRACTION: '0.2',
  CONFIRMED_OUTCOME_SCORING_ENABLED: 'true',
};
const CLEARED = ['REPID_CONFIRMED_RECEIPT_TTL_HOURS', 'GROUNDING_MODE'];
const SAVED: Record<string, string | undefined> = {};
const WRONG = -55; // lossBase - confidenceLossWeight: the receipt-backed confident wrong

let now = Date.parse('2026-10-14T12:00:00.000Z');
const H = (n: number): string => '0x' + n.toString(16).padStart(64, '0');

/** A kernel_receipts row SEALED BY THE REAL GATE (tests/helpers/sealed-gate-receipt.ts); `over` tampers columns. */
async function receipt(id: string, over: Row = {}): Promise<Row> {
  const r = await sealedRow(id, AGENT, { args_hash: H(1), ...over }, new Date(now - 60_000).toISOString());
  st.receipts.push(r);
  return r;
}

const score = (confirmedOutcome: Row, extra: Row = {}) =>
  updateRepId({ agentId: AGENT, eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome, ...extra } as any);
const lastCo = (): Row => st.events[st.events.length - 1]!['metadata']['confirmed_outcome'];

beforeEach(() => {
  for (const k of [...Object.keys(PINNED), ...CLEARED]) SAVED[k] = process.env[k];
  for (const k of Object.keys(PINNED)) process.env[k] = PINNED[k];
  for (const k of CLEARED) delete process.env[k];
  __resetConfirmedParamsCache();
  __resetSmallGainCapParamsCache();
  now = Date.parse('2026-10-14T12:00:00.000Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  st.agent = { id: AGENT, agent_name: 'TESTAGENT', current_repid: 1000, activity_30d: 5 };
  st.receipts = [];
  st.events = [];
  st.upserts = [];
  st.krReads = 0;
  st.claimAttempts = 0;
  st.eventReads = 0;
  st.budget = new Map();
  st.rpcCalls = 0;
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const k of Object.keys(SAVED)) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  __resetConfirmedParamsCache();
  __resetSmallGainCapParamsCache();
});

describe('(A) SERVER RESULT WINS — a FAILED receipt cannot be skipped or shrunk by the caller', () => {
  // Every row but the last two scored 0 and left the receipt unspent before 2026-10-14.
  it.each([
    ['abstained: true', { abstained: true, settledBy: 'holdout', result: 'wrong' }, {}],
    ["result: 'abstain'", { settledBy: 'holdout', result: 'abstain' }, {}],
    ["settledBy: 'vote'", { settledBy: 'vote', result: 'wrong' }, {}],
    ["result: 'right' (the caller claims a pass)", { settledBy: 'holdout', result: 'right' }, {}],
    ['a settler the server did not report', { settledBy: 'known_answer', result: 'wrong', confidence: 0 }, {}],
    ['rubberStampKnownWrong on a holdout receipt', { settledBy: 'holdout', result: 'wrong', rubberStampKnownWrong: true }, {}],
    ['passUnsupportedByReceipt on a known_answer receipt', { settledBy: 'known_answer', result: 'right', passUnsupportedByReceipt: true }, { settled_by: 'known_answer' }],
    // These two MOVED before, but shrunk: to -8 (fresh-domain band tighten) and to x0.5 / low confidence.
    ['selfReportedMiss + low confidence + a fresh domain', { settledBy: 'holdout', result: 'wrong', selfReportedMiss: true, confidence: 0.05, domain: 'never-seen-before' }, {}],
    ['confidence: 0', { settledBy: 'holdout', result: 'wrong', confidence: 0 }, {}],
  ])('%s → the server wrong is applied in full and the receipt consumed', async (_label, payload, over) => {
    const r = await receipt('fail-1', { verification_status: 'FAILED', args_hash: H(9), ...over });
    const out = await score({ ...payload, confirmationReceiptId: 'fail-1' });
    expect(out.delta).toBe(WRONG);
    expect(out.repIdAfter).toBe(1000 + WRONG);
    expect(r['consumed_at']).toBeTruthy();
    expect(lastCo()['reason']).toBe('confirmed_wrong');
    expect(lastCo()['receipt_consumed']).toBe(true);
  });

  it('a known-answer FAILED receipt the caller flagged as a rubber-stamp takes the heaviest penalty', async () => {
    await receipt('ka-1', { verification_status: 'FAILED', settled_by: 'known_answer', args_hash: H(9) });
    const out = await score({ settledBy: 'known_answer', result: 'wrong', rubberStampKnownWrong: true, confirmationReceiptId: 'ka-1' });
    expect(out.delta).toBe(-120);
  });

  it('a FAILED receipt is spent once: the replay moves nothing', async () => {
    await receipt('fail-1', { verification_status: 'FAILED', args_hash: H(9) });
    expect((await score({ abstained: true, confirmationReceiptId: 'fail-1' })).delta).toBe(WRONG);
    const replay = await score({ settledBy: 'holdout', result: 'wrong', confirmationReceiptId: 'fail-1' });
    expect(replay.delta).toBe(0);
    expect(st.agent['current_repid']).toBe(1000 + WRONG);
  });

  it('a VERIFIED receipt also wins over a caller abstain (abstain is free only with NO receipt)', async () => {
    await receipt('ok-1');
    const out = await score({ abstained: true, domain: 'law', confirmationReceiptId: 'ok-1' });
    expect(out.delta).toBe(5);
  });

  it('control: with NO receipt, abstain is still free and nothing is read or consumed', async () => {
    const out = await score({ abstained: true, settledBy: 'holdout', result: 'wrong' });
    expect(out.delta).toBe(0);
    expect(lastCo()['reason']).toBe('abstain_free');
    expect(st.krReads).toBe(0);
  });
});

describe('(B) CONTENT KEY — the same work under fresh receipt ids pays ONCE', () => {
  it('3 receipts, same subject + args_hash, different ids → one gain; new content still pays', async () => {
    for (const id of ['same-1', 'same-2', 'same-3']) await receipt(id, { args_hash: H(7) });
    await receipt('other-1', { args_hash: H(8) });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Distinct domains so the per-domain cap is not what stops the 2nd and 3rd.
    const a = await score({ settledBy: 'holdout', result: 'right', domain: 'd1', confirmationReceiptId: 'same-1' });
    const b = await score({ settledBy: 'holdout', result: 'right', domain: 'd2', confirmationReceiptId: 'same-2' });
    const c = await score({ settledBy: 'holdout', result: 'right', domain: 'd3', confirmationReceiptId: 'same-3' });
    expect([a.delta, b.delta, c.delta]).toEqual([5, 0, 0]);
    expect(lastCo()['receipt_consumed']).toBe(false);
    expect(warn.mock.calls.some((x) => String(x[0]).includes('content_already_claimed'))).toBe(true);

    const d = await score({ settledBy: 'holdout', result: 'right', domain: 'd4', confirmationReceiptId: 'other-1' });
    expect(d.delta).toBe(5);
    expect(st.agent['current_repid']).toBe(1010);
  });

  it('a FAILED run of already-paid content is still its own wrong (FAILED rows are outside the index)', async () => {
    await receipt('ok-1', { args_hash: H(7) });
    await receipt('fail-1', { args_hash: H(7), verification_status: 'FAILED' });
    expect((await score({ result: 'right', settledBy: 'holdout', domain: 'law', confirmationReceiptId: 'ok-1' })).delta).toBe(5);
    expect((await score({ abstained: true, confirmationReceiptId: 'fail-1' })).delta).toBe(WRONG);
  });

  it('a receipt with no args_hash cannot be de-duplicated, so it confirms nothing', async () => {
    const r = await receipt('nohash', { args_hash: null });
    const out = await score({ settledBy: 'holdout', result: 'right', domain: 'law', confirmationReceiptId: 'nohash' });
    expect(out.delta).toBe(0);
    expect(r['consumed_at']).toBeNull();
    expect(lastCo()['reason']).toBe('confirmation_not_server_verified');
  });

  it('the migration declares exactly the index this fake enforces, with a rollback', () => {
    const sql = readFileSync(join(__dirname, '..', 'migrations', '2026-10-14-kernel-receipts-content-claim.sql'), 'utf8')
      .replace(/\s+/g, ' ').toLowerCase();
    expect(sql).toContain('add column if not exists args_hash text');
    expect(sql).toContain(
      "create unique index if not exists kernel_receipts_one_gain_per_content on public.kernel_receipts (subject_agent_id, args_hash) where consumed_at is not null and verification_status = 'verified';",
    );
    expect(sql).toContain('-- drop index if exists public.kernel_receipts_one_gain_per_content;');
  });
});

describe('(C) the small-gain cap is ON the score path, per calendar UTC day', () => {
  const right = (id: string, domain: string | null) =>
    score({ settledBy: 'holdout', result: 'right', domain, confirmationReceiptId: id });

  it('per-day cap binds across domains; a gain capped to zero claims nothing; the UTC day boundary resets it', async () => {
    now = Date.parse('2026-10-14T23:59:00.000Z');
    for (let i = 1; i <= 4; i++) await receipt(`r${i}`, { args_hash: H(100 + i) });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect((await right('r1', 'a')).delta).toBe(5);
    expect((await right('r2', 'b')).delta).toBe(5);
    const third = await right('r3', 'c');
    expect(third.delta).toBe(2); // 12 - 10
    expect(lastCo()['small_gain_cap']['reason']).toBe('capped_by_budget');

    const held = await right('r4', 'd');
    expect(held.delta).toBe(0);
    expect(lastCo()['small_gain_cap']['reason']).toBe('capped_to_zero_budget_exhausted');
    expect(lastCo()['receipt_consumed']).toBeNull(); // no claim attempted
    expect(st.receipts.find((r) => r['receipt_id'] === 'r4')!['consumed_at']).toBeNull();
    expect(warn.mock.calls.some((x) => String(x[0]).includes('small-gain cap'))).toBe(true);

    now = Date.parse('2026-10-14T23:59:59.999Z'); // still the same UTC day
    expect((await right('r4', 'd')).delta).toBe(0);

    now = Date.parse('2026-10-15T00:00:00.000Z'); // a rolling 24h window would still be exhausted
    expect((await right('r4', 'd')).delta).toBe(5);
    expect(st.agent['current_repid']).toBe(1017);
  });

  it('per-domain cap binds inside one domain, and the domain budget is keyed by domain', async () => {
    for (let i = 1; i <= 3; i++) await receipt(`r${i}`, { args_hash: H(200 + i) });
    expect((await right('r1', 'law')).delta).toBe(5);
    expect((await right('r2', 'law')).delta).toBe(3); // per-domain 8
    expect((await right('r3', 'law')).delta).toBe(0);
    expect((await right('r3', 'tax')).delta).toBe(4); // a fresh domain; the day has 12 - 8 left
  });

  it('a gain with no domain earns nothing (the cap refuses a cross-domain gain) and is not consumed', async () => {
    await receipt('r1');
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await right('r1', null)).delta).toBe(0);
    expect(lastCo()['small_gain_cap']['reason']).toBe('no_domain_no_gain');
    expect(st.receipts[0]!['consumed_at']).toBeNull();
  });

  it('a wrong is not capped and does not consume day budget', async () => {
    await receipt('f1', { verification_status: 'FAILED', args_hash: H(300) });
    await receipt('r1', { args_hash: H(301) });
    expect((await score({ abstained: true, confirmationReceiptId: 'f1' })).delta).toBe(WRONG);
    expect(lastCo()['small_gain_cap']).toBeNull();
    expect((await right('r1', 'law')).delta).toBe(5);
  });
});

describe('(D) EXPIRY — a stale receipt moves nothing and stays unspent', () => {
  it('past the default 72h TTL → no move, no claim attempted', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const r = await receipt('old', { verification_status: 'FAILED', created_at: new Date(now - 73 * 3_600_000).toISOString() });
    const out = await score({ settledBy: 'holdout', result: 'wrong', confirmationReceiptId: 'old' });
    expect(out.delta).toBe(0);
    expect(st.claimAttempts).toBe(0);
    expect(r['consumed_at']).toBeNull();
  });

  it('just inside the TTL still confirms (control)', async () => {
    await receipt('young', { verification_status: 'FAILED', created_at: new Date(now - 71 * 3_600_000).toISOString() });
    expect((await score({ abstained: true, confirmationReceiptId: 'young' })).delta).toBe(WRONG);
  });

  it('REPID_CONFIRMED_RECEIPT_TTL_HOURS is read: 1h expires a 2h-old receipt', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.REPID_CONFIRMED_RECEIPT_TTL_HOURS = '1';
    await receipt('2h', { verification_status: 'FAILED', created_at: new Date(now - 2 * 3_600_000).toISOString() });
    expect((await score({ abstained: true, confirmationReceiptId: '2h' })).delta).toBe(0);
  });

  it('a garbage TTL fails closed, loudly', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.REPID_CONFIRMED_RECEIPT_TTL_HOURS = 'forever';
    await receipt('x', { verification_status: 'FAILED' });
    expect((await score({ abstained: true, confirmationReceiptId: 'x' })).delta).toBe(0);
    expect(err.mock.calls.some((c) => String(c[0]).includes('REPID_CONFIRMED_RECEIPT_TTL_HOURS'))).toBe(true);
  });

  it('an undatable receipt confirms nothing', async () => {
    await receipt('nodate', { verification_status: 'FAILED', created_at: null });
    expect((await score({ abstained: true, confirmationReceiptId: 'nodate' })).delta).toBe(0);
  });
});

describe('(E) FLAG OFF is today', () => {
  it('a FAILED receipt in the body is ignored: -8 for UNSUPPORTED_CLAIM, no receipt or cap read', async () => {
    delete process.env.CONFIRMED_OUTCOME_SCORING_ENABLED;
    await receipt('fail-1', { verification_status: 'FAILED' });
    const out = await score({ abstained: true, confirmationReceiptId: 'fail-1' });
    expect(out.delta).toBe(-8);
    expect(out.confirmedOutcome ?? null).toBeNull();
    expect(st.krReads).toBe(0);
    expect(st.eventReads).toBe(0);
    expect(st.rpcCalls).toBe(0);
    expect(st.events[0]!['metadata']['confirmed_outcome']).toBeNull();
  });
});

describe('(F) GROUNDING_MODE=enforce cannot zero a spent server-settled wrong', () => {
  it('the wrong applies with no groundingEvidence; a gain is still zeroed (grounding is live here)', async () => {
    process.env.GROUNDING_MODE = 'enforce';
    await receipt('f1', { verification_status: 'FAILED', args_hash: H(400) });
    await receipt('r1', { args_hash: H(401) });
    expect((await score({ abstained: true, confirmationReceiptId: 'f1' })).delta).toBe(WRONG);
    expect((await score({ settledBy: 'holdout', result: 'right', domain: 'law', confirmationReceiptId: 'r1' })).delta).toBe(0);
  });
});

describe('(G) the kernel receipt indexer writes the content key', () => {
  it('upserts args_hash from receipt.request.args_hash', async () => {
    const rcpt = {
      header: { receipt_id: 'k-1', receipt_hash: H(1) },
      subject: { agent: { agent_id: AGENT, agent_name: 'TESTAGENT' } },
      request: { args_hash: H(42) },
      verification: { settled_by: 'holdout', verdict_label: 'SETTLED', status: 'VERIFIED', is_simulated: false },
    } as unknown as KernelReceipt;
    await indexKernelReceiptToDb(rcpt);
    expect(st.upserts[0]).toMatchObject({ receipt_id: 'k-1', subject_agent_id: AGENT, args_hash: H(42) });
    expect(st.upserts[0]).not.toHaveProperty('consumed_at'); // a re-index must never clear a spend
  });

  it('writes created_at FROM the signed header, so the column the gate compares is the signed time (XC1 re-attack of #1378)', async () => {
    const rcpt = {
      header: { receipt_id: 'k-2', receipt_hash: H(2), created_at: '2026-10-14T09:30:00.000Z' },
      subject: { agent: { agent_id: AGENT, agent_name: 'TESTAGENT' } },
      request: { args_hash: H(43) },
      verification: { settled_by: 'holdout', verdict_label: 'SETTLED', status: 'FAILED', is_simulated: false },
    } as unknown as KernelReceipt;
    await indexKernelReceiptToDb(rcpt);
    expect(st.upserts[st.upserts.length - 1]).toMatchObject({ receipt_id: 'k-2', created_at: '2026-10-14T09:30:00.000Z' });
  });

  it('signs what it indexes at seal time: a DETACHED engine signature that verifies; the receipt itself is untouched', async () => {
    const { verifyReceiptSignature } = require('../src/services/receipt-signer');
    const rcpt = (await sealedRow('k-2', AGENT, { verification_status: 'FAILED', args_hash: H(43) }))['receipt'] as KernelReceipt;
    const before = JSON.stringify(rcpt);
    await indexKernelReceiptToDb(rcpt);
    const row = st.upserts[st.upserts.length - 1]!;
    expect(row['engine_signature']).toBeTruthy();
    expect(verifyReceiptSignature(row['receipt'], row['engine_signature']).status).toBe('VERIFIED');
    expect(JSON.stringify(row['receipt'])).toBe(before); // kernel-receipt/1 stays byte-identical (header.signer null)
    expect(row['receipt']['header']['signer']).toBeNull();
  });

  it('with no engine key it indexes the row UNSIGNED, and says so', async () => {
    const rcpt = (await sealedRow('k-3', AGENT, { args_hash: H(44) }))['receipt'] as KernelReceipt;
    const key = process.env.RECEIPT_SIGNING_KEY;
    delete process.env.RECEIPT_SIGNING_KEY;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await indexKernelReceiptToDb(rcpt);
    } finally {
      process.env.RECEIPT_SIGNING_KEY = key;
    }
    expect(st.upserts[st.upserts.length - 1]!['engine_signature']).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('indexed UNSIGNED'))).toBe(true);
  });
});
