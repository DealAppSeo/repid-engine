import { matchWithBudget, DEFAULT_REGEX_BUDGET_MS, activeWorkerCount } from '../src/services/regex-budget';
import { hasBacktrackingRisk, verifyTaskDeterministically } from '../src/services/task-verify-leg';

/**
 * The point of these tests is ONE claim: the budget bounds harm for patterns the
 * shape heuristic does not recognise. Everything else here is supporting detail.
 *
 * `hasBacktrackingRisk` has been bypassed four times across Beats 32/33/38, each
 * fix narrowing the gap and each next reading finding another shape. The space of
 * dangerous regexes is not enumerable by inspecting the source string, so the
 * guarantee has to be a wall-clock deadline rather than a better recogniser.
 */

// A pattern with NO group at all — so `hasBacktrackingRisk`, which only inspects
// `(`, returns false and the contract parses clean — but whose adjacent unbounded
// quantifiers blow up polynomially on a long non-matching subject. This is a real
// bypass of the live heuristic, not a hypothetical one, and the test below proves
// the heuristic accepts it rather than asserting that it does.
const GROUPLESS_BLOWUP = 'a*a*a*a*a*a*a*a*a*b';
const LONG_SUBJECT = 'a'.repeat(20_000); // MAX_SUBJECT_LEN, i.e. what the grader really passes

jest.setTimeout(30_000);

describe('regex budget — the guarantee under the heuristic', () => {
  test('the heuristic ACCEPTS a groupless catastrophic pattern (this is the gap)', () => {
    // If this ever starts returning true the heuristic has been widened, and the
    // test below stops proving what it claims — so the gap is pinned, not assumed.
    expect(hasBacktrackingRisk(GROUPLESS_BLOWUP)).toBe(false);
  });

  test('and the budget stops it anyway', async () => {
    const started = Date.now();
    const r = await matchWithBudget(GROUPLESS_BLOWUP, 'i', LONG_SUBJECT, 200);
    const elapsed = Date.now() - started;
    expect(r.status).toBe('timeout');
    // The status IS the proof; this second assertion only rules out "returned a
    // timeout after ten minutes". The ceiling is deliberately two orders of
    // magnitude above the 200 ms budget: these tests were observed failing once
    // when a parallel verification saturated the box, and a bound that fails
    // under load is worse than no bound — it trains people to re-run until green.
    expect(elapsed).toBeLessThan(20_000);
  });

  test('the runaway thread is actually killed, not just abandoned', async () => {
    // The half of the budget that no behavioural assertion can see. A version that
    // resolves the promise and leaves the worker running satisfies every other test
    // in this file while the match keeps burning a core — a leak that is
    // indistinguishable from a working budget from the caller's side. Without this,
    // "the budget stops it" would be pinning the weaker property (the CALLER stops
    // waiting) than the sentence it is cited for (the MATCH stops running).
    const before = activeWorkerCount();
    const r = await matchWithBudget(GROUPLESS_BLOWUP, 'i', LONG_SUBJECT, 200);
    expect(r.status).toBe('timeout');
    const deadline = Date.now() + 20_000;
    while (activeWorkerCount() > before && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(activeWorkerCount()).toBe(before);
  });

  test('an honest pattern still returns a real answer, well inside the budget', async () => {
    // The budget must not be a silent kill switch on legitimate contracts: if this
    // regressed to always-timeout, every `matches` check would read as unevaluated
    // and nothing would ever be graded again — a failure that looks like success.
    const hit = await matchWithBudget('^[0-9a-f]{40}$', 'i', 'a'.repeat(40));
    expect(hit).toEqual({ status: 'ok', matched: true });
    const miss = await matchWithBudget('^[0-9a-f]{40}$', 'i', 'nope');
    expect(miss).toEqual({ status: 'ok', matched: false });
  });

  test('the i flag is actually honoured (the grader relies on it)', async () => {
    expect(await matchWithBudget('DEPLOYED', 'i', 'deployed_commit')).toEqual({
      status: 'ok',
      matched: true,
    });
    expect(await matchWithBudget('DEPLOYED', '', 'deployed_commit')).toEqual({
      status: 'ok',
      matched: false,
    });
  });

  test('an invalid pattern is an error, not a timeout and not a false miss', async () => {
    const r = await matchWithBudget('([unclosed', 'i', 'x');
    expect(r.status).toBe('error');
    expect((r as any).message).toMatch(/invalid pattern/);
  });

  test('the default budget is generous enough to be a safety net, not a limit', () => {
    // Recorded as a literal so lowering it is a deliberate act. A legitimate match
    // over 20 KB completes in well under a millisecond; three orders of magnitude
    // of headroom is what makes a timeout mean "pathological", never "unlucky".
    expect(DEFAULT_REGEX_BUDGET_MS).toBe(250);
  });

  test('concurrent bounded matches do not interfere', async () => {
    // Each match gets its own worker; a shared or reused one would let a runaway
    // pattern starve its neighbours, which is the original defect wearing a hat.
    const results = await Promise.all([
      matchWithBudget(GROUPLESS_BLOWUP, 'i', LONG_SUBJECT, 200),
      matchWithBudget('^ok$', 'i', 'ok'),
      matchWithBudget('^ok$', 'i', 'no'),
    ]);
    expect(results[0].status).toBe('timeout');
    expect(results[1]).toEqual({ status: 'ok', matched: true });
    expect(results[2]).toEqual({ status: 'ok', matched: false });
  });
});

describe('the verify leg reports a budget timeout honestly', () => {
  test('a timed-out match is unclear/unverified — never approved', async () => {
    // The load-bearing assertion is `ok === false` reaching the verdict: a check
    // that could not be evaluated must not read as one that passed. A grader that
    // approved on timeout would hand a clean verdict to the exact input designed
    // to break it.
    const r = (await verifyTaskDeterministically({
      expected_output: JSON.stringify({ matches: GROUPLESS_BLOWUP }),
      result: LONG_SUBJECT,
    }))!;
    expect(r).not.toBeNull();
    expect(r.verifier_verdict).toBe('rejected');
    expect(r.final_verdict).toBe('rejected');
    const matchCheck = r.verified_output.checks.find((c: any) => c.kind === 'matches');
    expect(matchCheck.ok).toBe(false);
    expect(matchCheck.detail).toMatch(/budget/);
  });

  test('a grader fault never throws into the bridge poller', async () => {
    // The bridge catches, but relying on that is how a partial write happens. The
    // leg returns a verdict for every input it is given.
    await expect(
      verifyTaskDeterministically({
        expected_output: JSON.stringify({ matches: '^ok$' }),
        result: 'ok',
      })
    ).resolves.toBeTruthy();
  });
});
