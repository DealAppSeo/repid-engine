/**
 * anfis-poa-feed.test.ts — locks the ANFIS reward-model FEED:
 *   (1) the proper-scoring (Brier) reward + EMA math, and
 *   (2) the shadow ingest: a correct/high-confidence POA outcome moves the per-(model,taskType)
 *       trust weight UP, and a confident-WRONG outcome moves it DOWN.
 *
 * No real Supabase: a tiny in-memory fake mimics the supabase-js query builder
 * (.select().eq().eq().maybeSingle() + .upsert()) backed by a Map, so sequential ingests
 * read back the weight they just wrote (real read-modify-write).
 */
import {
  properScoreReward,
  computeReward,
  emaUpdate,
  normalizeConfidence,
  ingestPoaOutcome,
  ingestPoaOutcomes,
  DEFAULT_TRUST_WEIGHT,
  DEFAULT_EMA_ALPHA,
  type PoaOutcome,
} from '../src/decisioning/anfis-poa-feed';

/** In-memory fake supabase client keyed by (model, task_type). Supports the exact chain the feed uses. */
function makeFakeSb() {
  const store = new Map<string, any>();
  const writes: any[] = [];
  const key = (m: string, t: string) => `${m}::${t}`;
  const sb: any = {
    from: (_table: string) => {
      let fModel = '';
      let fTask = '';
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: string) => {
          if (col === 'model') fModel = val;
          if (col === 'task_type') fTask = val;
          return builder;
        },
        maybeSingle: async () => ({ data: store.get(key(fModel, fTask)) ?? null, error: null }),
        upsert: async (row: any) => {
          store.set(key(row.model, row.task_type), row);
          writes.push(row);
          return { error: null };
        },
      };
      return builder;
    },
  };
  return { sb, writes, store };
}

const base: Omit<PoaOutcome, 'confidence' | 'correct'> = {
  agent: 'sophia',
  model: 'llama-3.1-8b-instant',
  family: 'llama',
  taskType: 'fact-check',
  role: 'verifier',
};

describe('properScoreReward — Brier reward is strictly proper', () => {
  test('correct + certain → reward 1', () => {
    expect(properScoreReward(1, true)).toBeCloseTo(1, 6);
  });
  test('confident + WRONG → reward 0', () => {
    expect(properScoreReward(1, false)).toBeCloseTo(0, 6);
  });
  test('hedged (p=0.5) scores the same either way', () => {
    expect(properScoreReward(0.5, true)).toBeCloseTo(0.75, 6);
    expect(properScoreReward(0.5, false)).toBeCloseTo(0.75, 6);
  });
  test('a correct answer scores higher the more confident it was', () => {
    expect(properScoreReward(0.9, true)).toBeGreaterThan(properScoreReward(0.6, true));
  });
  test('a wrong answer scores lower the more confident it was', () => {
    expect(properScoreReward(0.9, false)).toBeLessThan(properScoreReward(0.6, false));
  });
  test('accepts 0..100 percentage confidences', () => {
    expect(normalizeConfidence(95)).toBeCloseTo(0.95, 6);
    expect(properScoreReward(95, true)).toBeCloseTo(properScoreReward(0.95, true), 6);
  });
});

describe('computeReward — RepID delta is a bounded confirming nudge, correctness dominates', () => {
  test('confident-wrong stays below the neutral start even with a large POSITIVE repidDelta', () => {
    // The nudge cannot rescue a confident-wrong answer above the 0.5 neutral prior.
    const r = computeReward({ confidence: 0.95, correct: false, repidDelta: 1000 });
    expect(r).toBeLessThan(DEFAULT_TRUST_WEIGHT);
  });
  test('a positive delta nudges a correct outcome up (or holds at the ceiling)', () => {
    const withDelta = computeReward({ confidence: 0.7, correct: true, repidDelta: 25 });
    const noDelta = computeReward({ confidence: 0.7, correct: true, repidDelta: 0 });
    expect(withDelta).toBeGreaterThanOrEqual(noDelta);
  });
});

describe('emaUpdate', () => {
  test('w moves toward the reward by alpha', () => {
    expect(emaUpdate(0.5, 1, 0.2)).toBeCloseTo(0.6, 6);
    expect(emaUpdate(0.5, 0, 0.2)).toBeCloseTo(0.4, 6);
  });
});

describe('ingestPoaOutcome — SHADOW learning moves the trust weight the right direction', () => {
  test('correct + high confidence moves the weight UP from the neutral prior', async () => {
    const { sb, writes } = makeFakeSb();
    const r = await ingestPoaOutcome({ ...base, confidence: 0.95, correct: true, repidDelta: 25 }, sb);

    expect(r.weightBefore).toBe(DEFAULT_TRUST_WEIGHT);
    expect(r.weightAfter).toBeGreaterThan(r.weightBefore); // UP
    expect(r.persisted).toBe(true);
    expect(r.sampleCount).toBe(1);
    // persisted row is advisory-pure and carries the learned weight
    expect(writes).toHaveLength(1);
    expect(writes[0].routed_live).toBe(false);
    expect(writes[0].model).toBe(base.model);
    expect(writes[0].task_type).toBe(base.taskType);
    expect(writes[0].trust_weight).toBeGreaterThan(DEFAULT_TRUST_WEIGHT);
  });

  test('confident + WRONG moves the weight DOWN from the neutral prior', async () => {
    const { sb, writes } = makeFakeSb();
    const r = await ingestPoaOutcome({ ...base, confidence: 0.95, correct: false, repidDelta: -10 }, sb);

    expect(r.weightBefore).toBe(DEFAULT_TRUST_WEIGHT);
    expect(r.weightAfter).toBeLessThan(r.weightBefore); // DOWN
    expect(writes[0].trust_weight).toBeLessThan(DEFAULT_TRUST_WEIGHT);
    expect(writes[0].last_correct).toBe(false);
  });

  test('repeated correct/high-confidence outcomes drive the weight monotonically upward', async () => {
    const { sb } = makeFakeSb();
    let prev = DEFAULT_TRUST_WEIGHT;
    for (let i = 0; i < 6; i++) {
      const r = await ingestPoaOutcome({ ...base, confidence: 0.98, correct: true, repidDelta: 25 }, sb);
      expect(r.weightAfter).toBeGreaterThan(prev); // strictly climbing toward ~1
      expect(r.sampleCount).toBe(i + 1);
      prev = r.weightAfter;
    }
    expect(prev).toBeGreaterThan(0.85);
  });

  test('a good model and a bad model on the SAME task type diverge (per-key isolation)', async () => {
    const { sb } = makeFakeSb();
    let good = 0;
    let bad = 0;
    for (let i = 0; i < 5; i++) {
      good = (await ingestPoaOutcome({ ...base, model: 'good-model', confidence: 0.95, correct: true }, sb)).weightAfter;
      bad = (await ingestPoaOutcome({ ...base, model: 'bad-model', confidence: 0.95, correct: false }, sb)).weightAfter;
    }
    expect(good).toBeGreaterThan(DEFAULT_TRUST_WEIGHT);
    expect(bad).toBeLessThan(DEFAULT_TRUST_WEIGHT);
    expect(good).toBeGreaterThan(bad);
  });

  test('dry-run (persist:false) computes the move but writes NOTHING', async () => {
    const { sb, writes } = makeFakeSb();
    const r = await ingestPoaOutcome({ ...base, confidence: 0.95, correct: true }, sb, { persist: false });
    expect(r.weightAfter).toBeGreaterThan(r.weightBefore); // still computed
    expect(r.persisted).toBe(false);
    expect(writes).toHaveLength(0); // nothing persisted
  });

  test('alpha override controls responsiveness', async () => {
    const { sb } = makeFakeSb();
    const slow = await ingestPoaOutcome({ ...base, model: 'm-slow', confidence: 1, correct: true }, sb, { alpha: 0.05 });
    const fast = await ingestPoaOutcome({ ...base, model: 'm-fast', confidence: 1, correct: true }, sb, { alpha: 0.5 });
    // both go up; the higher alpha moves further in one step
    expect(fast.weightAfter - fast.weightBefore).toBeGreaterThan(slow.weightAfter - slow.weightBefore);
    expect(DEFAULT_EMA_ALPHA).toBe(0.2);
  });

  test('ingestPoaOutcomes batches sequentially and accumulates sample_count', async () => {
    const { sb } = makeFakeSb();
    const results = await ingestPoaOutcomes(
      [
        { ...base, confidence: 0.9, correct: true },
        { ...base, confidence: 0.9, correct: true },
        { ...base, confidence: 0.9, correct: true },
      ],
      sb,
    );
    expect(results.map((r) => r.sampleCount)).toEqual([1, 2, 3]);
    expect(results[2]!.weightAfter).toBeGreaterThan(results[0]!.weightAfter);
  });
});
