/**
 * confirmed-failed-settler.test.ts — XC1's re-attack of #1364, finding 3: a FAILED receipt the actor
 * never posts never scored. src/services/failed-receipt-settler.ts applies it server-side through the
 * REAL updateRepId (the same verifier + one-time claim the actor's own post would hit), against an
 * in-memory DB, with receipts minted by the REAL kernel gate.
 *
 * Pinned ruler (same as the other confirmed-outcome suites): a server-settled wrong is -55.
 */
jest.mock('../src/layers/ecosystem-need', () => ({
  getEcosystemNeedWeight: async () => 1.0,
  updateSupplyRate: async () => undefined,
}));
jest.mock('../src/layers/challenge-scoring', () => ({ scoreChallengeOutcome: () => -999 })); // never the vehicle's delta
jest.mock('../src/layers/prediction-scoring', () => ({ scorePrediction: () => 0 }));
jest.mock('../src/layers/decay', () => ({ applyDecay: (r: number) => r, computeRedemptionModifier: async () => 1.0 }));
jest.mock('../src/layers/constitutional-audit', () => ({
  auditConstitutionalCompliance: async () => ({
    enabled: false, passed: null, complianceScore: null, rulesChecked: [],
    halMode: 0, easAttestationId: 'eas-stub', easSchema: 'v1', processingMs: 0, mirrorTestPassed: true,
  }),
}));
jest.mock('../src/engine/badges', () => ({ checkAndAwardBadges: async () => [] }));

type Row = Record<string, any>;
const AGENT = 'agent-1';
const st = {
  agent: { id: AGENT, agent_name: 'TESTAGENT', current_repid: 1000, activity_30d: 5 } as Row,
  receipts: [] as Row[],
  events: [] as Row[],
  settleQueries: 0,
  keysetReads: 0,
  halt: false,
};

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'trinity_system_config') {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { emergency_halt: st.halt }, error: null }) }) }) };
      }
      if (table === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: { ...st.agent }, error: null }), maybeSingle: async () => ({ data: { ...st.agent }, error: null }) }) }),
          update: (p: Row) => ({ eq: async () => { Object.assign(st.agent, p); return { error: null }; } }),
        };
      }
      if (table === 'kernel_receipts') {
        return {
          // Serves both the verifier's .eq('receipt_id').maybeSingle() and the settler's filtered list.
          select: () => {
            const where: Array<(r: Row) => boolean> = [];
            const chain: any = {
              eq: (c: string, v: unknown) => { where.push((r) => r[c] === v); return chain; },
              is: (c: string, v: unknown) => { where.push((r) => (v === null ? r[c] == null : r[c] === v)); return chain; },
              in: (c: string, vs: unknown[]) => { where.push((r) => vs.includes(r[c])); return chain; },
              // .not(col, 'is', null): the settler's "content already settled" probe
              not: (c: string, _op: string, _v: unknown) => { where.push((r) => r[c] != null); return chain; },
              lt: (c: string, v: string) => { where.push((r) => Date.parse(r[c]) < Date.parse(v)); return chain; },
              gt: (c: string, v: string) => { where.push((r) => Date.parse(r[c]) > Date.parse(v)); return chain; },
              // The settler's keyset: created_at.gt."C",and(created_at.eq."C",receipt_id.gt."ID"). Parsed
              // strictly: any other shape throws, so the test fails rather than silently matching all.
              or: (expr: string) => {
                const m = /^created_at\.gt\."([^"]+)",and\(created_at\.eq\."([^"]+)",receipt_id\.gt\."([^"]+)"\)$/.exec(expr);
                if (!m || m[1] !== m[2]) throw new Error(`mock: unexpected or() ${expr}`);
                const t = Date.parse(m[1]!);
                where.push((r) => Date.parse(r['created_at']) > t || (Date.parse(r['created_at']) === t && String(r['receipt_id']) > m[3]!));
                st.keysetReads++;
                return chain;
              },
              order: () => chain,
              limit: async (n: number) => {
                st.settleQueries++;
                const hits = st.receipts.filter((r) => where.every((w) => w(r)))
                  .sort((a, b) => Date.parse(a['created_at']) - Date.parse(b['created_at']) || (String(a['receipt_id']) < String(b['receipt_id']) ? -1 : String(a['receipt_id']) > String(b['receipt_id']) ? 1 : 0));
                return { data: hits.slice(0, n).map((r) => ({ ...r })), error: null };
              },
              maybeSingle: async () => {
                const r = st.receipts.find((x) => where.every((w) => w(x)));
                return { data: r ? { ...r } : null, error: null };
              },
            };
            return chain;
          },
          // claimConfirmationReceipt: UPDATE … WHERE receipt_id AND consumed_at IS NULL RETURNING receipt_id
          update: (p: Row) => {
            const where: Array<(r: Row) => boolean> = [];
            const chain: any = {
              eq: (c: string, v: unknown) => { where.push((r) => r[c] === v); return chain; },
              is: (c: string, v: unknown) => { where.push((r) => (v === null ? r[c] == null : r[c] === v)); return chain; },
              select: async () => {
                const hits = st.receipts.filter((r) => where.every((w) => w(r)));
                for (const r of hits) Object.assign(r, p);
                return { data: hits.map((r) => ({ receipt_id: r['receipt_id'] })), error: null };
              },
            };
            return chain;
          },
        };
      }
      if (table === 'repid_score_events') {
        const noRows: any = { eq: () => noRows, gte: () => noRows, gt: () => noRows, in: () => noRows, then: (ok: any) => Promise.resolve({ data: [], count: 0, error: null }).then(ok) };
        return { insert: async (row: Row) => { st.events.push(row); return { error: null }; }, select: () => noRows };
      }
      throw new Error(`unexpected table ${table}`);
    },
  },
}));

import { settleFailedReceiptsOnce, SETTLE_EVENT_TYPE, __resetSettleCursor } from '../src/services/failed-receipt-settler';
import { updateRepId } from '../src/engine/repid-update';
import { __resetConfirmedParamsCache } from '../src/scoring/confirmed-outcome';
import { sealedRow } from './helpers/sealed-gate-receipt';
import { __resetEmergencyHaltState } from '../src/services/emergency-halt';

const PINNED: Record<string, string> = {
  REPID_CONFIRMED_GAIN_BASE: '5',
  REPID_CONFIRMED_LOSS_BASE: '-15',
  REPID_CONFIRMED_CONFIDENCE_LOSS_WEIGHT: '40',
  REPID_CONFIRMED_RUBBER_STAMP_PENALTY: '-120',
  REPID_CONFIRMED_BAND_TIGHTEN_BASE: '-8',
  REPID_CONFIRMED_SELF_REPORT_MISS_FACTOR: '0.5',
  REPID_CONFIRMED_NEED_WEIGHT_CAP: '2',
  CONFIRMED_OUTCOME_SCORING_ENABLED: 'true',
  CONFIRMED_FAILED_SETTLE_MODE: 'enforce',
};
const CLEARED = ['CONFIRMED_FAILED_SETTLE_AFTER_HOURS', 'CONFIRMED_FAILED_SETTLE_MAX_PER_RUN', 'REPID_CONFIRMED_RECEIPT_TTL_HOURS', 'GROUNDING_MODE'];
const SAVED: Record<string, string | undefined> = {};
const WRONG = -55;
const HOUR = 3_600_000;
let now = Date.parse('2026-10-14T12:00:00.000Z');
const H = (n: number): string => '0x' + n.toString(16).padStart(64, '0');

/** A FAILED receipt sealed by the real gate, indexed `ageHours` ago. */
async function failed(id: string, ageHours: number, over: Row = {}): Promise<Row> {
  const r = await sealedRow(id, AGENT, { verification_status: 'FAILED', args_hash: H(st.receipts.length + 1), ...over }, new Date(now - ageHours * HOUR).toISOString());
  st.receipts.push(r);
  return r;
}
const spent = (id: string) => st.receipts.find((r) => r['receipt_id'] === id)!['consumed_at'] != null;

let warn: jest.SpyInstance;
let err: jest.SpyInstance;
beforeEach(() => {
  for (const k of [...Object.keys(PINNED), ...CLEARED]) SAVED[k] = process.env[k];
  for (const k of Object.keys(PINNED)) process.env[k] = PINNED[k];
  for (const k of CLEARED) delete process.env[k];
  __resetConfirmedParamsCache();
  now = Date.parse('2026-10-14T12:00:00.000Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  st.agent = { id: AGENT, agent_name: 'TESTAGENT', current_repid: 1000, activity_30d: 5 };
  st.receipts = [];
  st.events = [];
  st.settleQueries = 0;
  st.keysetReads = 0;
  st.halt = false;
  __resetEmergencyHaltState();
  __resetSettleCursor();
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const k of Object.keys(SAVED)) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
  __resetConfirmedParamsCache();
});

describe('the actor never presents its FAILED receipt', () => {
  it('after the grace window the server applies the full wrong to the subject and spends the receipt', async () => {
    await failed('f1', 30);
    const out = await settleFailedReceiptsOnce();
    expect(out.applied).toEqual([{ receiptId: 'f1', agentId: AGENT, delta: WRONG }]);
    expect(st.agent['current_repid']).toBe(1000 + WRONG);
    expect(spent('f1')).toBe(true);
    const ev = st.events[0]!;
    expect(ev['event_type']).toBe(SETTLE_EVENT_TYPE);
    expect(ev['metadata']['confirmed_outcome']['reason']).toBe('confirmed_wrong');
    expect(ev['metadata']['confirmed_outcome']['receipt_consumed']).toBe(true);
    expect(warn.mock.calls.some((c) => /\[failed-settle\] enforce: found 1, accepted 1, refused 0, applied 1, held 0/.test(String(c[0])))).toBe(true);
  });

  it('IDEMPOTENT: a second run finds nothing and moves nothing', async () => {
    await failed('f1', 30);
    await settleFailedReceiptsOnce();
    const again = await settleFailedReceiptsOnce();
    expect(again.found).toBe(0);
    expect(again.applied).toEqual([]);
    expect(st.agent['current_repid']).toBe(1000 + WRONG);
    expect(st.events).toHaveLength(1);
  });

  it('IDEMPOTENT under a race: two overlapping runs apply it once', async () => {
    await failed('f1', 30);
    const [a, b] = await Promise.all([settleFailedReceiptsOnce(), settleFailedReceiptsOnce()]);
    expect([a.refused, b.refused]).toContain('already_running');
    expect(a.applied.length + b.applied.length).toBe(1);
    expect(st.agent['current_repid']).toBe(1000 + WRONG);
  });

  it('the actor presenting it AFTER the server settled it is an inert replay', async () => {
    await failed('f1', 30);
    await settleFailedReceiptsOnce();
    const late = await updateRepId({ agentId: AGENT, eventType: 'CHALLENGE_LOSS', confirmedOutcome: { settledBy: 'holdout', result: 'wrong', confirmationReceiptId: 'f1' } });
    expect(late.delta).toBe(0);
    expect(st.agent['current_repid']).toBe(1000 + WRONG);
  });

  it('the actor that DID present it first is not charged twice by the worker', async () => {
    await failed('f1', 30);
    const own = await updateRepId({ agentId: AGENT, eventType: 'CHALLENGE_LOSS', confirmedOutcome: { settledBy: 'holdout', result: 'wrong', confirmationReceiptId: 'f1' } });
    expect(own.delta).toBe(WRONG);
    const run = await settleFailedReceiptsOnce();
    expect(run.found).toBe(0);
    expect(st.agent['current_repid']).toBe(1000 + WRONG);
  });
});

describe('ONE WRONG PER SIGNED RECEIPT, VERIFIER FIRST (XC1 review of #1374)', () => {
  /** A FAILED row the verifier must refuse, older than the real one, sharing the victim's content key. */
  async function decoy(id: string, ageHours: number, kind: 'unsigned' | 'copied_signature', over: Row = {}): Promise<Row> {
    const donor = await sealedRow(`${id}-donor`, AGENT, { verification_status: 'FAILED', args_hash: H(900) });
    const r = await sealedRow(id, AGENT, { verification_status: 'FAILED', args_hash: H(500), ...over }, new Date(now - ageHours * HOUR).toISOString());
    r['engine_signature'] = kind === 'unsigned' ? null : donor['engine_signature']; // a real signature, of other bytes
    st.receipts.push(r);
    return r;
  }

  it.each(['unsigned', 'copied_signature'] as const)(
    'a %s decoy in front of a signed wrong with the same subject + args_hash: the signed wrong still applies',
    async (kind) => {
      await decoy('decoy', 40, kind);
      await failed('real', 35, { args_hash: H(500) });
      const out = await settleFailedReceiptsOnce();
      expect(out.applied).toEqual([{ receiptId: 'real', agentId: AGENT, delta: WRONG }]);
      // an unsigned row never enters the scan; a signed-but-wrong one is read and refused
      expect(out.held).toEqual(kind === 'unsigned' ? [] : [{ receiptId: 'decoy', agentId: AGENT, why: expect.stringMatching(/^verifier_refuses:/) }]);
      expect(spent('real')).toBe(true);
      expect(spent('decoy')).toBe(false);
      expect(st.agent['current_repid']).toBe(1000 + WRONG);
      // A refused row writes no audit row: only the real wrong did.
      expect(st.events).toHaveLength(1);
    },
  );

  it('a PRE-CONSUMED decoy with the victim\'s content suppresses nothing (settler and actor alike)', async () => {
    await decoy('decoy', 40, 'unsigned', { consumed_at: new Date(now - 39 * HOUR).toISOString() });
    await failed('real', 35, { args_hash: H(500) });
    await failed('real-2', 34, { args_hash: H(500) });
    const own = await updateRepId({ agentId: AGENT, eventType: 'CHALLENGE_LOSS', confirmedOutcome: { settledBy: 'holdout', result: 'wrong', confirmationReceiptId: 'real-2' } });
    expect(own.delta).toBe(WRONG);
    const out = await settleFailedReceiptsOnce();
    expect(out.applied.map((a) => a.receiptId)).toEqual(['real']);
    expect(st.agent['current_repid']).toBe(1000 + 2 * WRONG);
  });

  it('two SIGNED FAILED receipts with the same args_hash are two wrongs: each is its own kernel decision', async () => {
    await failed('w-1', 40, { args_hash: H(600) });
    await failed('w-2', 35, { args_hash: H(600) });
    const out = await settleFailedReceiptsOnce();
    expect(out.applied.map((a) => a.receiptId)).toEqual(['w-1', 'w-2']);
    expect(st.agent['current_repid']).toBe(1000 + 2 * WRONG);
  });

  it('a batch FULL of decoys in front cannot starve it: MAX_PER_RUN counts accepted rows, not rows read', async () => {
    process.env.CONFIRMED_FAILED_SETTLE_MAX_PER_RUN = '2';
    for (let i = 0; i < 5; i++) await decoy(`decoy-${i}`, 40 + i, 'copied_signature');
    await failed('real', 30, { args_hash: H(500) });
    const out = await settleFailedReceiptsOnce();
    expect(out.found).toBe(6);
    expect(out.accepted).toBe(1);
    expect(out.applied.map((a) => a.receiptId)).toEqual(['real']);
    expect(out.scanBudgetSpent).toBeUndefined();
  });

  it('UNSIGNED decoys never enter the scan: 20 of them stamped oldest cannot fill it (XC1 re-attack of #1378)', async () => {
    process.env.CONFIRMED_FAILED_SETTLE_MAX_PER_RUN = '1'; // scan budget = 20 rows
    for (let i = 0; i < 20; i++) await decoy(`decoy-${i}`, 40 + i * 0.1, 'unsigned');
    await failed('real', 30, { args_hash: H(500) });
    const out = await settleFailedReceiptsOnce();
    expect(out.found).toBe(1);
    expect(out.applied.map((a) => a.receiptId)).toEqual(['real']);
    expect(out.scanBudgetSpent).toBeUndefined();
  });

  /** Runs ticks until `real` is applied or `max` ticks pass; returns the 1-based tick it landed on, or null. */
  async function ticksUntilApplied(id: string, max: number): Promise<{ tick: number | null; runs: Awaited<ReturnType<typeof settleFailedReceiptsOnce>>[] }> {
    const runs = [];
    for (let t = 1; t <= max; t++) {
      const out = await settleFailedReceiptsOnce();
      runs.push(out);
      if (out.applied.some((a) => a.receiptId === id)) return { tick: t, runs };
    }
    return { tick: null, runs };
  }

  it('N garbage-signed rows older than a valid wrong cannot pin the window: it is applied within K = ceil(N / budget) ticks (XC1 re-attack of #1384)', async () => {
    process.env.CONFIRMED_FAILED_SETTLE_MAX_PER_RUN = '1'; // budget = 20 rows per tick
    for (let i = 0; i < 50; i++) await decoy(`decoy-${String(i).padStart(2, '0')}`, 40 + i * 0.1, 'copied_signature');
    await failed('real', 30, { args_hash: H(500) });
    const { tick, runs } = await ticksUntilApplied('real', 5);
    expect(tick).toBe(3); // 20 + 20 refused, then 10 refused + the real wrong
    expect(runs.map((r) => r.found)).toEqual([20, 20, 11]);
    expect(runs[0]!.scanBudgetSpent).toBe(true);
    expect(st.keysetReads).toBe(2); // ticks 2 and 3 read AFTER the cursor
    expect(err.mock.calls.some((c) => /SCAN BUDGET SPENT: read 20 candidate FAILED receipts, 20 refused .* the next tick continues after/.test(String(c[0])))).toBe(true);
    expect(st.agent['current_repid']).toBe(1000 + WRONG);
  });

  it('garbage rows sharing ONE timestamp cannot stall the cursor: (created_at, receipt_id) breaks the tie', async () => {
    process.env.CONFIRMED_FAILED_SETTLE_MAX_PER_RUN = '1';
    for (let i = 0; i < 45; i++) await decoy(`decoy-${String(i).padStart(2, '0')}`, 40, 'copied_signature'); // all at one instant
    await failed('real', 30, { args_hash: H(500) });
    expect((await ticksUntilApplied('real', 5)).tick).toBe(3);
  });

  it('once the window is read to its end the cursor wraps, so a refused row is reconsidered later', async () => {
    await decoy('decoy', 40, 'copied_signature');
    await failed('real', 30, { args_hash: H(500) });
    const out = await settleFailedReceiptsOnce();
    expect(out.applied.map((a) => a.receiptId)).toEqual(['real']);
    expect(out.nextCursor).toBeNull(); // a short page read to its end: next tick starts from the oldest row
  });

  it.each([
    ['an EXPIRED signed wrong stamped fresh', 80, 30],
    ['a signed wrong still inside its grace stamped old', 2, 30],
  ])('the created_at COLUMN is not the clock: %s is refused (XC1 re-attack of #1378)', async (_why, signedAgeH, columnAgeH) => {
    const r = await failed('restamped', signedAgeH);
    r['created_at'] = new Date(now - columnAgeH * HOUR).toISOString(); // the service-role edit
    const out = await settleFailedReceiptsOnce();
    expect(out.found).toBe(1);
    expect(out.applied).toEqual([]);
    expect(out.held).toEqual([{ receiptId: 'restamped', agentId: AGENT, why: expect.stringMatching(/^verifier_refuses:/) }]);
    expect(spent('restamped')).toBe(false);
    expect(st.agent['current_repid']).toBe(1000);
  });

  it('SHADOW = ENFORCE: on the same rows, what shadow would apply is exactly what enforce applies', async () => {
    await decoy('decoy', 45, 'unsigned');
    await decoy('decoy-copy', 44, 'copied_signature');
    await failed('a', 40, { args_hash: H(500) });
    await failed('b', 38, { args_hash: H(500) }); // same content: its own wrong
    await failed('c', 34);
    process.env.CONFIRMED_FAILED_SETTLE_MODE = 'shadow';
    const shadow = await settleFailedReceiptsOnce();
    const would = shadow.held.filter((h) => h.why === 'shadow_would_apply').map((h) => h.receiptId);
    expect(st.events).toHaveLength(0);
    process.env.CONFIRMED_FAILED_SETTLE_MODE = 'enforce';
    const enforce = await settleFailedReceiptsOnce();
    expect(enforce.applied.map((a) => a.receiptId)).toEqual(would);
    expect(would).toEqual(['a', 'b', 'c']);
    expect(shadow.accepted).toBe(enforce.accepted);
    const refused = (s: typeof shadow) => s.held.filter((h) => h.why.startsWith('verifier_refuses:')).map((h) => h.receiptId);
    expect(refused(enforce)).toEqual(refused(shadow));
    expect(refused(shadow)).toEqual(['decoy-copy']); // the unsigned decoy never entered either scan
  });

  it('no migration puts a UNIQUE index over FAILED rows (Postgres cannot check the signature that would make it safe)', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const root = path.join(__dirname, '..');
    const offenders: string[] = [];
    for (const dir of ['migrations', path.join('supabase', 'migrations')]) {
      for (const f of fs.readdirSync(path.join(root, dir)).filter((n: string) => n.endsWith('.sql'))) {
        const sql = fs.readFileSync(path.join(root, dir, f), 'utf8').split(/\r?\n/).filter((l: string) => !l.trim().startsWith('--')).join('\n');
        if (/create\s+unique\s+index[^;]*verification_status\s*=\s*'FAILED'/i.test(sql)) offenders.push(`${dir}/${f}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('what the worker leaves alone', () => {
  it('inside the grace window (the actor still has its turn)', async () => {
    await failed('young', 2);
    const out = await settleFailedReceiptsOnce();
    expect(out.found).toBe(0);
    expect(spent('young')).toBe(false);
  });

  it('past the receipt TTL (the verifier would refuse it anyway)', async () => {
    await failed('old', 80); // default TTL 72h
    expect((await settleFailedReceiptsOnce()).found).toBe(0);
  });

  it('a VERIFIED receipt (a gain is the actor\'s to claim, never the worker\'s)', async () => {
    await failed('ok', 30, { verification_status: 'VERIFIED' });
    expect((await settleFailedReceiptsOnce()).found).toBe(0);
  });

  it('a row that is not a sealed gate receipt: found by the query, refused by the verifier, not spent', async () => {
    st.receipts.push({
      receipt_id: 'hand', subject_agent_id: AGENT, settled_by: 'holdout', verdict_label: 'SETTLED',
      verification_status: 'FAILED', is_simulated: false, args_hash: H(99), consumed_at: null,
      created_at: new Date(now - 30 * HOUR).toISOString(),
      engine_signature: { forged: true }, // non-null, so it reaches the verifier (unsigned rows never enter the scan)
    });
    const out = await settleFailedReceiptsOnce();
    expect(out.found).toBe(1);
    expect(out.applied).toEqual([]);
    expect(out.held[0]!.why).toMatch(/^verifier_refuses:/);
    expect(st.agent['current_repid']).toBe(1000);
    expect(spent('hand')).toBe(false);
  });

  it('caps one run at CONFIRMED_FAILED_SETTLE_MAX_PER_RUN, oldest first; the rest wait for the next run', async () => {
    process.env.CONFIRMED_FAILED_SETTLE_MAX_PER_RUN = '2';
    await failed('a', 40);
    await failed('b', 35);
    await failed('c', 30);
    const first = await settleFailedReceiptsOnce();
    expect(first.applied.map((x) => x.receiptId)).toEqual(['a', 'b']);
    const second = await settleFailedReceiptsOnce();
    expect(second.applied.map((x) => x.receiptId)).toEqual(['c']);
  });
});

describe('modes and refusals', () => {
  it('OFF (the default) reads nothing', async () => {
    delete process.env.CONFIRMED_FAILED_SETTLE_MODE;
    await failed('f1', 30);
    const out = await settleFailedReceiptsOnce();
    expect(out.refused).toBe('mode_off');
    expect(st.settleQueries).toBe(0);
    expect(spent('f1')).toBe(false);
  });

  it('the global EMERGENCY HALT parks it: nothing read, nothing applied, the receipt waits', async () => {
    st.halt = true;
    await failed('f1', 30);
    const out = await settleFailedReceiptsOnce();
    expect(out.refused).toBe('emergency_halt');
    expect(st.settleQueries).toBe(0);
    expect(spent('f1')).toBe(false);
    expect(st.agent['current_repid']).toBe(1000);
  });

  it('SHADOW runs the same gate: a row the verifier would refuse is NOT logged as would-apply', async () => {
    process.env.CONFIRMED_FAILED_SETTLE_MODE = 'shadow';
    st.receipts.push({
      receipt_id: 'hand', subject_agent_id: AGENT, settled_by: 'holdout', verdict_label: 'SETTLED',
      verification_status: 'FAILED', is_simulated: false, args_hash: H(98), consumed_at: null,
      created_at: new Date(now - 30 * HOUR).toISOString(),
      engine_signature: { forged: true }, // non-null, so it reaches the verifier (unsigned rows never enter the scan)
    });
    const out = await settleFailedReceiptsOnce();
    expect(out.held).toEqual([{ receiptId: 'hand', agentId: AGENT, why: expect.stringMatching(/^verifier_refuses:/) }]);
    expect(warn.mock.calls.some((c) => /SHADOW: WOULD apply FAILED receipt hand/.test(String(c[0])))).toBe(false);
    expect(out.accepted).toBe(0);
    expect(spent('hand')).toBe(false);
  });

  it('SHADOW logs what it WOULD apply and moves nothing', async () => {
    process.env.CONFIRMED_FAILED_SETTLE_MODE = 'shadow';
    await failed('f1', 30);
    const out = await settleFailedReceiptsOnce();
    expect(out.found).toBe(1);
    expect(out.applied).toEqual([]);
    expect(warn.mock.calls.some((c) => /SHADOW: WOULD apply FAILED receipt f1 .* to agent agent-1/.test(String(c[0])))).toBe(true);
    expect(st.agent['current_repid']).toBe(1000);
    expect(spent('f1')).toBe(false);
    expect(st.events).toHaveLength(0);
  });

  it('ENFORCE with CONFIRMED_OUTCOME_SCORING_ENABLED off refuses, loudly (the vehicle\'s own delta must never apply)', async () => {
    delete process.env.CONFIRMED_OUTCOME_SCORING_ENABLED;
    await failed('f1', 30);
    const out = await settleFailedReceiptsOnce();
    expect(out.refused).toBe('confirmed_scoring_off');
    expect(err.mock.calls.some((c) => String(c[0]).includes('enforce needs CONFIRMED_OUTCOME_SCORING_ENABLED=true'))).toBe(true);
    expect(st.agent['current_repid']).toBe(1000);
    expect(spent('f1')).toBe(false);
  });

  it.each([
    ['CONFIRMED_FAILED_SETTLE_AFTER_HOURS', 'soon', 'bad_knob'],
    ['CONFIRMED_FAILED_SETTLE_MAX_PER_RUN', '2.5', 'bad_knob'],
    ['CONFIRMED_FAILED_SETTLE_AFTER_HOURS', '72', 'grace_not_under_ttl'],
  ])('%s=%s refuses the run (%s) instead of guessing', async (k, v, why) => {
    process.env[k] = v;
    await failed('f1', 30);
    expect((await settleFailedReceiptsOnce()).refused).toBe(why);
    expect(spent('f1')).toBe(false);
  });
});
