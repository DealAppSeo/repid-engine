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
  hasNestedQuantifier,
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
  ])('%s → unclear/unverified with a reason', (_label, expected_output) => {
    const r = verifyTaskDeterministically({ expected_output, result: 'whatever' })!;
    expect(r.verifier_verdict).toBe('unclear');
    expect(r.final_verdict).toBe('unverified');
    expect(r.verified_output.reason).toBe('contract_invalid');
    expect(r.verification_method).toBe(`${VERIFY_METHOD}:contract_invalid`);
    expect(r.verified_output.checks[0]!.detail.length).toBeGreaterThan(0);
  });

  test('nested-quantifier detector: flags the catastrophic shapes, allows ordinary ones', () => {
    expect(hasNestedQuantifier('(a+)+')).toBe(true);
    expect(hasNestedQuantifier('(x*)*')).toBe(true);
    expect(hasNestedQuantifier('([0-9a-f]{40})+')).toBe(false);
    expect(hasNestedQuantifier('^[0-9a-f]{40}$')).toBe(false);
    expect(hasNestedQuantifier('(deployed_commit)')).toBe(false);
    expect(hasNestedQuantifier('\\(a+\\)+')).toBe(false);
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
