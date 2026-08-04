/**
 * Tests for src/observability/stall-signals.ts
 *
 * Three of these are not tests of behaviour but of RESTRAINT, and they matter
 * more than the rest:
 *   - the module has no write path,
 *   - the module mounts nothing,
 *   - the module emits no per-row identifier.
 * Each was a real failure mode in this repo's history, and each is trivially
 * reintroduced by a well-meaning follow-up patch. Asserting them makes the
 * reintroduction deliberate.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  assembleReport,
  assessExchanges,
  assessLivenessSource,
  assessRouting,
  assessSettlementCounting,
  assessSourceFreshness,
  assessWorkQueue,
  classifyThroughput,
  collectFacts,
  formatReport,
  hoursSince,
  type BoundedReader,
  type StallSignalFacts,
} from '../src/observability/stall-signals';

const SOURCE_PATH = path.join(__dirname, '..', 'src', 'observability', 'stall-signals.ts');
const SOURCE = fs.readFileSync(SOURCE_PATH, 'utf8');

/* ── the discriminator ──────────────────────────────────────────────────── */

describe('classifyThroughput — separating "zero because idle" from "zero because broken"', () => {
  it('calls it HEALTHY when work completed, regardless of backlog', () => {
    const v = classifyThroughput({
      observedInWindow: 5,
      backlog: 900,
      hoursSinceLast: 0.2,
      windowHours: 24,
    });
    expect(v.determination).toBe('HEALTHY');
  });

  it('calls zero-output-with-empty-backlog IDLE, not broken', () => {
    const v = classifyThroughput({
      observedInWindow: 0,
      backlog: 0,
      hoursSinceLast: 300,
      windowHours: 24,
    });
    expect(v.determination).toBe('IDLE');
    expect(v.why).toMatch(/nothing was waiting/);
  });

  it('calls zero-output-with-a-backlog STALLED', () => {
    const v = classifyThroughput({
      observedInWindow: 0,
      backlog: 12,
      hoursSinceLast: 30,
      windowHours: 24,
    });
    expect(v.determination).toBe('STALLED');
    expect(v.why).toMatch(/not being served/);
  });

  it('refuses to guess when no demand signal exists', () => {
    const v = classifyThroughput({
      observedInWindow: 0,
      backlog: null,
      hoursSinceLast: 37.6,
      windowHours: 24,
    });
    expect(v.determination).toBe('INDETERMINATE');
    expect(v.why).toMatch(/indistinguishable/);
  });

  it('produces the SAME determination for the identical counters — age never flips idle to broken', () => {
    // The tempting heuristic: "it has been quiet for a month, that must be broken."
    // A month-empty queue is still just empty. This is a false-alarm generator on
    // healthy low-traffic systems and is deliberately not implemented.
    const recent = classifyThroughput({
      observedInWindow: 0,
      backlog: 0,
      hoursSinceLast: 1,
      windowHours: 24,
    });
    const ancient = classifyThroughput({
      observedInWindow: 0,
      backlog: 0,
      hoursSinceLast: 24 * 90,
      windowHours: 24,
    });
    expect(ancient.determination).toBe(recent.determination);
  });

  it('handles a source that has never produced anything', () => {
    const v = classifyThroughput({
      observedInWindow: 0,
      backlog: null,
      hoursSinceLast: null,
      windowHours: 24,
    });
    expect(v.determination).toBe('INDETERMINATE');
    expect(v.why).toMatch(/never been a recorded observation/);
  });
});

/* ── source freshness ───────────────────────────────────────────────────── */

describe('assessSourceFreshness — a silent source proves nothing about the system', () => {
  it('accepts a source written within tolerance', () => {
    expect(assessSourceFreshness(2, 1).freshness).toBe('FRESH');
  });

  it('tolerates one missed beat as jitter', () => {
    expect(assessSourceFreshness(3, 1).freshness).toBe('FRESH');
  });

  it('disqualifies a source far past its cadence', () => {
    const v = assessSourceFreshness(414, 1);
    expect(v.freshness).toBe('STALE_UNUSABLE');
    expect(v.why).toMatch(/evidence about the source/);
  });

  it('disqualifies a source that has never been written', () => {
    expect(assessSourceFreshness(null, 1).freshness).toBe('STALE_UNUSABLE');
  });
});

describe('assessLivenessSource', () => {
  it('reports UNKNOWN rather than DEAD when the heartbeat writer has stopped', () => {
    // The trap that motivated this module: the obvious liveness table had not been
    // written in >400h. A surface trusting it would confidently report a dead fleet.
    const s = assessLivenessSource(414.2, 1, 12);
    expect(s.determination).toBe('INDETERMINATE');
    expect(s.what).toMatch(/UNKNOWN — not dead/);
    expect(s.actionableBy).toBe('engineering');
    expect(s.evidence.usable).toBe(false);
  });

  it('is HEALTHY and usable when the writer is alive', () => {
    const s = assessLivenessSource(0.5, 1, 12);
    expect(s.determination).toBe('HEALTHY');
    expect(s.evidence.usable).toBe(true);
  });
});

/* ── exchanges ──────────────────────────────────────────────────────────── */

describe('assessExchanges', () => {
  const base = {
    fulfilledTotal: 148,
    fulfilledBackdated: 24,
    awaitingBuyer: 124,
    strandedUnsettled: 0,
    oldestAwaitingDays: 77,
  };

  it('routes a delivered-and-unpaid pile with no buyer verdict to the BUYER, not an engineer', () => {
    const s = assessExchanges(base);
    expect(s.determination).toBe('STALLED');
    expect(s.actionableBy).toBe('buyer');
    expect(s.why).toMatch(/pay providers for work nobody verified/);
  });

  it('names it a product gap rather than a missing worker', () => {
    expect(assessExchanges(base).why).toMatch(/product problem, not a backend one/);
  });

  it('routes a genuine stranded settlement to the operator, and prefers it over the buyer case', () => {
    const s = assessExchanges({ ...base, strandedUnsettled: 3 });
    expect(s.determination).toBe('STALLED');
    expect(s.actionableBy).toBe('operator');
    expect(s.what).toMatch(/buyer verdict that did not settle/);
  });

  it('is HEALTHY when nothing is delivered-and-unpaid', () => {
    const s = assessExchanges({
      fulfilledTotal: 0,
      fulfilledBackdated: 0,
      awaitingBuyer: 0,
      strandedUnsettled: 0,
      oldestAwaitingDays: null,
    });
    expect(s.determination).toBe('HEALTHY');
    expect(s.actionableBy).toBe('nobody');
  });

  it('does not treat age as consent — a 77-day wait is still the buyer’s call', () => {
    const s = assessExchanges({ ...base, oldestAwaitingDays: 77 });
    expect(s.actionableBy).toBe('buyer');
    expect(s.determination).not.toBe('HEALTHY');
  });
});

/* ── the counting trap ──────────────────────────────────────────────────── */

describe('assessSettlementCounting — reporting the overcount instead of inheriting it', () => {
  it('surfaces the inflation factor of `settled_at IS NOT NULL`', () => {
    const s = assessSettlementCounting({ naiveSettledAtCount: 31, trulySettled: 7 });
    expect(s.determination).toBe('DEGRADED');
    expect(s.evidence.overcounted_by).toBe(24);
    expect(s.evidence.inflation_factor).toBe(4.4);
    expect(s.actionableBy).toBe('engineering');
  });

  it('calls a wrong measurement more dangerous than an outage, because it reports as success', () => {
    const s = assessSettlementCounting({ naiveSettledAtCount: 31, trulySettled: 7 });
    expect(s.why).toMatch(/reports as success/);
  });

  it('is HEALTHY when the two counts agree', () => {
    const s = assessSettlementCounting({ naiveSettledAtCount: 7, trulySettled: 7 });
    expect(s.determination).toBe('HEALTHY');
  });

  it('does not divide by zero when nothing has ever settled', () => {
    const s = assessSettlementCounting({ naiveSettledAtCount: 5, trulySettled: 0 });
    expect(s.determination).toBe('DEGRADED');
    expect(s.evidence.inflation_factor).toBeNull();
  });
});

/* ── routing ────────────────────────────────────────────────────────────── */

describe('assessRouting', () => {
  it('stays INDETERMINATE when a previously-working layer goes quiet', () => {
    const s = assessRouting({
      decisionsInWindow: 0,
      windowHours: 24,
      hoursSinceLastDecision: 37.6,
      decisionsLifetime: 294,
      routableDemandInWindow: null,
    });
    expect(s.determination).toBe('INDETERMINATE');
    expect(s.why).toMatch(/bypassing it, or that it is failing silently/);
  });

  it('names the measurement that would resolve it, at the caller not the broker', () => {
    const s = assessRouting({
      decisionsInWindow: 0,
      windowHours: 24,
      hoursSinceLastDecision: 37.6,
      decisionsLifetime: 294,
      routableDemandInWindow: null,
    });
    expect(s.why).toMatch(/counted at the CALLER/);
  });

  it('distinguishes never-wired from wired-and-quiet', () => {
    const never = assessRouting({
      decisionsInWindow: 0,
      windowHours: 24,
      hoursSinceLastDecision: null,
      decisionsLifetime: 0,
      routableDemandInWindow: null,
    });
    expect(never.what).toMatch(/never recorded a decision/);
    expect(never.why).toMatch(/cannot be a regression/);
  });

  it('becomes STALLED-grade only once a real demand signal exists', () => {
    const s = assessRouting({
      decisionsInWindow: 0,
      windowHours: 24,
      hoursSinceLastDecision: 37.6,
      decisionsLifetime: 294,
      routableDemandInWindow: 500,
    });
    // With demand present the throughput verdict is STALLED; the signal reports
    // the underlying reasoning rather than staying agnostic.
    expect(s.why).toMatch(/not being served/);
  });

  it('is HEALTHY when decisions are flowing', () => {
    const s = assessRouting({
      decisionsInWindow: 42,
      windowHours: 24,
      hoursSinceLastDecision: 0.1,
      decisionsLifetime: 294,
      routableDemandInWindow: null,
    });
    expect(s.determination).toBe('HEALTHY');
  });
});

/* ── work queue ─────────────────────────────────────────────────────────── */

describe('assessWorkQueue', () => {
  it('calls an empty queue IDLE and explicitly declines to claim workers are healthy', () => {
    const s = assessWorkQueue({
      pending: 0,
      completedInWindow: 0,
      windowHours: 24,
      hoursSinceLastCompletion: 30,
    });
    expect(s.determination).toBe('IDLE');
    expect(s.why).toMatch(/Worker health is NOT established/);
    expect(s.actionableBy).toBe('nobody');
  });

  it('calls a backed-up queue with no completions STALLED and routes it to an operator', () => {
    const s = assessWorkQueue({
      pending: 33254,
      completedInWindow: 0,
      windowHours: 24,
      hoursSinceLastCompletion: 40,
    });
    expect(s.determination).toBe('STALLED');
    expect(s.actionableBy).toBe('operator');
  });

  it('is HEALTHY when work is completing', () => {
    const s = assessWorkQueue({
      pending: 0,
      completedInWindow: 1,
      windowHours: 24,
      hoursSinceLastCompletion: 3,
    });
    expect(s.determination).toBe('HEALTHY');
  });

  it('reports the same low throughput two opposite ways depending only on the backlog', () => {
    // The whole point of the module, on one input. "1 task in 24h" is alarming or
    // fine, and the counter alone cannot tell you which.
    const atRest = assessWorkQueue({
      pending: 0,
      completedInWindow: 0,
      windowHours: 24,
      hoursSinceLastCompletion: 40,
    });
    const stopped = assessWorkQueue({
      pending: 5,
      completedInWindow: 0,
      windowHours: 24,
      hoursSinceLastCompletion: 40,
    });
    expect(atRest.evidence.completed_in_window).toBe(stopped.evidence.completed_in_window);
    expect(atRest.determination).toBe('IDLE');
    expect(stopped.determination).toBe('STALLED');
  });
});

/* ── aggregate ──────────────────────────────────────────────────────────── */

const LIVE_SHAPE: StallSignalFacts = {
  exchanges: {
    fulfilledTotal: 148,
    fulfilledBackdated: 24,
    awaitingBuyer: 124,
    strandedUnsettled: 0,
    oldestAwaitingDays: 77,
  },
  settlementCounting: { naiveSettledAtCount: 31, trulySettled: 7 },
  routing: {
    decisionsInWindow: 0,
    windowHours: 24,
    hoursSinceLastDecision: 37.6,
    decisionsLifetime: 294,
    routableDemandInWindow: null,
  },
  workQueue: {
    pending: 0,
    completedInWindow: 1,
    windowHours: 24,
    hoursSinceLastCompletion: 3,
  },
  liveness: { hoursSinceLastHeartbeat: 414.2, expectedCadenceHours: 1, knownSources: 12 },
};

describe('assembleReport', () => {
  it('reports the worst determination overall', () => {
    const r = assembleReport(LIVE_SHAPE);
    expect(r.overall).toBe('STALLED');
  });

  it('leads with what needs a human and who owns it, not with a count of signals', () => {
    const r = assembleReport(LIVE_SHAPE);
    expect(r.headline).toMatch(/owner: buyer/);
    expect(r.headline).not.toMatch(/^\d+ signals/);
  });

  it('puts the liveness-source verdict first, so no "quiet" reading is read unqualified', () => {
    const r = assembleReport(LIVE_SHAPE);
    expect(r.signals[0]!.signal).toBe('liveness.source');
  });

  it('ranks INDETERMINATE above DEGRADED — unseen beats seen-and-wrong', () => {
    const r = assembleReport({
      ...LIVE_SHAPE,
      exchanges: { ...LIVE_SHAPE.exchanges, awaitingBuyer: 0, fulfilledTotal: 0 },
    });
    // exchanges healthy; counting DEGRADED; routing + liveness INDETERMINATE.
    expect(r.overall).toBe('INDETERMINATE');
  });

  it('is HEALTHY only when every signal is', () => {
    const r = assembleReport({
      exchanges: {
        fulfilledTotal: 0,
        fulfilledBackdated: 0,
        awaitingBuyer: 0,
        strandedUnsettled: 0,
        oldestAwaitingDays: null,
      },
      settlementCounting: { naiveSettledAtCount: 7, trulySettled: 7 },
      routing: {
        decisionsInWindow: 10,
        windowHours: 24,
        hoursSinceLastDecision: 0.1,
        decisionsLifetime: 300,
        routableDemandInWindow: null,
      },
      workQueue: {
        pending: 0,
        completedInWindow: 5,
        windowHours: 24,
        hoursSinceLastCompletion: 0.2,
      },
      liveness: { hoursSinceLastHeartbeat: 0.5, expectedCadenceHours: 1, knownSources: 12 },
    });
    expect(r.overall).toBe('HEALTHY');
    expect(r.headline).toBe('All signals healthy.');
  });

  it('gives every signal a what, a why and an owner — a number alone is never emitted', () => {
    for (const s of assembleReport(LIVE_SHAPE).signals) {
      expect(s.what.length).toBeGreaterThan(10);
      expect(s.why.length).toBeGreaterThan(20);
      expect(s.actionableBy).toBeTruthy();
    }
  });

  it('renders without throwing', () => {
    expect(formatReport(assembleReport(LIVE_SHAPE))).toMatch(/\[stall-signals\]/);
  });
});

/* ── no identifiers leak ────────────────────────────────────────────────── */

describe('output carries no per-row identity', () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const HEX_ADDR = /0x[0-9a-f]{16,}/i;

  it('emits no uuid or address-shaped string anywhere in the report', () => {
    const json = JSON.stringify(assembleReport(LIVE_SHAPE));
    expect(json).not.toMatch(UUID);
    expect(json).not.toMatch(HEX_ADDR);
  });

  it('emits only numbers, booleans and nulls as evidence — never a string from a row', () => {
    for (const s of assembleReport(LIVE_SHAPE).signals) {
      for (const v of Object.values(s.evidence)) {
        expect(['number', 'boolean']).toContain(v === null ? 'number' : typeof v);
      }
    }
  });
});

/* ── restraint: no writes, no mounting ──────────────────────────────────── */

describe('the module acts on nothing', () => {
  it.each(['.insert(', '.update(', '.upsert(', '.delete(', '.rpc('])(
    'contains no %s call',
    (verb) => {
      expect(SOURCE).not.toContain(verb);
    },
  );

  it('does not import the app database client', () => {
    expect(SOURCE).not.toMatch(/from\s+['"].*\/(db|supabase|config)['"]/);
  });

  it('exposes a reader interface with no write verb on it', () => {
    // The type itself is the guardrail: there is nothing to reach for.
    const iface = SOURCE.slice(
      SOURCE.indexOf('export interface BoundedReader'),
      SOURCE.indexOf('const HOUR_MS'),
    );
    for (const verb of ['insert', 'update', 'upsert', 'delete', 'rpc']) {
      expect(iface).not.toContain(verb);
    }
  });

  it('defines no express route and is mounted nowhere', () => {
    expect(SOURCE).not.toMatch(/\bRouter\(|\brouter\.(get|post|put|patch|delete)\b/);
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(index).not.toContain('stall-signals');
  });
});

/* ── collection is bounded and null-preserving ──────────────────────────── */

describe('collectFacts', () => {
  /** A fake that records what was asked for. It has no write methods at all. */
  function fakeDb(opts: { fail?: boolean } = {}) {
    const calls: Array<{ table: string; head: boolean; limit: number | null }> = [];

    const makeChain = (table: string, head: boolean) => {
      const state = { limit: null as number | null };
      const chain: any = {
        then: undefined,
      };
      for (const m of ['eq', 'is', 'not', 'gt', 'gte', 'order']) {
        chain[m] = () => chain;
      }
      chain.limit = (n: number) => {
        state.limit = n;
        calls.push({ table, head, limit: n });
        return Promise.resolve(
          opts.fail
            ? { data: null, error: { message: 'boom' } }
            : {
                data: [
                  { created_at: '2026-08-02 14:56:08', last_ping: null, completed_at: null, fulfilled_at: null },
                ],
                error: null,
              },
        );
      };
      // A head-count chain is awaited directly, without .limit().
      chain.then = (res: any, rej: any) => {
        calls.push({ table, head, limit: null });
        return Promise.resolve(
          opts.fail ? { count: null, error: { message: 'boom' } } : { count: 3, error: null },
        ).then(res, rej);
      };
      return chain;
    };

    const db: BoundedReader = {
      from(table: string) {
        return {
          select(_cols: string, options?: { count?: any; head?: boolean }) {
            return makeChain(table, options?.head === true);
          },
        };
      },
    };
    return { db, calls };
  }

  it('reads only with head-counts or single-row limits — never an unbounded row sweep', async () => {
    const { db, calls } = fakeDb();
    await collectFacts(db);
    for (const c of calls) {
      const bounded = c.head === true || c.limit === 1;
      expect(bounded).toBe(true);
    }
    expect(calls.length).toBeGreaterThan(5);
  });

  it('never predicates on the unindexed claim column of the very large table', () => {
    // `LIMIT 1` bounds the wire, not the scan. Ordering or filtering on `claimed_at`
    // costs a full parallel seq scan of a several-hundred-thousand-row table
    // [V measured 2026-08-04]; `completed_at` is indexed and answers the same
    // questions in under a millisecond. This is pinned because the claim column is
    // the more intuitive choice and would be reintroduced by a reasonable patch.
    expect(SOURCE).not.toContain("'claimed_at'");
    expect(SOURCE).toContain("'completed_at'");
  });

  it('survives a failing datastore without inventing healthy zeros in the classifiers', async () => {
    const { db } = fakeDb({ fail: true });
    const facts = await collectFacts(db);
    // Counts degrade to 0, but the timestamps stay null, which is what keeps the
    // routing verdict INDETERMINATE rather than a confident all-clear.
    expect(facts.routing.hoursSinceLastDecision).toBeNull();
    expect(facts.liveness.hoursSinceLastHeartbeat).toBeNull();
    const r = assembleReport(facts);
    expect(r.overall).not.toBe('HEALTHY');
  });

  it('passes a null demand signal for routing, which is what forces the honest verdict', async () => {
    const { db } = fakeDb();
    const facts = await collectFacts(db);
    expect(facts.routing.routableDemandInWindow).toBeNull();
    expect(assessRouting(facts.routing).determination).not.toBe('STALLED');
  });
});

/* ── timezone handling ──────────────────────────────────────────────────── */

describe('hoursSince', () => {
  const now = Date.parse('2026-08-04T04:29:00Z');

  it('reads a zone-bearing timestamp correctly', () => {
    expect(hoursSince('2026-08-04T02:29:00Z', now)).toBeCloseTo(2, 3);
  });

  it('reads a zone-LESS UTC column as UTC when told to', () => {
    // Without assumeUtc, Date.parse treats this as local time — which on a machine
    // west of Greenwich makes a stale row look fresh, an error big enough to flip a
    // freshness verdict.
    expect(hoursSince('2026-08-04 02:29:00', now, true)).toBeCloseTo(2, 3);
  });

  it('returns null for absent or unparseable input', () => {
    expect(hoursSince(null, now)).toBeNull();
    expect(hoursSince('not a date', now)).toBeNull();
  });
});
