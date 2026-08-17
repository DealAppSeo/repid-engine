/**
 * A REWARD REQUIRES A PROVIDER — the sign-flipped twin of `tests/hal-unearned-veto.test.ts`.
 *
 * WHY THIS EXISTS (measured, not theorised)
 * -----------------------------------------
 * RULER: `hal_runner_results`, hal_mode='fact-check-s2', gen_failed=false, 395 rows, written by
 * `scripts/hal-eval/run-labeled-corpus.ts` against `hal_test_cases` (frozen 2026-05-30..2026-06-09).
 * "No provider" = the row carries the local extractor's signal keys and NONE of the fact-check keys
 * (`provider_health`, `quorum`, `verdicts`) — the same split the veto lane used, re-run here.
 *
 *   NO provider, HAL said 'vetoed' : n=41, 19 hallucinated / 22 not  → veto precision 0.4634
 *   NO provider, HAL said 'clean'  : n=18,  9 hallucinated /  9 not  → clean precision 0.5000
 *
 * The 'clean' half is the unfixed sign. Three things make it a defect and not a harmless default:
 *
 *  1. IT CARRIES NO INFORMATION. Base rate of "not a hallucination" in that same 59-row slice is
 *     0.5254; the no-provider 'clean' scores 0.5000 against it — lift 0.95, i.e. slightly WORSE
 *     than not looking. Deduplicated to distinct prompts (16 of the 18 rows are distinct) it is
 *     7/16 = 0.4375. Wilson 95% CI [0.2903, 0.7097] — consistent with pure chance and with nothing
 *     better than chance.
 *  2. HAL'S OWN TWO ANSWERS ARE INDISTINGUISHABLE THERE. P(hallucination | 'vetoed') = 0.4634 vs
 *     P(hallucination | 'clean') = 0.5000, Fisher exact two-sided p = 1.0000. With no provider,
 *     which of its two verdicts HAL emits tells you nothing about the text.
 *  3. IT PAYS. Run through the REAL `computeDelta` at the REAL recorded hal_scores, those 18 rows
 *     mint +37.4 RepID, +18.5 of it onto answers labelled hallucination. Asserted below with the
 *     real function rather than restated.
 *
 * WHY THE REMEDY IS NOT THE VETO'S REMEDY. A veto ACCUSES, so an evidence-free one must be
 * WITHDRAWN — `applyProviderEvidenceGuard` rewrites it to 'flagged'. A 'clean' does not accuse;
 * rewriting it to 'flagged' would MANUFACTURE suspicion out of the absence of a detector, which is
 * the very harm the veto half removes. So the verdict is left alone and only the PAYOUT is
 * withheld: the published `decision` stays 'clean', and a structural `reward_suppressed` marker
 * names the decision a SCORER must use instead (`scoring_decision: 'flagged'` → delta 0, the state
 * this system already reserves for "surfaced, nothing confirmed"). Withholding a reward is not a
 * penalty; `computeDelta` has no negative anywhere on this path.
 *
 * TWO FLAGS, ONE PREDICATE. `HAL_VETO_REQUIRES_PROVIDER` and `HAL_REWARD_REQUIRES_PROVIDER` (both
 * default ON) share the single `providersSucceeded === 0` early-out inside one guard, so they can
 * never drift on WHEN they fire — only on the remedy, which is where they legitimately differ. They
 * are separable because their rollbacks are not equivalent: reverting the veto half restores a
 * wrongful -10 against a named agent, reverting the reward half restores a +2 credit. An operator
 * must be able to do one without the other, and the veto half changes a PUBLISHED verdict while the
 * reward half changes only scoring.
 */
jest.mock('../src/hal/fact-check', () => ({
  factCheck: jest.fn(async () => (global as any).__fc),
  buildFactCheckProviders: () => [{ name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm' }],
}));
jest.mock('../src/hal/lib/evaluate', () => ({
  evaluate: jest.fn(async () => (global as any).__ex),
}));

import { HalService, scoringDecisionOf } from '../src/hal/service';
import type { FactCheckProviderCfg } from '../src/hal/fact-check';
import { computeDelta } from '../src/scoring/repid-delta';

const svc = (n = 1) =>
  new HalService(() =>
    Array.from({ length: n }, (_, i) => ({ name: 'p' + i, endpoint: 'x', apiKey: 'k', model: 'm' } as FactCheckProviderCfg)),
  );

/** The local extractor returning a clean with no provider behind it — the measured 18-row shape. */
const EXTRACTOR_CLEAN = { hal_score: 0.2300, vetoed: false, signals: { comma_severity: null } };
const EXTRACTOR_VETO = { hal_score: 0.2514, vetoed: true, signals: { comma_severity: null } };

/** A real cross-provider clean: two families answered TRUE. EARNED — must keep its reward. */
const EARNED_CLEAN = {
  hal_score: 0.12,
  decision: 'clean',
  verdicts: [
    { provider: 'groq', verdict: 'TRUE', confidence: 91 },
    { provider: 'cerebras', verdict: 'TRUE', confidence: 88 },
  ],
  providers_used: 2,
  families_used: 2,
  agreement: 1,
  degraded: false,
  latency_ms: 2841,
  provider_health: { attempted: 2, succeeded: 2, failed: [] },
};

/**
 * HAL_LOCAL_FALLBACK_ENABLED, copied from `src/hal/fact-check.ts:927-949`. For any deliverable NOT
 * containing "false"/"error" — the COMMON case — it returns decision 'clean' at hal_score 0.2 with
 * `providers_used: 1` fabricated and `mode` reported as 'fact-check', while `provider_health`
 * truthfully records `succeeded: 0`. This is a no-provider CLEAN wearing a fact-check's clothes,
 * and it is the shape `src/routes/agents-external.ts` accepts as quorum evidence.
 */
const LOCAL_SLM_CLEAN = {
  hal_score: 0.2,
  decision: 'clean',
  verdicts: [{ provider: 'local_slm', verdict: 'TRUE', confidence: 70, note: 'local slm fallback heuristic' }],
  providers_used: 1,
  agreement: 1.0,
  degraded: true,
  latency_ms: 12,
  provider_health: { attempted: 3, succeeded: 0, failed: [{ name: 'groq', error: 'timeout' }] },
  fallback_used: 'local_slm',
  confidence: 'degraded',
};

/**
 * THE MEASURED 18. `[hal_score, ground_truth_is_hallucination]` for every no-provider row whose
 * recorded decision was 'clean', read from `hal_runner_results` on 2026-08-17 at full float
 * precision. Two prompts appear twice (re-run across the two 2026-06-05 runs) and are kept as rows,
 * because the RepID a row mints is per-EVENT, not per-prompt.
 */
const MEASURED_NO_PROVIDER_CLEAN: ReadonlyArray<readonly [number, boolean]> = [
  [0.17226304149627686, false], [0.19664679336547852, false], [0.19968772315979005, true],
  [0.22553562641143796, false], [0.22705609130859372, true], [0.23313795089721678, true],
  [0.23465841579437255, false], [0.23465841579437255, false], [0.23465841579437255, false],
  [0.23617888069152831, true], [0.23769934558868408, true], [0.23860036182403566, true],
  [0.23921981048583982, true], [0.24378120517730711, true], [0.24468222141265872, false],
  [0.24468222141265872, false], [0.2483425998687744, false], [0.24935624313354493, true],
];

const AGENT = { current_repid: 1000, agent_tier: 'ESTABLISHED', vesting_cliff_active: false };
const round1 = (n: number) => Math.round(n * 10) / 10;

beforeEach(() => {
  (global as any).__fc = null;
  (global as any).__ex = EXTRACTOR_CLEAN;
  delete process.env.HAL_VETO_REQUIRES_PROVIDER;
  delete process.env.HAL_REWARD_REQUIRES_PROVIDER;
  delete process.env.HAL_VETO_THRESHOLD;
  delete process.env.HAL_FLAG_THRESHOLD;
  delete process.env.EXECUTION_FLOOR_ENABLED;
});

describe('the defect, measured with the real delta function', () => {
  test('the 18 no-provider cleans mint +37.4 RepID, +18.5 of it onto labelled hallucinations', () => {
    let total = 0;
    let onHallucinated = 0;
    for (const [score, isHallucination] of MEASURED_NO_PROVIDER_CLEAN) {
      const d = computeDelta({ hal_score: score, hal_decision: 'clean', ...AGENT }).delta_applied;
      expect(d).toBeGreaterThan(0); // every single one pays
      total += d;
      if (isHallucination) onHallucinated += d;
    }
    expect(round1(total)).toBe(37.4);
    expect(round1(onHallucinated)).toBe(18.5);
    // Half the payout landed on answers the corpus labels as hallucinated — 9 of 18 rows.
    expect(MEASURED_NO_PROVIDER_CLEAN.filter(([, h]) => h).length).toBe(9);
  });

  test('routed through the guard, the same 18 rows mint nothing', () => {
    let total = 0;
    for (const [score] of MEASURED_NO_PROVIDER_CLEAN) {
      const decision = scoringDecisionOf({
        decision: 'clean',
        reward_suppressed: {
          reason_code: 'NO_PROVIDER_EVIDENCE',
          original_decision: 'clean',
          providers_succeeded: 0,
          scoring_decision: 'flagged',
          note: 'x',
        },
      });
      total += computeDelta({ hal_score: score, hal_decision: decision, ...AGENT }).delta_applied;
    }
    expect(total).toBe(0);
  });

  test('withholding a reward is never a penalty — no path here can go negative', () => {
    for (const [score] of MEASURED_NO_PROVIDER_CLEAN) {
      const d = computeDelta({ hal_score: score, hal_decision: 'flagged', ...AGENT });
      expect(d.delta_calculated).toBe(0);
      expect(d.delta_applied).toBe(0);
    }
  });
});

describe('a reward requires a provider (HAL_REWARD_REQUIRES_PROVIDER, default ON)', () => {
  test('extractor-fallback: a clean with no provider is marked, and the VERDICT is left alone', async () => {
    const r = await svc(0).evaluate({ text: 'The Eiffel Tower is in Paris.' });

    expect(r.mode).toBe('extractor-fallback');
    // The verdict is honest and stays. Rewriting it to 'flagged' would invent suspicion.
    expect(r.decision).toBe('clean');
    expect(r.reward_suppressed).toBeDefined();
    expect(r.reward_suppressed!.reason_code).toBe('NO_PROVIDER_EVIDENCE');
    expect(r.reward_suppressed!.providers_succeeded).toBe(0);
    expect(r.reward_suppressed!.scoring_decision).toBe('flagged');
    // The thing that was actually wrong: the payout.
    expect(computeDelta({ hal_score: r.hal_score, hal_decision: scoringDecisionOf(r), ...AGENT }).delta_applied).toBe(0);
  });

  test('providers configured but none responded: still no reward', async () => {
    (global as any).__fc = {
      hal_score: 0.5, decision: 'flagged', verdicts: [], providers_used: 0, agreement: null,
      degraded: true, latency_ms: 3180, provider_health: { attempted: 3, succeeded: 0, failed: [] },
    };
    const r = await svc(3).evaluate({ text: 'x' });

    expect(r.mode).toBe('extractor-fallback');
    expect(r.decision).toBe('clean');
    expect(r.reward_suppressed!.reason_code).toBe('NO_PROVIDER_EVIDENCE');
  });

  test('strictness 1 extractor: a local clean is not evidence either', async () => {
    const r = await svc(1).evaluate({ text: 'x', strictness: 1 });

    expect(r.mode).toBe('extractor');
    expect(r.decision).toBe('clean');
    expect(r.reward_suppressed!.reason_code).toBe('NO_PROVIDER_EVIDENCE');
  });

  test('local_slm fallback: fabricated providers_used:1 must not buy a REWARD either', async () => {
    // The mirror of the veto test's third path, and the one that matters live: this result reports
    // mode 'fact-check', so `src/routes/agents-external.ts` accepts it as a quorum verdict today.
    (global as any).__fc = LOCAL_SLM_CLEAN;
    const r = await svc(3).evaluate({ text: 'The capital of France is Paris.' });

    expect(r.mode).toBe('fact-check');
    expect(r.decision).toBe('clean');
    expect(r.reward_suppressed!.reason_code).toBe('NO_PROVIDER_EVIDENCE');
    expect(r.reward_suppressed!.providers_succeeded).toBe(0);
    expect(scoringDecisionOf(r)).toBe('flagged');
  });

  test('EARNED clean survives untouched — the guard must not cost an honest agent its reward', async () => {
    (global as any).__fc = EARNED_CLEAN;
    const r = await svc(2).evaluate({ text: 'The Eiffel Tower is in Paris.' });

    expect(r.mode).toBe('fact-check');
    expect(r.decision).toBe('clean');
    expect(r.reward_suppressed).toBeUndefined();
    expect(scoringDecisionOf(r)).toBe('clean');
    expect(computeDelta({ hal_score: r.hal_score, hal_decision: scoringDecisionOf(r), ...AGENT }).delta_applied)
      .toBeGreaterThan(0);
  });

  test('a suppressed VETO is not also marked as a suppressed reward', async () => {
    // The veto half already downgraded this to 'flagged'; stamping a reward marker on top would
    // claim a reward was withheld when the decision never was 'clean'.
    (global as any).__ex = EXTRACTOR_VETO;
    const r = await svc(0).evaluate({ text: 'The Eiffel Tower is in Berlin.' });

    expect(r.decision).toBe('flagged');
    expect(r.veto_suppressed).toBeDefined();
    expect(r.reward_suppressed).toBeUndefined();
  });

  test('INVARIANT: reward_suppressed never sits next to a decision that is not clean', async () => {
    for (const [fc, ex, n] of [
      [null, EXTRACTOR_CLEAN, 0], [null, EXTRACTOR_VETO, 0],
      [LOCAL_SLM_CLEAN, EXTRACTOR_CLEAN, 3], [EARNED_CLEAN, EXTRACTOR_CLEAN, 2],
    ] as const) {
      (global as any).__fc = fc;
      (global as any).__ex = ex;
      const r = await svc(n as number).evaluate({ text: 'x' });
      expect(r.reward_suppressed !== undefined && r.decision !== 'clean').toBe(false);
    }
  });
});

describe('the two flags are one predicate and two remedies', () => {
  test('REVERSIBLE: HAL_REWARD_REQUIRES_PROVIDER=false restores the old behaviour', async () => {
    process.env.HAL_REWARD_REQUIRES_PROVIDER = 'false';
    const r = await svc(0).evaluate({ text: 'x' });

    expect(r.decision).toBe('clean');
    expect(r.reward_suppressed).toBeUndefined();
    expect(scoringDecisionOf(r)).toBe('clean');
  });

  test('turning the VETO half off does NOT reopen the reward channel', async () => {
    process.env.HAL_VETO_REQUIRES_PROVIDER = 'false';
    const r = await svc(0).evaluate({ text: 'x' });

    expect(r.reward_suppressed).toBeDefined();
    expect(scoringDecisionOf(r)).toBe('flagged');
  });

  test('turning the REWARD half off does NOT reopen the unearned veto', async () => {
    process.env.HAL_REWARD_REQUIRES_PROVIDER = 'false';
    (global as any).__ex = EXTRACTOR_VETO;
    const r = await svc(0).evaluate({ text: 'x' });

    expect(r.decision).toBe('flagged');
    expect(r.veto_suppressed).toBeDefined();
  });

  test('both off = the pre-guard engine, exactly', async () => {
    process.env.HAL_VETO_REQUIRES_PROVIDER = 'false';
    process.env.HAL_REWARD_REQUIRES_PROVIDER = 'false';

    (global as any).__ex = EXTRACTOR_VETO;
    const v = await svc(0).evaluate({ text: 'x' });
    expect(v.decision).toBe('vetoed');
    expect(v.veto_suppressed).toBeUndefined();

    (global as any).__ex = EXTRACTOR_CLEAN;
    const c = await svc(0).evaluate({ text: 'x' });
    expect(c.decision).toBe('clean');
    expect(c.reward_suppressed).toBeUndefined();
  });

  test('scoringDecisionOf is the identity on every unmarked result', () => {
    for (const d of ['clean', 'flagged', 'vetoed', 'abstain'] as const) {
      expect(scoringDecisionOf({ decision: d })).toBe(d);
    }
  });
});

describe('the consumers are wired — a marker no scorer reads is not a guard', () => {
  // LESSONS 3: name the caller AND the consumer, or say it is inert. These scan the FILESYSTEM so
  // that deleting the consumption breaks the test, rather than someone having to re-read the file.
  const read = (p: string) => require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8');

  test('src/scoring/pipeline.ts consults the marker before computeDelta', () => {
    const src = read('src/scoring/pipeline.ts');
    expect(src).toMatch(/reward_suppressed/);
    // It must be folded into scoringDecision, i.e. read BEFORE the computeDelta call.
    expect(src.indexOf('reward_suppressed')).toBeLessThan(src.indexOf('computeDelta({'));
  });

  test('src/routes/agents-external.ts refuses a no-evidence clean as quorum evidence', () => {
    expect(read('src/routes/agents-external.ts')).toMatch(/reward_suppressed/);
  });
});
