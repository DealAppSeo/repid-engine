/**
 * The deterministic verify leg.
 *
 * The load-bearing properties under test, in order of how badly it hurts if they break:
 *  1. Every emitted verdict is a value the prod CHECK constraints accept.
 *  2. No contract → no verdict at all (the columns stay NULL, honestly).
 *  3. A contract that cannot confirm is never read as confirming.
 *  4. The mode lever fails safe: anything unrecognised means `off`.
 */
import {
  FINAL_VERDICTS,
  PLACEHOLDER_MARKERS,
  VERIFIER_VERDICTS,
  VERIFY_METHOD,
  hasBacktrackingRisk,
  parseContract,
  resolveVerifyLegMode,
  verifyTaskDeterministically,
} from '../src/services/task-verify-leg';

/**
 * Transcribed from prod, 2026-07-27:
 *   trinity_tasks_verifier_verdict_check / trinity_tasks_final_verdict_check
 * If these ever diverge from the module's constants, every write 23514s.
 */
const DB_VERIFIER_VERDICTS = ['approved', 'rejected', 'unclear'];
const DB_FINAL_VERDICTS = ['verified_done', 'disputed_done', 'rejected', 'unverified', 'spot_audited'];

describe('verdict vocabulary matches the prod CHECK constraints', () => {
  test('module constants are exactly the constraint sets', () => {
    expect([...VERIFIER_VERDICTS].sort()).toEqual([...DB_VERIFIER_VERDICTS].sort());
    expect([...FINAL_VERDICTS].sort()).toEqual([...DB_FINAL_VERDICTS].sort());
  });

  test('every verdict this module can emit is DB-legal', () => {
    const cases: Array<{ expected_output: string; result: string }> = [
      { expected_output: '{"contains_all":["ok"]}', result: 'ok' },
      { expected_output: '{"contains_all":["ok"]}', result: 'nope' },
      { expected_output: '{"min_length":1}', result: 'x' },
      { expected_output: '{"nope":1}', result: 'x' },
      { expected_output: '{not json', result: 'x' },
      { expected_output: '{"matches":"^[0-9a-f]{40}$"}', result: 'abc123' },
    ];
    for (const c of cases) {
      const r = verifyTaskDeterministically(c);
      expect(r).not.toBeNull();
      expect(DB_VERIFIER_VERDICTS).toContain(r!.verifier_verdict);
      expect(DB_FINAL_VERDICTS).toContain(r!.final_verdict);
    }
  });
});

describe('no contract → no verdict', () => {
  test.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
    ['prose', 'A short markdown report describing what you found.'],
    // Only a `{`-prefixed value is read as an attempted contract; a JSON array
    // is not one, and is left alone rather than reported as malformed.
    ['json array', '[1,2]'],
  ])('%s expected_output returns null', (_label, expected_output) => {
    expect(
      verifyTaskDeterministically({ expected_output: expected_output as any, result: 'anything at all' })
    ).toBeNull();
  });

  test('prose is not an error — only a malformed OBJECT is', () => {
    expect(parseContract('please return a table')).toBeNull();
    expect(parseContract('{"contains_all":')).toEqual({ invalid: expect.stringContaining('not valid JSON') });
  });
});

describe('a contract that cannot confirm is never read as confirming', () => {
  test('only negative assertions → unclear/unverified even when they all pass', () => {
    const r = verifyTaskDeterministically({
      expected_output: '{"min_length":3,"contains_none":["error"]}',
      result: 'fine and long enough',
    })!;
    expect(r.verified_output.checks.every((c) => c.ok)).toBe(true);
    expect(r.verified_output.substantive_checks).toBe(0);
    expect(r.verifier_verdict).toBe('unclear');
    expect(r.final_verdict).toBe('unverified');
    expect(r.verified_output.reason).toBe('no_substantive_assertion');
  });

  test('one substantive assertion is enough to confirm', () => {
    const r = verifyTaskDeterministically({
      expected_output: '{"contains_all":["deployed_commit"],"min_length":3}',
      result: 'deployed_commit is present',
    })!;
    expect(r.verified_output.substantive_checks).toBe(1);
    expect(r.verifier_verdict).toBe('approved');
    expect(r.final_verdict).toBe('verified_done');
  });
});

describe('the checks can actually fail', () => {
  test('matches: a real 40-hex sha passes, the fabricated placeholder does not', () => {
    const contract = '{"matches":"\\"deployed_commit\\":\\"[0-9a-f]{40}\\""}';
    const real = verifyTaskDeterministically({
      expected_output: contract,
      result: '{"deployed_commit":"a1b6e7fc0000000000000000000000000000dead"}',
    })!;
    expect(real.verifier_verdict).toBe('approved');

    // The exact body six agents emitted on six different nights (Beat 30 audit).
    const fabricated = verifyTaskDeterministically({
      expected_output: contract,
      result: '{"deployed_commit":"abc123"}',
    })!;
    expect(fabricated.verifier_verdict).toBe('rejected');
    expect(fabricated.final_verdict).toBe('rejected');
  });

  test('contains_all reports precisely what is missing', () => {
    const r = verifyTaskDeterministically({
      expected_output: '{"contains_all":["alpha","beta","gamma"]}',
      result: 'alpha only',
    })!;
    expect(r.verifier_verdict).toBe('rejected');
    expect(r.verified_output.checks.find((c) => c.kind === 'contains_all')!.detail).toContain('beta');
    expect(r.verified_output.checks.find((c) => c.kind === 'contains_all')!.detail).toContain('gamma');
  });

  test('json_keys distinguishes "not JSON" from "JSON missing a key"', () => {
    const notJson = verifyTaskDeterministically({
      expected_output: '{"json_keys":["status"]}',
      result: 'the status is fine',
    })!;
    expect(notJson.verified_output.checks[0]!.detail).toBe('result is not valid JSON');

    const missing = verifyTaskDeterministically({
      expected_output: '{"json_keys":["status","count"]}',
      result: '{"status":"ok"}',
    })!;
    expect(missing.verified_output.checks[0]!.detail).toContain('count');

    const arr = verifyTaskDeterministically({
      expected_output: '{"json_keys":["status"]}',
      result: '["status"]',
    })!;
    expect(arr.verified_output.checks[0]!.ok).toBe(false);
  });

  test('min_length and contains_none reject', () => {
    expect(
      verifyTaskDeterministically({ expected_output: '{"contains_all":["x"],"min_length":50}', result: 'x' })!
        .verifier_verdict
    ).toBe('rejected');
    expect(
      verifyTaskDeterministically({
        expected_output: '{"contains_all":["x"],"contains_none":["FAILED"]}',
        result: 'x but also FAILED',
      })!.verifier_verdict
    ).toBe('rejected');
  });
});

describe('placeholder rejection', () => {
  test('is on by default whenever a contract exists', () => {
    const r = verifyTaskDeterministically({
      expected_output: '{"contains_all":["report"]}',
      result: 'report body: TODO: fill this in',
    })!;
    expect(r.verifier_verdict).toBe('rejected');
    expect(r.verified_output.placeholders_found).toContain('todo:');
  });

  test('can be switched off explicitly, and then it stops rejecting', () => {
    const r = verifyTaskDeterministically({
      expected_output: '{"contains_all":["report"],"no_placeholders":false}',
      result: 'report body: TODO: fill this in',
    })!;
    expect(r.verifier_verdict).toBe('approved');
    expect(r.verified_output.checks.some((c) => c.kind === 'no_placeholders')).toBe(false);
  });

  test('every declared marker is actually detected', () => {
    for (const marker of PLACEHOLDER_MARKERS) {
      const r = verifyTaskDeterministically({
        expected_output: '{"contains_all":["ok"]}',
        result: `ok ${marker.toUpperCase()} trailing`,
      })!;
      expect(r.verified_output.placeholders_found).toContain(marker);
      expect(r.verifier_verdict).toBe('rejected');
    }
  });
});

describe('malformed contracts are surfaced, not swallowed', () => {
  test.each([
    ['unknown assertion', '{"looks_good":true}'],
    ['empty object', '{}'],
    ['bad JSON', '{"contains_all":'],
    ['contains_all not an array', '{"contains_all":"alpha"}'],
    ['contains_all with an empty string', '{"contains_all":[""]}'],
    ['min_length negative', '{"min_length":-1}'],
    ['no_placeholders not a boolean', '{"no_placeholders":"yes"}'],
    ['matches not a valid regex', '{"matches":"([a-z"}'],
    ['matches too long', `{"matches":"${'a'.repeat(201)}"}`],
    ['matches with a nested quantifier', '{"matches":"(a+)+$"}'],
    ['matches with a BRACED repetition of a quantified group', '{"matches":"(a+){10}$"}'],
    ['matches with an open-ended braced repetition', '{"matches":"(a+){2,}$"}'],
    ['matches with a repeated alternation', '{"matches":"(a|aa)+$"}'],
  ])('%s → unclear/unverified with a reason', (_label, expected_output) => {
    const r = verifyTaskDeterministically({ expected_output, result: 'whatever' })!;
    expect(r.verifier_verdict).toBe('unclear');
    expect(r.final_verdict).toBe('unverified');
    expect(r.verified_output.reason).toBe('contract_invalid');
    expect(r.verification_method).toBe(`${VERIFY_METHOD}:contract_invalid`);
    expect(r.verified_output.checks[0]!.detail.length).toBeGreaterThan(0);
  });

  test('backtracking detector: flags the catastrophic shapes, allows ordinary ones', () => {
    expect(hasBacktrackingRisk('(a+)+')).toBe(true);
    expect(hasBacktrackingRisk('(x*)*')).toBe(true);
    expect(hasBacktrackingRisk('([0-9a-f]{40})+')).toBe(false);
    expect(hasBacktrackingRisk('^[0-9a-f]{40}$')).toBe(false);
    expect(hasBacktrackingRisk('(deployed_commit)')).toBe(false);
    expect(hasBacktrackingRisk('\\(a+\\)+')).toBe(false);
  });

  /**
   * Regression: the first version of this detector only looked for `*`/`+` AFTER the
   * group and only for `*`/`+` INSIDE it, so a braced repetition and a repeated
   * alternation both walked through. Both were measured catastrophic on this Node
   * build before the fix — `(a+){10}$` took 2.8 s on a 33-char subject and `(a+){2,}$`
   * took 61 s on 29 chars, growing exponentially; `(a|aa)+$` exceeded 30 s at 43 chars.
   * These are the exact shapes that would have parked the 30-second bridge poller.
   */
  test('REGRESSION: braced repetitions and repeated alternations are flagged', () => {
    expect(hasBacktrackingRisk('(a+){10}$')).toBe(true);
    expect(hasBacktrackingRisk('(a+){2,}$')).toBe(true);
    expect(hasBacktrackingRisk('(a*){5}')).toBe(true);
    expect(hasBacktrackingRisk('(a|aa)+$')).toBe(true);
    expect(hasBacktrackingRisk('(a|a)*')).toBe(true);
    expect(hasBacktrackingRisk('(x|y){3}')).toBe(true);
    expect(hasBacktrackingRisk('(a?)+')).toBe(true);
    expect(hasBacktrackingRisk('([a-z]{2,4})+')).toBe(true);
  });

  test('...without rejecting fixed-width or unrepeated groups a real contract would use', () => {
    // Fixed width per repetition: no ambiguity, cannot blow up.
    expect(hasBacktrackingRisk('(\\d{4}){2}')).toBe(false);
    // Alternation that is never repeated.
    expect(hasBacktrackingRisk('^(pass|fail)$')).toBe(false);
    // The real smoke assertion this leg exists to grade.
    expect(hasBacktrackingRisk('"deployed_commit":"[0-9a-f]{40}"')).toBe(false);
  });

  /**
   * Regression #2, found by the INDEPENDENT verifier of the beat that shipped the fix
   * above — and then re-measured here before being acted on, because a verifier's
   * example has been wrong before.
   *
   * The detector scanned the body only at depth 1 (`else if (depth !== 1) continue`),
   * so wrapping a dangerous body in one extra pair of parentheses hid it completely.
   * `((a+))+$` — a redundant double-wrap of `(a+)+` — was ACCEPTED by `parseContract`
   * and measured on this Node build at n=24 → 0.37 s, n=27 → 2.9 s, n=30 → 24.6 s:
   * clean exponential growth, far below the MAX_SUBJECT_LEN=20,000 backstop.
   *
   * Depth is not a safety property. Each shape below is the depth-wrapped form of a
   * shape already pinned above, and every one of them walked through.
   */
  test('REGRESSION: a quantifier or alternation NESTED deeper than one group is still flagged', () => {
    expect(hasBacktrackingRisk('((a+))+$')).toBe(true);      // the verifier's find
    expect(hasBacktrackingRisk('(((a+)))+$')).toBe(true);    // depth 3
    expect(hasBacktrackingRisk('((a*))*$')).toBe(true);
    expect(hasBacktrackingRisk('((a{2,}))+$')).toBe(true);   // variable brace, depth 2
    expect(hasBacktrackingRisk('((a|aa))+$')).toBe(true);    // alternation, depth 2
    expect(hasBacktrackingRisk('(?:a(b+)c)+')).toBe(true);   // inside a non-capturing wrap
  });

  /**
   * The depth fix had to not be a blanket "count every `?`", because the `?` that
   * OPENS `(?:` … `(?<name>` is not a quantifier. Stepping over group prefixes also
   * closes a pre-existing FALSE POSITIVE: `(?:abc)+` is fixed-width and entirely
   * safe, and the detector used to reject it.
   */
  test('group prefixes are not mistaken for quantifiers (and the old false positive is gone)', () => {
    expect(hasBacktrackingRisk('(?:abc)+')).toBe(false);
    expect(hasBacktrackingRisk('(?:pass)*')).toBe(false);
    expect(hasBacktrackingRisk('(?<sha>[0-9a-f]{40})')).toBe(false);
    expect(hasBacktrackingRisk('((a){2})+')).toBe(false); // fixed sub-group, fixed brace
    // A prefix on a NESTED group must be stepped over too. These were added because a
    // mutation that removed the nested-prefix step killed no test — the suite had a gap
    // at exactly the depth the fix was about.
    expect(hasBacktrackingRisk('(a(?:bc)d)+')).toBe(false);   // fixed width throughout
    expect(hasBacktrackingRisk('(a(?<n>b)c)+')).toBe(false);  // nested named group
    expect(hasBacktrackingRisk('(x(?:ab)*y)+')).toBe(true);   // ...but a real `*` still counts
    // An unrecognised `(?…` is deliberately NOT stepped over — its `?` keeps counting,
    // so the detector stays fail-closed on syntax it does not model.
    expect(hasBacktrackingRisk('(?#weird)+')).toBe(true);
  });

  test('the depth-2 bypass is refused end-to-end by parseContract, not just by the guard', () => {
    // The guard is internal; this is the surface an operator's contract actually hits.
    const r = parseContract('{"matches":"((a+))+$"}');
    expect(r).not.toBeNull();
    expect('invalid' in r!).toBe(true);
    expect((r as { invalid: string }).invalid).toMatch(/backtracking/);
  });

  test('a flagged pattern is rejected fast — the detector itself never runs the regex', () => {
    const t0 = Date.now();
    const r = verifyTaskDeterministically({
      expected_output: '{"matches":"(a|aa)+$"}',
      result: 'a'.repeat(2_000) + 'b',
    })!;
    expect(r.verified_output.reason).toBe('contract_invalid');
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe('mode lever fails safe', () => {
  const original = process.env.TASK_VERIFY_LEG_MODE;
  afterAll(() => {
    if (original === undefined) delete process.env.TASK_VERIFY_LEG_MODE;
    else process.env.TASK_VERIFY_LEG_MODE = original;
  });

  test.each([
    ['shadow', 'shadow'],
    ['SHADOW', 'shadow'],
    [' enforce ', 'enforce'],
    ['ENFORCE', 'enforce'],
    ['off', 'off'],
    ['enfroce', 'off'],
    ['on', 'off'],
    ['true', 'off'],
    ['1', 'off'],
    ['', 'off'],
  ])('%s → %s', (raw, expected) => {
    expect(resolveVerifyLegMode(raw)).toBe(expected);
  });

  test('unset → off', () => {
    delete process.env.TASK_VERIFY_LEG_MODE;
    expect(resolveVerifyLegMode()).toBe('off');
  });
});

describe('the module never claims peer verification', () => {
  test('verification_method is always the deterministic stamp', () => {
    const approved = verifyTaskDeterministically({
      expected_output: '{"contains_all":["ok"]}',
      result: 'ok',
    })!;
    expect(approved.verification_method).toBe(VERIFY_METHOD);
    expect(approved.verification_method).toContain('deterministic');
    // Nothing in the result shape can be mistaken for an independent agent id.
    expect(JSON.stringify(approved)).not.toContain('verifier_agent_id');
    expect(JSON.stringify(approved)).not.toContain('repid_verified');
  });
});
