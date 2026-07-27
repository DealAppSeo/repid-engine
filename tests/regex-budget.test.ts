import {
  matchWithBudget,
  DEFAULT_REGEX_BUDGET_MS,
  WORKER_STARTUP_CEILING_MS,
  activeWorkerCount,
} from '../src/services/regex-budget';
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

  test('the runaway thread really stops burning CPU — measured outside the module', async () => {
    // THE load-bearing test, and the one the first version of this file got wrong.
    //
    // "The budget stops it" is a claim about the MATCH, but every behavioural
    // assertion here can only see the CALLER: a version that resolves the promise
    // and abandons a live worker satisfies all of them while the regex keeps
    // burning a core. The first attempt pinned that gap with `activeWorkerCount()`
    // — module-private state, i.e. the module's own belief about the thread. Two
    // mutations left a genuinely unterminated worker running with the suite green.
    //
    // `process.cpuUsage()` is the OS's accounting for the whole process, worker
    // threads included. The module cannot fabricate it. Measured on this hardware:
    // terminated 0–3% of wall, leaked 77–97%. The 40% gate sits in the middle of
    // an order-of-magnitude gap, so it is not a tuned threshold.
    const r = await matchWithBudget(GROUPLESS_BLOWUP, 'i', LONG_SUBJECT, 200);
    expect(r.status).toBe('timeout');

    // Sampled only AFTER the promise settles, so this measures what happens once
    // the caller has been told the match is over — which is exactly when a leaked
    // thread is invisible and free to keep running.
    const cpuBefore = process.cpuUsage();
    const wallBefore = Date.now();
    await new Promise((res) => setTimeout(res, 600));
    const cpu = process.cpuUsage(cpuBefore);
    const wallMs = Date.now() - wallBefore;
    const cpuMs = (cpu.user + cpu.system) / 1000;

    expect(cpuMs).toBeLessThan(wallMs * 0.4);
  });

  test('the live-worker counter also returns to zero (operational aid, not the proof)', async () => {
    // Kept because a non-zero gauge is a useful leak signal in production, and
    // asserted against ZERO rather than a `before` snapshot: `toBe(before)` was
    // observed passing on a leaked result and failing on a clean one, because it
    // pins "no NET change" — a baseline that is already wrong stays wrong.
    const r = await matchWithBudget(GROUPLESS_BLOWUP, 'i', LONG_SUBJECT, 200);
    expect(r.status).toBe('timeout');
    const deadline = Date.now() + 20_000;
    while (activeWorkerCount() > 0 && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(activeWorkerCount()).toBe(0);
  });

  test('the budget covers the MATCH, not thread startup', async () => {
    // The defect this replaces: the deadline was armed before `new Worker(...)`,
    // so spawn was charged to the pattern. construct->online measures 98–142 ms
    // idle on this hardware and was observed at 136–1172 ms under parallel load —
    // 40% to 470% of the whole 250 ms budget spent before the regex ran a step.
    // A budget that a busy machine can exhaust reports honest patterns as
    // pathological, and the failure is load-dependent, so CI lands on the good
    // side of it and an idle laptop does not.
    //
    // A budget SMALLER than measured spawn cost is the sharpest form of the
    // question: under the old arming this could only ever time out.
    const tinyBudget = 25;
    expect(tinyBudget).toBeLessThan(98); // less than the fastest spawn ever measured here
    const r = await matchWithBudget('^[0-9a-f]{40}$', 'i', 'a'.repeat(40), tinyBudget);
    expect(r).toEqual({ status: 'ok', matched: true });
  });

  test('the startup ceiling is separate from the match budget and far looser', () => {
    // Two clocks, because they answer different questions: "is this pattern
    // pathological?" and "is this machine wedged?". Collapsing them is the bug
    // above. The ceiling must never be tight enough to depend on load, and a
    // startup failure reports as `error`, never `timeout` — see the type.
    expect(DEFAULT_REGEX_BUDGET_MS).toBe(250);
    expect(WORKER_STARTUP_CEILING_MS).toBe(30_000);
    expect(WORKER_STARTUP_CEILING_MS).toBeGreaterThan(DEFAULT_REGEX_BUDGET_MS * 100);
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
  test('a timed-out match is unclear/unverified — never approved, and never blamed on the agent', async () => {
    // This test used to assert `rejected`/`assertion_failed` while its own title
    // said unclear/unverified — the weaker-property pattern again, and it shipped.
    //
    // Two properties, and both matter. NEVER APPROVED is the safety half: a check
    // that could not run must not read as one that passed. NOT REJECTED is the
    // fairness half: these verdicts feed RepID, and `rejected` says the agent's
    // output was wrong when what actually happened is that the OPERATOR supplied a
    // non-terminating pattern. The identical pattern caught one layer earlier, by
    // `hasBacktrackingRisk` at parse time, already returns unclear/unverified —
    // which guard happened to catch it cannot change whose fault it is.
    const r = (await verifyTaskDeterministically({
      expected_output: JSON.stringify({ matches: GROUPLESS_BLOWUP }),
      result: LONG_SUBJECT,
    }))!;
    expect(r).not.toBeNull();
    expect(r.verifier_verdict).toBe('unclear');
    expect(r.final_verdict).toBe('unverified');
    expect(r.verified_output.reason).toBe('check_not_evaluable:matches');
    const matchCheck = r.verified_output.checks.find((c: any) => c.kind === 'matches')!;
    expect(matchCheck.ok).toBe(false);
    expect(matchCheck.evaluated).toBe(false);
    expect(matchCheck.detail).toMatch(/budget/);
  });

  test('an unevaluable check outranks a failed one — an incomplete grade is not a rejection', async () => {
    // The precedence, pinned in the direction that can actually go wrong. Here the
    // regex times out AND `min_length` genuinely fails. Ordering by "any failure
    // wins" would report `rejected`/`assertion_failed`, asserting a complete grade
    // that never happened. The unevaluable check dominates; the failed one is still
    // visible in `checks` for whoever debugs it.
    const r = (await verifyTaskDeterministically({
      expected_output: JSON.stringify({ matches: GROUPLESS_BLOWUP, min_length: 10_000_000 }),
      result: LONG_SUBJECT,
    }))!;
    expect(r.verifier_verdict).toBe('unclear');
    expect(r.final_verdict).toBe('unverified');
    expect(r.verified_output.reason).toMatch(/^check_not_evaluable:/);
    expect(r.verified_output.checks.find((c: any) => c.kind === 'min_length')!.ok).toBe(false);
  });

  test('an ordinary failed assertion is still rejected — the change did not soften grading', async () => {
    // The counterweight. Without this, deleting the `evaluated` distinction and
    // routing EVERY failure to unclear/unverified would satisfy the two tests above
    // while quietly ending rejection altogether — a grader that never blames anyone.
    const r = (await verifyTaskDeterministically({
      expected_output: JSON.stringify({ matches: '^exactly-this$' }),
      result: 'something else',
    }))!;
    expect(r.verifier_verdict).toBe('rejected');
    expect(r.final_verdict).toBe('rejected');
    expect(r.verified_output.reason).toBe('assertion_failed');
    expect(r.verified_output.checks.find((c: any) => c.kind === 'matches')!.evaluated).toBe(true);
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
