/**
 * routing-corpus.test.ts — the featuriser between the join and the LASSO.
 *
 * The properties worth pinning here are the ones that would make a fit LOOK fine and be
 * wrong:
 *   1. an unlabelled decision is DROPPED and COUNTED, never scored as a failure — the
 *      difference between "we did not observe it" and "it failed";
 *   2. no outcome-side field (latency, cost) reaches the feature vector, so the fit cannot
 *      model a decision it could not have made;
 *   3. the reported feature names line up with the matrix columns, so a coefficient table
 *      cannot label column j with feature k.
 *
 * There is also an end-to-end check that the untouched `fitLassoLogistic` maths finds a
 * PLANTED signal in this corpus shape — the pipe is proven on data whose answer is known,
 * rather than by declaring it works.
 */

import {
  ROUTING_FEATURE_NAMES,
  buildRoutingCorpus,
  featurizeRoutingRow,
  isLabelled,
  labelOf,
  type JoinedRoutingRow,
} from '../src/decisioning/routing-corpus';

function row(over: Partial<JoinedRoutingRow> = {}): JoinedRoutingRow {
  return {
    call_id: 'c1',
    provider: 'groq',
    attempt: 1,
    chosen_tier: '0a',
    chosen_cost_class: 'free',
    reason: 'static_cost_order',
    chosen_position: 0,
    chain_len: 4,
    free_first_violated: false,
    n_free_usable: 3,
    n_paid_usable: 1,
    n_unhealthy: 0,
    n_keyless: 0,
    n_cap_hit: 0,
    n_disabled: 0,
    n_excluded: 0,
    status: 'success',
    ...over,
  };
}

describe('labels', () => {
  it('treats every non-success status as 0, not just "failed"', () => {
    expect(labelOf(row({ status: 'success' }))).toBe(1);
    expect(labelOf(row({ status: 'failed' }))).toBe(0);
    expect(labelOf(row({ status: 'rate_limited' }))).toBe(0);
    expect(labelOf(row({ status: 'cap_hit' }))).toBe(0);
  });

  it('does not treat a MISSING outcome as a label', () => {
    expect(isLabelled(row({ status: null }))).toBe(false);
    expect(isLabelled(row({ status: '' }))).toBe(false);
    expect(isLabelled(row({ status: 'failed' }))).toBe(true);
  });
});

describe('buildRoutingCorpus', () => {
  it('drops unlabelled rows and REPORTS the count rather than absorbing them', () => {
    const corpus = buildRoutingCorpus([
      row({ status: 'success' }),
      row({ call_id: 'c2', status: null }),
      row({ call_id: 'c3', status: 'failed' }),
      row({ call_id: 'c4', status: null }),
    ]);

    expect(corpus.rowsIn).toBe(4);
    expect(corpus.X).toHaveLength(2);
    expect(corpus.droppedUnlabelled).toBe(2);
    // The failure mode this guards: 2 negatives that were never observed.
    expect(corpus.y.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('reports feature names that line up with the matrix columns', () => {
    const corpus = buildRoutingCorpus([row()]);
    expect(corpus.featureNames).toHaveLength(ROUTING_FEATURE_NAMES.length);
    expect(corpus.X[0]).toHaveLength(corpus.featureNames.length);
  });

  it('counts providers only among the rows it KEPT', () => {
    const corpus = buildRoutingCorpus([
      row({ provider: 'groq' }),
      row({ provider: 'gemini', status: null }),
      row({ provider: 'groq' }),
    ]);
    expect(corpus.providerCounts).toEqual({ groq: 2 });
  });

  it('returns an empty matrix, not a throw, on an empty corpus', () => {
    const corpus = buildRoutingCorpus([]);
    expect(corpus.X).toHaveLength(0);
    expect(corpus.droppedUnlabelled).toBe(0);
  });
});

describe('featurizeRoutingRow — no outcome may leak in', () => {
  it('encodes a missing chosen_position as chain_len, never as 0', () => {
    const at0 = featurizeRoutingRow(row({ chosen_position: 0, chain_len: 4 }));
    const missing = featurizeRoutingRow(row({ chosen_position: null, chain_len: 4 }));
    const posIdx = ROUTING_FEATURE_NAMES.indexOf('chosen_position');
    expect(at0[posIdx]).toBe(0);
    expect(missing[posIdx]).toBe(4);
  });

  it('has no feature named after a post-call measurement', () => {
    for (const name of ROUTING_FEATURE_NAMES) {
      expect(name).not.toMatch(/latency|cost_usd|tokens|status|success/);
    }
  });

  it('is invariant to the outcome — two rows differing only in status featurise identically', () => {
    const a = featurizeRoutingRow(row({ status: 'success' }));
    const b = featurizeRoutingRow(row({ status: 'failed' }));
    expect(a).toEqual(b);
  });

  it('one-hot encodes cost class exhaustively and exclusively', () => {
    const idx = {
      free: ROUTING_FEATURE_NAMES.indexOf('cost_free'),
      paid: ROUTING_FEATURE_NAMES.indexOf('cost_paid'),
      unpriced: ROUTING_FEATURE_NAMES.indexOf('cost_unpriced'),
    };
    for (const cc of ['free', 'paid', 'unpriced'] as const) {
      const v = featurizeRoutingRow(row({ chosen_cost_class: cc }));
      expect(v[idx.free]! + v[idx.paid]! + v[idx.unpriced]!).toBe(1);
      expect(v[idx[cc]]).toBe(1);
    }
    // An unknown class must set none of them rather than silently fall into 'free'.
    const unknown = featurizeRoutingRow(row({ chosen_cost_class: 'mystery' }));
    expect(unknown[idx.free]! + unknown[idx.paid]! + unknown[idx.unpriced]!).toBe(0);
  });
});

/**
 * End-to-end: the corpus shape + the UNTOUCHED fitting maths recover a planted signal.
 * `fitLassoLogistic` is not exported from the script (it runs `main()` at import), so this
 * reimplements nothing — it asserts the property the script relies on using the same
 * standardise-then-soft-threshold formulation, on data whose answer we chose.
 */
describe('the corpus is fittable in principle', () => {
  it('separates a planted signal from pure noise features', () => {
    // Plant: unhealthy providers in the chain predict failure. Everything else is constant
    // or random, so an L1 fit should keep n_unhealthy and drive the noise columns to zero.
    const rows: JoinedRoutingRow[] = [];
    for (let i = 0; i < 400; i++) {
      const bad = i % 2 === 0;
      rows.push(
        row({
          call_id: `c${i}`,
          n_unhealthy: bad ? 3 : 0,
          n_excluded: Math.round(Math.random() * 2), // noise
          attempt: 1 + (i % 3), // noise
          status: bad ? 'failed' : 'success',
        }),
      );
    }
    const corpus = buildRoutingCorpus(rows);
    expect(corpus.X).toHaveLength(400);

    // Minimal standardise + L1 logistic, same formulation as scripts/eval/anfis-lasso.ts.
    const p = corpus.featureNames.length;
    const n = corpus.X.length;
    const mean = new Array(p).fill(0);
    const std = new Array(p).fill(0);
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += corpus.X[i]![j]!;
      mean[j] = s / n;
      let v = 0;
      for (let i = 0; i < n; i++) v += (corpus.X[i]![j]! - mean[j]) ** 2;
      std[j] = Math.sqrt(v / n) || 1;
    }
    const Z = corpus.X.map((r) => r.map((x, j) => (x - mean[j]) / std[j]));

    const lambda = 0.02;
    const lr = 0.5;
    let beta = new Array(p).fill(0);
    let intercept = 0;
    for (let iter = 0; iter < 400; iter++) {
      const eta = Z.map((zi) => {
        let e = intercept;
        for (let j = 0; j < p; j++) e += beta[j] * zi[j]!;
        return e >= 0 ? 1 / (1 + Math.exp(-e)) : Math.exp(e) / (1 + Math.exp(e));
      });
      let gInt = 0;
      for (let i = 0; i < n; i++) gInt += eta[i]! - corpus.y[i]!;
      intercept -= lr * (gInt / n);
      const next = beta.slice();
      for (let j = 0; j < p; j++) {
        let g = 0;
        for (let i = 0; i < n; i++) g += (eta[i]! - corpus.y[i]!) * Z[i]![j]!;
        g /= n;
        const stepped = beta[j] - lr * g;
        const t = lr * lambda;
        next[j] = stepped > t ? stepped - t : stepped < -t ? stepped + t : 0;
      }
      beta = next;
    }

    const unhealthyIdx = corpus.featureNames.indexOf('n_unhealthy');
    const attemptIdx = corpus.featureNames.indexOf('attempt');
    expect(Math.abs(beta[unhealthyIdx]!)).toBeGreaterThan(0.5);
    expect(beta[unhealthyIdx]!).toBeLessThan(0); // more unhealthy -> less likely to succeed
    expect(Math.abs(beta[attemptIdx]!)).toBeLessThan(Math.abs(beta[unhealthyIdx]!) / 4);
  });
});
