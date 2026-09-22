/**
 * The typed verdict shadow's load-bearing properties.
 *
 * Three of these tests exist because the OPPOSITE behaviour is the plausible one —
 * the version a reasonable author would write and a reviewer would wave through:
 *
 *   * an unclassified task treated as a chore ("nothing declared, nothing owed"),
 *   * `signatures: []` counted as a signature (it is the column DEFAULT),
 *   * a newly added class judged as the nearest neighbour instead of unhandled.
 *
 * Each of those collapses NOT CHECKED into PASSED in the safe-looking direction,
 * which is the defect this whole layer exists to measure. So they are asserted
 * rather than described.
 */

/**
 * The db is mocked to record calls AND to fail on insert, deliberately.
 *
 * Failing is the honest simulation of the state this ships in: the migration is
 * UNAPPLIED, so if the flag were switched on today every insert would error with
 * `relation "typed_verdict_shadow" does not exist`. The test below asserts that
 * this surfaces as `recorded: false` and not as a thrown error or a silent true.
 */
const fromCalls: string[] = [];
let insertShouldFail = true;
jest.mock('../src/db', () => ({
  db: {
    from(table: string) {
      fromCalls.push(table);
      return {
        insert: async () =>
          insertShouldFail
            ? { error: { message: 'relation "typed_verdict_shadow" does not exist' } }
            : { error: null },
      };
    },
  },
}));

import {
  evaluateTypedRule,
  observeTypedVerdict,
  typedVerdictShadowEnabled,
  isArtifactClass,
  ARTIFACT_CLASSES,
  RULE_VERSION,
  type TaskEvidence,
} from '../src/services/typed-verdict-shadow';

const NO_EVIDENCE: TaskEvidence = {};
const evaluate = (artifactClass: unknown, evidence: TaskEvidence = NO_EVIDENCE, status = 'done') =>
  evaluateTypedRule({
    taskId: 1,
    status,
    artifactClass: artifactClass as string | null,
    evidence,
    now: new Date('2026-09-22T00:00:00.000Z'),
  });

describe('evaluateTypedRule — an unclassified task can never be accepted', () => {
  it.each([null, undefined])('artifact_class %p yields not_checked, not accept', (cls) => {
    const o = evaluate(cls);
    expect(o.verdict).toBe('not_checked');
    expect(o.reason).toBe('unclassified');
    expect(o.artifactClass).toBeNull();
  });

  it('NULL is not quietly read as chore, even with no evidence at all', () => {
    // A chore and an unanswered question produce the same evidence (none). The
    // only thing that tells them apart is the declaration, so the verdicts must
    // differ even though the inputs otherwise match.
    expect(evaluate(null).verdict).toBe('not_checked');
    expect(evaluate('chore').verdict).toBe('accept');
  });

  it('no input combination reaches accept without a declared class', () => {
    const everything: TaskEvidence = {
      artifactUrl: 'https://example.invalid/a',
      externalArtifactUrl: 'https://example.invalid/b',
      verifiedOutput: { ok: true },
      verificationProof: 'proof',
      signatures: [{ sig: 'x' }],
      verifierAgentId: '00000000-0000-0000-0000-000000000001',
    };
    for (const status of ['done', 'completed', 'verified']) {
      expect(evaluate(null, everything, status).verdict).toBe('not_checked');
    }
  });
});

describe('evaluateTypedRule — the three classes', () => {
  it('chore accepts with no evidence', () => {
    const o = evaluate('chore');
    expect(o.verdict).toBe('accept');
    expect(o.reason).toBe('chore_no_evidence_expected');
  });

  it.each([
    ['artifactUrl', { artifactUrl: 'https://example.invalid/pr/1' }],
    ['externalArtifactUrl', { externalArtifactUrl: 'https://example.invalid/gist' }],
    ['verifiedOutput', { verifiedOutput: { rows: 3 } }],
  ])('checkable accepts on %s', (_name, evidence) => {
    expect(evaluate('checkable', evidence as TaskEvidence).verdict).toBe('accept');
  });

  it('checkable ESCALATES when done with nothing to look at', () => {
    const o = evaluate('checkable');
    expect(o.verdict).toBe('escalate');
    expect(o.reason).toBe('checkable_no_artifact');
  });

  it('checkable is not rescued by attestation evidence — the classes want different things', () => {
    const o = evaluate('checkable', { verificationProof: 'sig', verifierAgentId: 'a' });
    expect(o.verdict).toBe('escalate');
  });

  it.each([
    ['verificationProof', { verificationProof: '0xproof' }],
    ['signatures', { signatures: [{ signer: 'trinity-mel' }] }],
    ['verifierAgentId', { verifierAgentId: '00000000-0000-0000-0000-000000000001' }],
  ])('attestation accepts on %s', (_name, evidence) => {
    expect(evaluate('attestation', evidence as TaskEvidence).verdict).toBe('accept');
  });

  it('attestation ESCALATES when unsigned', () => {
    const o = evaluate('attestation');
    expect(o.verdict).toBe('escalate');
    expect(o.reason).toBe('attestation_unsigned');
  });

  it('attestation is not rescued by an artifact URL', () => {
    expect(evaluate('attestation', { artifactUrl: 'https://example.invalid/x' }).verdict).toBe('escalate');
  });
});

describe('evaluateTypedRule — the column default is absence, not evidence', () => {
  // `trinity_tasks.signatures` DEFAULT is '[]'::jsonb and `dependencies` DEFAULT is
  // '{}'. A presence check written as `!= null` would read every single done task
  // in production as signed. That is the bug this test is for.
  it.each([[[]], ['[]'], [{}], ['{}'], [null], [undefined], ['']])(
    'signatures %p is NOT a signature',
    (sigs) => {
      expect(evaluate('attestation', { signatures: sigs }).verdict).toBe('escalate');
    },
  );

  it('a non-empty signatures array IS a signature', () => {
    expect(evaluate('attestation', { signatures: [{ signer: 'x' }] }).verdict).toBe('accept');
  });

  it.each([['   '], [''], [null], [undefined]])('artifact_url %p is NOT an artifact', (url) => {
    expect(evaluate('checkable', { artifactUrl: url }).verdict).toBe('escalate');
  });
});

/**
 * TWO GUARDS, AND ONLY ONE OF THEM IS REACHABLE FROM A TEST INPUT.
 *
 *   * A value OUTSIDE the vocabulary ('ceremony' today) is caught by the early
 *     `!isArtifactClass` guard. That is what the first two tests exercise.
 *   * A value INSIDE the vocabulary with no rule branch is caught by the final
 *     branch. No test input can reach it — by construction, every member of
 *     ARTIFACT_CLASSES has a branch — so it is proven the only way it can be: the
 *     third test asserts the invariant, and adding a fourth class to
 *     ARTIFACT_CLASSES without a branch makes it fail. [VERIFIED by mutation
 *     2026-09-22: adding 'ceremony' to the constant fails 2 tests here.]
 *
 * Saying which test proves which guard matters, because a reader who assumes the
 * 'ceremony' cases cover the fallthrough would conclude the final branch is tested
 * when nothing reaches it.
 */
describe('evaluateTypedRule — a class with no rule branch is judged as nothing', () => {
  it('a value outside the vocabulary is not_checked, never folded into chore', () => {
    const o = evaluate('ceremony');
    expect(o.verdict).toBe('not_checked');
    expect(o.reason).toBe('unknown_class');
  });

  it('a value outside the vocabulary is NOT judged as an attestation', () => {
    // The failure this catches: while the attestation test was the final `return`,
    // a value that got past the early guard fell into it and was judged as an
    // unsigned assertion — an escalate that looks completely deliberate in the log.
    expect(isArtifactClass('ceremony')).toBe(false);
    const o = evaluate('ceremony', { verificationProof: '0xproof' });
    expect(o.verdict).not.toBe('accept');
    expect(o.reason).not.toBe('attestation_signed');
    expect(o.reason).toBe('unknown_class');
  });

  it('every class in ARTIFACT_CLASSES has a branch that is not the unhandled one', () => {
    // If this fails, someone added a value to the vocabulary and not to the rule.
    // This is the ONLY test that covers the final branch, and it covers it as an
    // invariant rather than by reaching it.
    for (const cls of ARTIFACT_CLASSES) {
      expect(evaluate(cls).reason).not.toBe('unknown_class');
    }
    expect(ARTIFACT_CLASSES).toHaveLength(3);
  });
});

describe('evaluateTypedRule — evidence is only owed by a task claiming success', () => {
  it.each(['pending', 'failed', 'cancelled', 'archived', 'shadow_reject', 'in_progress', null])(
    'status %p is not_terminal, not an escalate',
    (status) => {
      const o = evaluate('checkable', NO_EVIDENCE, status as string);
      expect(o.verdict).toBe('not_checked');
      expect(o.reason).toBe('not_terminal');
    },
  );

  it.each(['done', 'completed', 'verified'])('status %s IS asked for evidence', (status) => {
    expect(evaluate('checkable', NO_EVIDENCE, status).verdict).toBe('escalate');
  });
});

describe('observeTypedVerdict — inert while the flag is off', () => {
  const saved = process.env['TYPED_VERDICT_SHADOW_ENABLED'];
  beforeEach(() => {
    fromCalls.length = 0;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['TYPED_VERDICT_SHADOW_ENABLED'];
    else process.env['TYPED_VERDICT_SHADOW_ENABLED'] = saved;
  });

  it('is off by default', () => {
    delete process.env['TYPED_VERDICT_SHADOW_ENABLED'];
    expect(typedVerdictShadowEnabled()).toBe(false);
  });

  it('touches the database ZERO times while off', async () => {
    delete process.env['TYPED_VERDICT_SHADOW_ENABLED'];
    const o = await observeTypedVerdict({ taskId: 7, status: 'done', artifactClass: 'checkable', evidence: {} });
    expect(o.verdict).toBe('disabled');
    expect(o.reason).toBe('flag_off');
    expect(o.recorded).toBe(false);
    expect(fromCalls).toEqual([]);
  });

  it.each(['TRUE', 'True', 'true'])('%s turns it on; anything else does not', async (val) => {
    process.env['TYPED_VERDICT_SHADOW_ENABLED'] = val;
    expect(typedVerdictShadowEnabled()).toBe(true);
    process.env['TYPED_VERDICT_SHADOW_ENABLED'] = '1';
    expect(typedVerdictShadowEnabled()).toBe(false);
  });
});

describe('observeTypedVerdict — a lost write is reported, not swallowed', () => {
  const saved = process.env['TYPED_VERDICT_SHADOW_ENABLED'];
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    process.env['TYPED_VERDICT_SHADOW_ENABLED'] = 'true';
    fromCalls.length = 0;
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
    insertShouldFail = true;
    if (saved === undefined) delete process.env['TYPED_VERDICT_SHADOW_ENABLED'];
    else process.env['TYPED_VERDICT_SHADOW_ENABLED'] = saved;
  });

  it('does not throw when the table is absent, and says recorded:false', async () => {
    insertShouldFail = true;
    const o = await observeTypedVerdict({ taskId: 9, status: 'done', artifactClass: 'checkable', evidence: {} });
    expect(o.verdict).toBe('escalate');   // the rule still answered
    expect(o.recorded).toBe(false);       // and the answer was lost
    expect(errSpy).toHaveBeenCalled();
    expect(fromCalls).toEqual(['typed_verdict_shadow']);
  });

  it('reports recorded:true only when the insert actually succeeded', async () => {
    insertShouldFail = false;
    const o = await observeTypedVerdict({ taskId: 10, status: 'done', artifactClass: 'chore', evidence: {} });
    expect(o.verdict).toBe('accept');
    expect(o.recorded).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('stamps the rule version, so two rules are never averaged together', async () => {
    insertShouldFail = false;
    const o = await observeTypedVerdict({ taskId: 11, status: 'done', artifactClass: 'chore', evidence: {} });
    expect(o.ruleVersion).toBe(RULE_VERSION);
    expect(RULE_VERSION).toMatch(/\/\d+$/);
  });
});

describe('the shadow has no power, and cannot claim to', () => {
  it('the module contains no path that sets had_power true', () => {
    // The DB CHECK (had_power = false) is the real guarantee; this asserts the
    // code never even tries, so a reviewer does not have to trust the constraint
    // alone. Source-level on purpose: the property is "no such branch exists".
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'services', 'typed-verdict-shadow.ts'),
      'utf8',
    );
    const assignments = src.match(/had_power:\s*[^,\n]+/g) ?? [];
    expect(assignments).toEqual(['had_power: false']);   // exactly one, and it is the literal
  });

  it('the migration refuses to store a row claiming enforcement', () => {
    const sql = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'migrations', '2026_09_22_artifact_class_and_typed_verdict_shadow.sql'),
      'utf8',
    );
    expect(sql).toMatch(/CHECK\s*\(had_power\s*=\s*false\)/);
    // And the column it adds must carry NO default — a default is what would
    // classify 363k legacy rows as "no evidence needed" without anyone deciding to.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS artifact_class text;/);
    expect(sql).not.toMatch(/artifact_class text\s+DEFAULT/i);
  });
});
