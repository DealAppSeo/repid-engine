/**
 * The daily attestation cron stopped settling on 2026-09-05 and failed silently
 * for five consecutive days. This pins both halves of the cause.
 *
 * WHY IT LEFT NO TRACE. `deriveSatisfyScore` IGNORES `satisfaction_score`
 * entirely once a contract carries a `work_statement_hash`, and demands a `met`
 * rating for every numbered criterion instead. The cron sent
 * `{ satisfaction_score: 1 }`, so every attempt returned 400 RATING_REQUIRED —
 * BEFORE the money path. No release was attempted, no authorization voided, the
 * settlement row untouched at `authorized`. Five contracts reached `fulfilled`
 * with PASS and simply stopped, and nothing in the database distinguished that
 * from "waiting on the buyer". Measured: 09-05 through 09-09, five different
 * providers, identical terminal state.
 *
 * THE TRAP. #607/#608 taught this script to WRITE a work statement and left the
 * rating call sending the legacy scalar. A gate added at one end of a pipeline
 * has to be checked against every producer feeding the other end — including
 * the one you just fixed.
 */
process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] || 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] || 'dummy';

import { deriveSatisfyScore } from '../src/routes/v1/contracts';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rateDeliverable } = require('../scripts/cron/rate-deliverable.cjs') as {
  rateDeliverable: (result: unknown) => { n: number; met: boolean }[];
};

/** The exact work statement mint-attestation.mjs writes. */
const CLAIM = 'The Base Sepolia chain id is 84532.';
const workStatement = {
  deliverable: `A cross-provider factual verification verdict on the claim: "${CLAIM}"`,
  acceptance_criteria: [
    { n: 1, text: 'The verdict states explicitly whether the claim is true or false, without hedging.' },
    {
      n: 2,
      text: 'The verdict reports how many validators were asked and how many answered, so silence cannot be counted as agreement.',
    },
  ],
  deadline: '2026-09-11T12:00:00.000Z',
  agreed_price: { currency: 'USDC', amount_usdc_raw: 100000 },
};
const contract = { work_statement: workStatement, work_statement_hash: '0xdeadbeef' };

/** A real deliverable, copied from contract f8efc485 (2026-09-09). */
const REAL_DELIVERABLE = {
  score: 0.9678571428571429,
  verdict: 'PASS',
  confidence: 0.9333333333333332,
  validators: ['a', 'b', 'c'],
  patent_marker: 'P-001',
  validator_count: 3,
  attempted_validator_count: 3,
};

describe('the regression: a legacy satisfaction_score cannot settle a work-statement contract', () => {
  it('REPRODUCES the five-day outage — satisfaction_score alone is rejected', () => {
    const derived = deriveSatisfyScore(contract, undefined, 1);
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.error).toBe('RATING_REQUIRED');
  });

  it('and it fails the same way for ANY score, so retrying could never have helped', () => {
    // The cron retried 8 times per run, 5 days running. Retrying a deterministic
    // 400 is what made this look like a timeout instead of a rejection.
    for (const score of [0, 0.5, 1]) {
      expect(deriveSatisfyScore(contract, undefined, score).ok).toBe(false);
    }
  });

  it('THE FIX: the ratings the cron now sends are accepted, and score 1.0', () => {
    const derived = deriveSatisfyScore(contract, rateDeliverable(REAL_DELIVERABLE), undefined);
    expect(derived.ok).toBe(true);
    if (derived.ok) {
      expect(derived.score).toBe(1);
      expect(derived.ratings).toEqual([{ n: 1, met: true }, { n: 2, met: true }]);
    }
  });

  it('score must be > 0 or /satisfy VOIDS the authorization — a full pass clears that gate', () => {
    // `passed = verdict === 'PASS' && derived.score > 0`. This is the assertion
    // that says the fix actually releases money rather than merely parsing.
    const derived = deriveSatisfyScore(contract, rateDeliverable(REAL_DELIVERABLE), undefined);
    expect(derived.ok && derived.score > 0).toBe(true);
  });
});

describe('rateDeliverable — derived from the deliverable, never assumed', () => {
  it('rates the real measured payload as fully met', () => {
    expect(rateDeliverable(REAL_DELIVERABLE)).toEqual([
      { n: 1, met: true },
      { n: 2, met: true },
    ]);
  });

  it('a SILENT panel is not agreement: 0 of 3 answered fails criterion 2', () => {
    // This is the August outage in one assertion. A verdict object can carry
    // `verdict: PASS` while nobody actually answered; criterion 2 exists so the
    // buyer catches that rather than paying for it.
    const silent = { ...REAL_DELIVERABLE, validator_count: 0, attempted_validator_count: 3 };
    expect(rateDeliverable(silent)).toEqual([
      { n: 1, met: true },
      { n: 2, met: false },
    ]);
  });

  it('FAIL is an explicit verdict too — criterion 1 asks for a decision, not a favourable one', () => {
    const failed = { ...REAL_DELIVERABLE, verdict: 'FAIL' };
    expect(rateDeliverable(failed)[0]).toEqual({ n: 1, met: true });
  });

  it('a hedged or missing verdict fails criterion 1', () => {
    for (const verdict of ['MAYBE', 'NOT_CHECKED', '', undefined]) {
      expect(rateDeliverable({ ...REAL_DELIVERABLE, verdict })[0]).toEqual({ n: 1, met: false });
    }
  });

  it('missing counts fail criterion 2 — absent is not the same as zero, but neither is met', () => {
    const noCounts = { verdict: 'PASS' };
    expect(rateDeliverable(noCounts)).toEqual([
      { n: 1, met: true },
      { n: 2, met: false },
    ]);
  });

  it('nothing is hardcoded true: a junk deliverable meets nothing', () => {
    // If this ever passes with `met: true`, the buyer is rubber-stamping.
    for (const junk of [null, undefined, {}, 'PASS', 42]) {
      expect(rateDeliverable(junk as never)).toEqual([
        { n: 1, met: false },
        { n: 2, met: false },
      ]);
    }
  });

  it('a wholly unmet deliverable scores 0, which routes to deliverable_rejected', () => {
    // Score 0 voids the authorization and the buyer keeps the funds. That is the
    // intended outcome for work that missed the spec, and it is why the cron must
    // never rate before the deliverable exists.
    const derived = deriveSatisfyScore(contract, rateDeliverable({}), undefined);
    expect(derived.ok).toBe(true);
    if (derived.ok) expect(derived.score).toBe(0);
  });
});

describe('the ratings match the statement the cron actually writes', () => {
  it('covers every numbered criterion — a partial rating is rejected', () => {
    // CRITERION_RATING_INCOMPLETE. If someone adds a third criterion to the cron
    // and forgets to rate it, this is the failure they will get.
    const partial = [{ n: 1, met: true }];
    const derived = deriveSatisfyScore(contract, partial, undefined);
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.error).toBe('CRITERION_RATING_INCOMPLETE');
  });

  it('rates exactly the criteria in the statement — an unknown n is rejected', () => {
    const rogue = [{ n: 1, met: true }, { n: 2, met: true }, { n: 3, met: true }];
    const derived = deriveSatisfyScore(contract, rogue, undefined);
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.error).toBe('CRITERION_NOT_IN_STATEMENT');
  });

  it('rateDeliverable returns one rating per criterion in the statement', () => {
    const ns = rateDeliverable(REAL_DELIVERABLE).map((r) => r.n).sort();
    expect(ns).toEqual(workStatement.acceptance_criteria.map((c) => c.n).sort());
  });
});
