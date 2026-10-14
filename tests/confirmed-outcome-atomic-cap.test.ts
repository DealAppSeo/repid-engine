/**
 * confirmed-outcome-atomic-cap.test.ts — XC1's re-attack of #1364 (2026-10-14), findings 1, 4 and 5,
 * driven through the REAL updateRepId with CONFIRMED_OUTCOME_SCORING_ENABLED on, against an in-memory
 * DB. Each block goes RED with its fix reverted:
 *
 *   (1) ATOMIC CAP. A PARALLEL burst of N confirmed gains spends at most the day cap (and at most the
 *       domain cap inside one domain). Before: each call read today's sum from repid_score_events, and
 *       every read landed before any insert, so each took a full gain (10 x 5 against a cap of 12).
 *       Now the claim and the reservation are one call to public.claim_confirmed_gain, modelled in
 *       tests/helpers/fake-claim-confirmed-gain.ts. With the function absent a gain is ZERO, loudly.
 *   (2) DOMAIN KEY. `Law`, ` law `, `l<ZWSP>aw` and fullwidth `ＬＡＷ` share the `law` budget.
 *   (3) REDEMPTION. The REAL computeRedemptionModifier (only applyDecay is stubbed) returns 0.5 for an
 *       agent with a violation and prosocial history. A receipt-settled wrong still costs the full -55;
 *       an ordinary penalty for the same agent is still halved (the control that proves the 0.5 is live).
 *
 * Magnitudes are PINNED test values, the same ruler as confirmed-outcome-hardening.test.ts:
 *   gain 5, a server-settled wrong -55, per-day cap 12, per-domain cap 8, redemption modifier 0.5.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../src/layers/ecosystem-need', () => ({
  getEcosystemNeedWeight: async () => 1.0,
  updateSupplyRate: async () => undefined,
}));
jest.mock('../src/layers/challenge-scoring', () => ({ scoreChallengeOutcome: () => 0 }));
jest.mock('../src/layers/prediction-scoring', () => ({ scorePrediction: () => 0 }));
// REAL computeRedemptionModifier; only decay is held still so the numbers stay readable.
jest.mock('../src/layers/decay', () => ({
  ...jest.requireActual('../src/layers/decay'),
  applyDecay: (repid: number) => repid,
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
  budget: new Map<string, number>(),
  rpcArgs: [] as Row[],
  rpcDown: false,
  sumReads: 0, // non-count reads of repid_score_events: the old stale-sum budget reader
  violations: 0,
  prosocial: 0,
};

function col(row: Row, path: string): unknown {
  let v: any = row;
  for (const k of path.split(/->>?/)) v = v == null ? undefined : v[k];
  return path.includes('->>') ? (v == null ? null : String(v)) : v;
}

jest.mock('../src/db', () => ({
  db: {
    rpc: async (fn: string, args: any) => {
      if (st.rpcDown) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.claim_confirmed_gain' } };
      return require('./helpers/fake-claim-confirmed-gain').fakeRpc(() => st.receipts, st.budget, (a: Row) => st.rpcArgs.push(a))(fn, args);
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
                const r = st.receipts.find((x) => x['receipt_id'] === id);
                return { data: r ? { ...r } : null, error: null };
              },
            }),
          }),
          // claimConfirmationReceipt (wrongs; and every claim before this PR): UPDATE … WHERE receipt_id
          // AND consumed_at IS NULL, with the partial unique content index.
          update: (p: Row) => {
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
                    return { data: null, error: { code: '23505', message: 'duplicate key' } };
                  }
                }
                for (const r of hits) Object.assign(r, p);
                return { data: hits.map((r) => ({ receipt_id: r['receipt_id'] })), error: null };
              },
            };
            return chain;
          },
        };
      }
      if (table === 'repid_score_events') {
        return {
          insert: async (row: Row) => { st.events.push({ ...row, created_at: new Date(Date.now()).toISOString() }); return { error: null }; },
          select: (_cols: string, opts?: { head?: boolean }) => {
            // computeRedemptionModifier: select('id', {count:'exact', head:true}).eq().in('event_type', …).gte()
            if (opts?.head) {
              let violationsQuery = false;
              const chain: any = {
                eq: () => chain,
                gte: () => chain,
                in: (_c: string, types: string[]) => { violationsQuery = types.includes('EPISTEMIC_VIOLATION'); return chain; },
                then: (ok: (x: unknown) => unknown, ko?: (e: unknown) => unknown) =>
                  Promise.resolve({ count: violationsQuery ? st.violations : st.prosocial, error: null }).then(ok, ko),
              };
              return chain;
            }
            // The pre-PR stale-sum budget reader. Kept so a REVERTED engine runs and overshoots, not crashes.
            st.sumReads++;
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
import { __resetSmallGainCapParamsCache, normalizeCapDomain } from '../src/scoring/small-gain-cap';
import { __resetScoringParamsCache } from '../src/config/scoring-params';

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
  REPID_REDEMPTION_MODIFIER: '0.5',
  REPID_REDEMPTION_PROSOCIAL_THRESHOLD: '1',
  REPID_REDEMPTION_WINDOW_DAYS: '30',
  CONFIRMED_OUTCOME_SCORING_ENABLED: 'true',
};
const CLEARED = ['REPID_CONFIRMED_RECEIPT_TTL_HOURS', 'GROUNDING_MODE'];
const SAVED: Record<string, string | undefined> = {};
const WRONG = -55;
const DAY_CAP = 12;
const DOMAIN_CAP = 8;

let now = Date.parse('2026-10-14T12:00:00.000Z');
const H = (n: number): string => '0x' + n.toString(16).padStart(64, '0');

function receipt(id: string, over: Row = {}): Row {
  const r: Row = {
    receipt_id: id, subject_agent_id: AGENT, settled_by: 'holdout', verdict_label: 'SETTLED',
    verification_status: 'VERIFIED', is_simulated: false, args_hash: H(1),
    created_at: new Date(now - 60_000).toISOString(), consumed_at: null, ...over,
  };
  st.receipts.push(r);
  return r;
}
const right = (id: string, domain: string | null) =>
  updateRepId({ agentId: AGENT, eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome: { settledBy: 'holdout', result: 'right', domain, confirmationReceiptId: id } } as any);
const co = (i: number): Row => st.events[i]!['metadata']['confirmed_outcome'];

beforeEach(() => {
  for (const k of [...Object.keys(PINNED), ...CLEARED]) SAVED[k] = process.env[k];
  for (const k of Object.keys(PINNED)) process.env[k] = PINNED[k];
  for (const k of CLEARED) delete process.env[k];
  __resetConfirmedParamsCache();
  __resetSmallGainCapParamsCache();
  __resetScoringParamsCache();
  now = Date.parse('2026-10-14T12:00:00.000Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  st.agent = { id: AGENT, agent_name: 'TESTAGENT', current_repid: 1000, activity_30d: 5 };
  st.receipts = [];
  st.events = [];
  st.budget = new Map();
  st.rpcArgs = [];
  st.rpcDown = false;
  st.sumReads = 0;
  st.violations = 0;
  st.prosocial = 0;
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const k of Object.keys(SAVED)) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  __resetConfirmedParamsCache();
  __resetSmallGainCapParamsCache();
  __resetScoringParamsCache();
});

describe('(1) ATOMIC CAP — a parallel burst cannot outrun the day or domain budget', () => {
  it('10 parallel gains, 10 receipts, 10 domains → at most the day cap in total', async () => {
    for (let i = 0; i < 10; i++) receipt(`p${i}`, { args_hash: H(500 + i) });
    const out = await Promise.all(Array.from({ length: 10 }, (_, i) => right(`p${i}`, `d${i}`)));
    const paid = out.reduce((s, r) => s + r.delta, 0);
    expect(paid).toBeLessThanOrEqual(DAY_CAP);
    expect(paid).toBe(DAY_CAP); // and the cap is actually reached, not just respected by paying nothing
    // only the receipts that were paid are spent; the rest stay spendable on a later day
    expect(st.receipts.filter((r) => r['consumed_at'] != null)).toHaveLength(out.filter((r) => r.delta > 0).length);
  });

  it('10 parallel gains in ONE domain → at most the domain cap', async () => {
    for (let i = 0; i < 10; i++) receipt(`q${i}`, { args_hash: H(600 + i) });
    const out = await Promise.all(Array.from({ length: 10 }, (_, i) => right(`q${i}`, 'law')));
    expect(out.reduce((s, r) => s + r.delta, 0)).toBe(DOMAIN_CAP);
  });

  it('the gain path never reads a budget sum outside the reservation', async () => {
    receipt('r1');
    expect((await right('r1', 'law')).delta).toBe(5);
    expect(st.sumReads).toBe(0);
    expect(st.rpcArgs).toHaveLength(1);
  });

  it('function absent → a gain is ZERO, the receipt is NOT spent, and it says so loudly; a wrong still applies', async () => {
    st.rpcDown = true;
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const ok = receipt('r1');
    receipt('f1', { verification_status: 'FAILED', args_hash: H(9) });

    const gain = await right('r1', 'law');
    expect(gain.delta).toBe(0);
    expect(ok['consumed_at']).toBeNull();
    expect(co(0)['small_gain_cap']['reason']).toBe('reservation_unavailable');
    expect(co(0)['receipt_consumed']).toBe(false);
    expect(err.mock.calls.some((c) => String(c[0]).includes('2026-10-14-confirmed-gain-atomic-reservation.sql'))).toBe(true);

    const wrong = await updateRepId({ agentId: AGENT, eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome: { abstained: true, confirmationReceiptId: 'f1' } } as any);
    expect(wrong.delta).toBe(WRONG);
  });

  it('the engine calls the function with exactly the parameters the migration declares', async () => {
    receipt('r1');
    await right('r1', 'law');
    const sql = readFileSync(join(__dirname, '..', 'migrations', '2026-10-14-confirmed-gain-atomic-reservation.sql'), 'utf8');
    const sig = sql.match(/CREATE OR REPLACE FUNCTION public\.claim_confirmed_gain\(([\s\S]*?)\)\s*RETURNS/)![1]!;
    const declared = [...sig.matchAll(/(p_\w+)\s+(text|integer)/g)].map((m) => m[1]).sort();
    expect(Object.keys(st.rpcArgs[0]!).sort()).toEqual(declared);
    expect(st.rpcArgs[0]).toMatchObject({ p_receipt_id: 'r1', p_agent_id: AGENT, p_domain: 'law', p_gain: 5, p_day_cap: 12, p_domain_cap: 8 });
  });

  it('the migration is review-only and takes the lock before the claim (string pin; NOT proof it runs)', () => {
    const sql = readFileSync(join(__dirname, '..', 'migrations', '2026-10-14-confirmed-gain-atomic-reservation.sql'), 'utf8');
    const body = sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
    expect(body.trim().startsWith('begin;')).toBe(true);
    expect(body.trim().endsWith('rollback;')).toBe(true);
    const lockAt = body.indexOf("b.budget_domain = '' for update");
    const claimAt = body.indexOf('update kernel_receipts k set consumed_at = now()');
    const bookAt = body.indexOf('update confirmed_gain_budget b set spent = b.spent + v_grant');
    expect(lockAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(lockAt);
    expect(bookAt).toBeGreaterThan(claimAt);
    expect(body).toContain("k.subject_agent_id = p_agent_id and k.verification_status = 'verified' and k.consumed_at is null");
    expect(body).toContain('exception when unique_violation');
    expect(body).toContain('check (spent >= 0)');
    expect(body).toContain('revoke all on function public.claim_confirmed_gain(text, text, text, integer, integer, integer) from public, anon, authenticated;');
    expect(body).toContain('grant execute on function public.claim_confirmed_gain(text, text, text, integer, integer, integer) to service_role;');
  });
});

describe('(2) DOMAIN KEY — spelling variants share one per-domain budget', () => {
  it.each([
    ['Law', 'law'],
    ['  law  ', 'law'],
    ['l​aw', 'law'],
    ['﻿LAW‍', 'law'],
    ['ＬＡＷ', 'law'], // fullwidth
    ['Tax  Law', 'tax law'],
    ['​‌', null],
    ['   ', null],
    [42, null],
  ])('normalizeCapDomain(%j) → %j', (raw, key) => {
    expect(normalizeCapDomain(raw)).toBe(key);
  });

  it('law, Law, l<ZWSP>aw and ＬＡＷ draw on ONE budget; a real second domain still gets its share', async () => {
    for (let i = 1; i <= 5; i++) receipt(`v${i}`, { args_hash: H(700 + i) });
    expect((await right('v1', 'law')).delta).toBe(5);
    expect((await right('v2', 'Law')).delta).toBe(3); // 8 - 5, not a fresh budget of 8
    expect((await right('v3', 'l​aw')).delta).toBe(0);
    expect((await right('v4', 'ＬＡＷ')).delta).toBe(0);
    expect(co(1)['small_gain_cap']['domain']).toBe('law');
    expect((await right('v5', 'tax')).delta).toBe(4); // the day has 12 - 8 left
  });
});

describe('(3) REDEMPTION — a receipt-settled wrong is not redeemable', () => {
  beforeEach(() => { st.violations = 1; st.prosocial = 5; }); // qualifies for the real modifier

  it('control: the REAL modifier is 0.5 for this agent, and halves an ordinary penalty', async () => {
    const out = await updateRepId({ agentId: AGENT, eventType: 'UNSUPPORTED_CLAIM' } as any); // FIXED_DELTAS -8
    expect(out.delta).toBe(-4);
    expect(st.events[0]!['metadata']['redemptionModifier']).toBe(0.5);
    expect(st.events[0]!['metadata']['redemptionModifierApplied']).toBe(true);
  });

  it('the same agent pays the FULL server-settled wrong: -55, not -27', async () => {
    receipt('f1', { verification_status: 'FAILED', args_hash: H(9) });
    const out = await updateRepId({ agentId: AGENT, eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome: { abstained: true, confirmationReceiptId: 'f1' } } as any);
    expect(out.delta).toBe(WRONG);
    expect(out.repIdAfter).toBe(1000 + WRONG);
    const m = st.events[0]!['metadata'];
    expect(m['redemptionModifier']).toBe(0.5);
    expect(m['redemptionModifierApplied']).toBe(false);
    expect(m['redemptionExemptReason']).toBe('receipt_settled_wrong');
  });

  it('a fresh agent (no violations) pays the same -55: the exemption changes nothing for it', async () => {
    st.violations = 0;
    receipt('f1', { verification_status: 'FAILED', args_hash: H(9) });
    const out = await updateRepId({ agentId: AGENT, eventType: 'UNSUPPORTED_CLAIM', confirmedOutcome: { abstained: true, confirmationReceiptId: 'f1' } } as any);
    expect(out.delta).toBe(WRONG);
    expect(st.events[0]!['metadata']['redemptionModifier']).toBe(1);
  });
});
