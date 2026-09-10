/**
 * THE BOUNDARY THE OUTAGE LIVED ON.
 *
 * #707 fixed the cron's rating and pinned it thoroughly — but every one of those
 * tests exercises `rate-deliverable.mjs` ALONE. `deriveSatisfyScore`, the route
 * parser that actually accepts or rejects what the cron sends, appears in that
 * file only inside a comment. Nothing executes both ends together.
 *
 * That gap is not incidental; it is the exact shape of the bug. Neither end was
 * broken on its own. The cron sent a well-formed `{satisfaction_score: 1}` and
 * the route correctly required `criterion_ratings` — each defensible, together a
 * 400 on every poll for six days while real USDC sat authorized and uncaptured.
 * A unit test on either side passes while the pair disagrees, which is why the
 * failure was invisible: everything green, nothing settling.
 *
 * So this file asserts the CONTRACT BETWEEN THEM, using the cron's real exported
 * criteria and the route's real parser. It is deliberately thin — #707 owns what
 * the ratings should be; this owns only that the route accepts them.
 *
 * A gate added at one end of a pipeline has to be checked against every producer
 * feeding the other end. This is that check, executable.
 */
process.env['SUPABASE_URL'] = process.env['SUPABASE_URL'] || 'http://localhost:54321';
process.env['SUPABASE_SERVICE_KEY'] = process.env['SUPABASE_SERVICE_KEY'] || 'dummy';

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { deriveSatisfyScore } from '../src/routes/v1/contracts';

const MODULE = join(__dirname, '..', 'scripts', 'cron', 'rate-deliverable.mjs');

interface Rating { n: number; met: boolean }

/**
 * Pull the cron's REAL exports through a real node, the way the cron will —
 * same harness #707 uses, for the same reason: `mint-attestation.mjs` and its
 * module are ESM, and the module must not be re-implemented here or this test
 * would verify a copy instead of the thing that ships.
 */
function fromCron(result: unknown): {
  criteria: { n: number; text: string }[];
  ratings: Rating[];
} {
  const src = `
    import { rateDeliverable, ACCEPTANCE_CRITERIA } from ${JSON.stringify(MODULE)};
    console.log(JSON.stringify({
      criteria: ACCEPTANCE_CRITERIA,
      ratings: rateDeliverable(${JSON.stringify(result)}),
    }));
  `;
  return JSON.parse(execFileSync('node', ['--input-type=module', '-e', src], { encoding: 'utf8' }).trim());
}

/** Copied out of production 2026-09-09 (contract f8efc485). */
const REAL_0909 = {
  score: 0.9678571428571429,
  verdict: 'PASS',
  confidence: 0.9333333333333332,
  validators: ['trinity-mock-fl-seller-1782493021881'],
  contract_id: 'f8efc485-f52c-4d6f-a62e-2b29b075e5a0',
  verified_at: '2026-09-09T12:01:43.891Z',
  patent_marker: 'P-001',
  validator_count: 3,
  attempted_validator_count: 3,
};

/** A work-statement-bound contract, built from the cron's own criteria. */
function boundContract(criteria: { n: number; text: string }[]) {
  return {
    work_statement_hash: '0xdeadbeef',
    work_statement: {
      deliverable: 'A cross-provider factual verification verdict.',
      acceptance_criteria: criteria,
      deadline: '2026-09-11T12:00:00.000Z',
      agreed_price: { currency: 'USDC', amount_usdc_raw: 100000 },
    },
  };
}

describe('the cron and the route agree on what a rating is', () => {
  it('THE REGRESSION: the old scalar is rejected, and no score value rescues it', () => {
    // Six days of 400 RATING_REQUIRED, in one assertion. Retrying could never
    // have helped — the rejection is deterministic in the payload's SHAPE, which
    // is why 8 polls a day looked like a delivery timeout instead of a refusal.
    const { criteria } = fromCron(REAL_0909);
    for (const score of [0, 0.5, 1]) {
      const derived = deriveSatisfyScore(boundContract(criteria), undefined, score);
      expect(derived.ok).toBe(false);
      if (!derived.ok) expect(derived.error).toBe('RATING_REQUIRED');
    }
  });

  it('THE FIX: what the cron now sends is ACCEPTED by the real parser', () => {
    const { criteria, ratings } = fromCron(REAL_0909);
    const derived = deriveSatisfyScore(boundContract(criteria), ratings, undefined);
    expect(derived.ok).toBe(true);
  });

  it('and the parser derives the SAME score the cron computed', () => {
    // If these ever diverge, the cron's log and the database disagree about what
    // the buyer said — the audit trail would record a number nobody asserted.
    const { criteria, ratings } = fromCron(REAL_0909);
    const derived = deriveSatisfyScore(boundContract(criteria), ratings, undefined);
    const met = ratings.filter((r) => r.met).length;
    expect(derived.ok && derived.score).toBe(Number((met / ratings.length).toFixed(4)));
  });

  it('the accepted score clears the release gate, so payment actually moves', () => {
    // `passed = verdict === 'PASS' && derived.score > 0` in the satisfy route.
    // Acceptance alone is not settlement; this is the assertion that says the
    // six-day stranding actually ends.
    const { criteria, ratings } = fromCron(REAL_0909);
    const derived = deriveSatisfyScore(boundContract(criteria), ratings, undefined);
    expect(derived.ok && derived.score > 0).toBe(true);
  });

  it('every criterion the cron SENDS is a criterion the cron RATES', () => {
    // The drift this whole class of bug comes from: a criterion added at one end
    // and not the other. The parser rejects that as CRITERION_RATING_INCOMPLETE,
    // so it is checkable rather than a matter of remembering.
    const { criteria, ratings } = fromCron(REAL_0909);
    expect(ratings.map((r) => r.n).sort()).toEqual(criteria.map((c) => c.n).sort());
  });

  it('a rating the statement does not contain is refused, not silently ignored', () => {
    const { criteria, ratings } = fromCron(REAL_0909);
    const rogue = [...ratings, { n: 99, met: true }];
    const derived = deriveSatisfyScore(boundContract(criteria), rogue, undefined);
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.error).toBe('CRITERION_NOT_IN_STATEMENT');
  });

  it('a missing rating is refused — partial coverage cannot pay', () => {
    const { criteria, ratings } = fromCron(REAL_0909);
    const derived = deriveSatisfyScore(boundContract(criteria), ratings.slice(0, 1), undefined);
    expect(derived.ok).toBe(false);
    if (!derived.ok) expect(derived.error).toBe('CRITERION_RATING_INCOMPLETE');
  });
});
