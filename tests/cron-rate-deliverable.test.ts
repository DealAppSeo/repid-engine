/**
 * The rating that decides whether the daily cron pays.
 *
 * `mint-attestation.mjs` used to send `{satisfaction_score: 1}` — a flat
 * assertion that the deliverable was perfect, made without reading it. Two
 * things were wrong with that, and only one of them was visible:
 *
 *   1. It stopped being ACCEPTED. Once contracts became work-statement-bound,
 *      `deriveSatisfyScore` began requiring `criterion_ratings` and the legacy
 *      scalar branch became unreachable, so satisfy returned 400 RATING_REQUIRED
 *      on every poll. MEASURED 2026-09-09: five consecutive daily runs reached
 *      `fulfilled` and never settled, leaving real USDC authorized-but-uncaptured
 *      and growing by one contract per day. The escrow fix did not strand the
 *      money; it moved where the stranding happened.
 *   2. It was never HONEST. A buyer that reports 1.0 without looking is the
 *      "recorded as if it had been checked" defect this codebase keeps removing,
 *      sitting on the one path that moves real money.
 *
 * So the rating is now derived from the delivered result, and this pins it. The
 * cases below are built from REAL deliverables read out of production, not from
 * a shape I imagined — the whole reason the old payload broke is that nobody
 * checked it against what the endpoint actually wanted.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const MODULE = join(__dirname, '..', 'scripts', 'cron', 'rate-deliverable.mjs');

interface Rating { n: number; met: boolean }

/** Exercise the real module in a real node, the way the cron will. */
function rate(result: unknown): { ratings: Rating[]; score: number; releases: boolean } {
  const src = `
    import { rateDeliverable, scoreOf } from ${JSON.stringify(MODULE)};
    const result = ${JSON.stringify(result)};
    const ratings = rateDeliverable(result);
    const score = scoreOf(ratings);
    // The server's own gate, transcribed from routes/v1/contracts.ts:
    //   const passed = verdict === 'PASS' && derived.score > 0;
    const verdict = String(result?.verdict ?? '').toUpperCase();
    const releases = verdict === 'PASS' && score > 0;
    console.log(JSON.stringify({ ratings, score, releases }));
  `;
  const out = execFileSync('node', ['--input-type=module', '-e', src], { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

/**
 * Copied verbatim out of production on 2026-09-09 (contracts f8efc485 and
 * 5f865c71). The validator names really are `trinity-mock-*`; that is what the
 * handler produces today and the rating must be correct about the deliverable
 * that exists, not a nicer one.
 */
const REAL_0909 = {
  score: 0.9678571428571429,
  verdict: 'PASS',
  confidence: 0.9333333333333332,
  validators: ['trinity-mock-fl-seller-1782493021881', 'trinity-mock-it-seller-1782341054140'],
  contract_id: 'f8efc485-f52c-4d6f-a62e-2b29b075e5a0',
  verified_at: '2026-09-09T12:01:43.891Z',
  patent_marker: 'P-001',
  validator_count: 3,
  attempted_validator_count: 3,
};

describe('the cron rates what it was actually sent', () => {
  it('THE UNBLOCK: a real production deliverable rates 0.5 and RELEASES payment', () => {
    const { ratings, score, releases } = rate(REAL_0909);
    expect(ratings).toEqual([{ n: 1, met: true }, { n: 2, met: false }]);
    expect(score).toBe(0.5);
    // The server gate is `score > 0`, not `score === 1` — a partially-met
    // deliverable still pays. If this ever flips to false the daily run stops
    // settling again, which is the failure this whole change exists to end.
    expect(releases).toBe(true);
  });

  it('rates criterion 1 met on an explicit PASS, because that is an unhedged verdict', () => {
    expect(rate({ verdict: 'PASS' }).ratings[0]).toEqual({ n: 1, met: true });
  });

  it('rates criterion 1 met on FAIL too — explicit is the property, not favourable', () => {
    expect(rate({ verdict: 'FAIL' }).ratings[0]).toEqual({ n: 1, met: true });
  });

  it('a FAIL verdict does NOT release payment, however the criteria rate', () => {
    // The buyer rating and the delivery verdict are separate gates and both bind.
    const { score, releases } = rate({ verdict: 'FAIL', note: 'chain 84532' });
    expect(score).toBe(1);
    expect(releases).toBe(false);
  });

  it('refuses to call a hedged verdict explicit', () => {
    for (const verdict of ['probably true', 'likely', 'inconclusive', '']) {
      expect(rate({ verdict }).ratings[0]).toEqual({ n: 1, met: false });
    }
  });

  it('rates criterion 2 met ONLY when the chain id is really in the deliverable', () => {
    expect(rate({ verdict: 'PASS' }).ratings[1]).toEqual({ n: 2, met: false });
    expect(rate({ verdict: 'PASS', note: 'verified against 84532' }).ratings[1]).toEqual({ n: 2, met: true });
  });

  it('finds the chain id anywhere in the deliverable, not just a guessed field', () => {
    const nested = { verdict: 'PASS', evidence: { chain: { id: 84532 } } };
    expect(rate(nested).ratings[1]).toEqual({ n: 2, met: true });
    expect(rate(nested).score).toBe(1);
  });

  /**
   * The two directions of getting this wrong are not symmetric in cost, but
   * both are wrong, and neither is the cron's to invent.
   */
  it('an empty or missing deliverable rates 0 — it never defaults to met', () => {
    for (const empty of [null, undefined, {}, { score: 1 }]) {
      const { score, releases } = rate(empty);
      expect(score).toBe(0);
      expect(releases).toBe(false); // 0 met voids the authorization, by design
    }
  });

  it('never invents a verdict from a high score alone', () => {
    // A deliverable can carry score 1.0 and still state nothing. Reading that as
    // a pass is exactly the confidence-without-an-answer defect that disputed
    // real contracts for twelve days.
    expect(rate({ score: 1, confidence: 1 }).ratings[0]).toEqual({ n: 1, met: false });
  });
});

describe('the contract and the rating share one list of criteria', () => {
  it('every criterion sent at creation gets a rating back, by number', () => {
    const src = `
      import { ACCEPTANCE_CRITERIA, rateDeliverable } from ${JSON.stringify(MODULE)};
      const rated = rateDeliverable({ verdict: 'PASS' }).map((r) => r.n).sort();
      const declared = ACCEPTANCE_CRITERIA.map((c) => c.n).sort();
      console.log(JSON.stringify({ rated, declared }));
    `;
    const { rated, declared } = JSON.parse(
      execFileSync('node', ['--input-type=module', '-e', src], { encoding: 'utf8' }).trim(),
    );
    // Adding a criterion to the contract without rating it would send a partial
    // rating set, which the server refuses — this fails first, and locally.
    expect(rated).toEqual(declared);
  });

  it('the claim text carries the chain id the rating looks for', () => {
    const src = `
      import { CLAIM_TEXT, CHAIN_ID } from ${JSON.stringify(MODULE)};
      console.log(JSON.stringify({ ok: CLAIM_TEXT.includes(CHAIN_ID), CHAIN_ID }));
    `;
    const { ok } = JSON.parse(
      execFileSync('node', ['--input-type=module', '-e', src], { encoding: 'utf8' }).trim(),
    );
    expect(ok).toBe(true);
  });
});

/**
 * WHAT TO DO ABOUT A CONTRACT, BEFORE ANY RATING HAPPENS.
 *
 * Found in self-review of the fix above, not in production — the loop that reads
 * the contract before rating it treated everything that was not `fulfilled` as
 * "awaiting delivery" and slept. `settled` fell into that branch, so a contract
 * whose satisfy HAD succeeded would be polled to the timeout and then reported
 * as `contract never reached settled`. That is a FAILURE reported on a SUCCESS,
 * on a path where the money has already moved — it would send the next reader
 * looking for stranded funds that are not stranded.
 *
 * Reachable, not theoretical: satisfy is read as `s.json?.status === 'settled'`,
 * so any response that settles without saying so in that exact shape lands here.
 *
 * The statuses below are the ones `src/routes/v1/contracts.ts` uses.
 */
function classify(status: unknown): string {
  const src = `
    import { classifyContractStatus } from ${JSON.stringify(MODULE)};
    console.log(classifyContractStatus(${JSON.stringify(status)}));
  `;
  return execFileSync('node', ['--input-type=module', '-e', src], { encoding: 'utf8' }).trim();
}

describe('classifyContractStatus: four answers, because collapsing them is the bug', () => {
  it('THE BUG: settled is done, not "awaiting delivery"', () => {
    expect(classify('settled')).toBe('settled');
    expect(classify('settled')).not.toBe('wait'); // what it used to do
  });

  it('fulfilled is the one status that may spend money', () => {
    expect(classify('fulfilled')).toBe('rate');
  });

  it('still-in-flight statuses wait', () => {
    for (const s of ['pending', 'escrowed']) expect(classify(s)).toBe('wait');
  });

  it('disputed / resolved / cancelled are terminal — waiting cannot reach fulfilled', () => {
    for (const s of ['disputed', 'resolved', 'cancelled']) expect(classify(s)).toBe('terminal');
  });

  /**
   * The safe direction to be wrong in. A status this script has never seen must
   * not become a licence to rate: waiting spends nothing and fails loudly at the
   * caller's timeout, whereas rating an unknown state moves real USDC.
   */
  it('never rates a status it does not recognise', () => {
    for (const s of ['SETTLED', 'fulfilled ', 'refunded', 'expired', '', 'null', undefined, null, 0, {}]) {
      expect(classify(s)).not.toBe('rate');
      expect(classify(s)).not.toBe('settled');
    }
  });
});

/**
 * WHAT satisfy's ANSWER MEANS — the decision I got wrong on the first pass.
 *
 * I wrote `if (s.status === 200 && s.json?.voided)` to detect a voided
 * authorization. The route never sends that: a rejected deliverable comes back
 * **409 `deliverable_rejected`**. Under the wrong check a voided contract would
 * have fallen through to the retry path, polled to the timeout, and been
 * reported as a delivery timeout — the wrong cause, on the money path.
 *
 * Reading `src/routes/v1/contracts.ts` is what found it, and 409 is returned for
 * two OPPOSITE things there, one terminal and one retryable. Every case below is
 * transcribed from that handler, not imagined.
 */
function answer(httpStatus: number, body: unknown): string {
  const src = `
    import { classifySatisfyResponse } from ${JSON.stringify(MODULE)};
    console.log(classifySatisfyResponse(${httpStatus}, ${JSON.stringify(body)}));
  `;
  return execFileSync('node', ['--input-type=module', '-e', src], { encoding: 'utf8' }).trim();
}

describe('classifySatisfyResponse: 409 means two opposite things', () => {
  it('200 + settled is the only success', () => {
    expect(answer(200, { status: 'settled' })).toBe('settled');
  });

  it('THE BUG: a voided authorization is 409 deliverable_rejected, never 200', () => {
    expect(answer(409, { error: 'deliverable_rejected', voided: true })).toBe('voided');
    // The check that was wrong. If this ever reads 'voided' again, someone has
    // reintroduced a shape the route does not send.
    expect(answer(200, { voided: true })).not.toBe('voided');
  });

  it('the other 409 is retryable — our read raced the delivery', () => {
    expect(answer(409, { error: 'not_fulfilled' })).toBe('retry');
  });

  it('400 / 403 / 404 never improve with waiting', () => {
    expect(answer(400, { error: 'RATING_REQUIRED' })).toBe('reject');
    expect(answer(403, { error: 'not_the_buyer' })).toBe('reject');
    expect(answer(404, { error: 'contract not found' })).toBe('reject');
  });

  it('200 without a settled body is NOT treated as settled', () => {
    // Reporting settlement off the status code alone would claim the money moved
    // on a response that never said so.
    for (const body of [{}, { status: 'fulfilled' }, null]) {
      expect(answer(200, body)).not.toBe('settled');
    }
  });

  it('an unrecognised answer retries — it never invents a settlement or a void', () => {
    for (const [st, body] of [[500, {}], [502, null], [409, { error: 'something_new' }]] as const) {
      const a = answer(st, body);
      expect(a).toBe('retry');
    }
  });
});
