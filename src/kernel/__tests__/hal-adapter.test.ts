/**
 * The PURE HAL→kernel adapter (`halEvidenceFromFactCheck`), mapped exhaustively and fail-closed.
 *
 * This is the half of GAP 1 that runs with no gate, no ledger and no env: given a `FactCheckResult`,
 * it must produce exactly the right `HalEvidence`. The one way to get this wrong that every existing
 * suite would miss is to let a `flagged`, an `abstain`, a thin `clean`, or an unreadable shape turn
 * into a PASS — a silent FAIL OPEN. So the fail-closed cases are asserted directly here, and a
 * deliberately-broken mapper is shown to disagree (non-vacuity: the assertions can tell PASS from
 * not-PASS, and the real adapter is on the safe side of that line).
 */
import { MIN_DISJOINT_FAMILIES, halEvidenceFromFactCheck, type HalAdapterTrace } from '../hal-adapter';
import type { FactCheckResult, ProviderVerdict } from '../../hal/fact-check';
import type { HalEvidence } from '../types';

/** A minimally-complete FactCheckResult; override any field a case cares about. */
function fcr(over: Partial<FactCheckResult> = {}): FactCheckResult {
  return {
    hal_score: 0.1,
    decision: 'clean',
    verdicts: [],
    providers_used: 3,
    families_used: 3,
    families: ['groq', 'gemini', 'deepseek'],
    agreement: 1,
    degraded: false,
    latency_ms: 10,
    ...over,
  };
}

const V = (provider: string, verdict: ProviderVerdict['verdict'], over: Partial<ProviderVerdict> = {}): ProviderVerdict => ({
  provider,
  verdict,
  confidence: 90,
  latency_ms: 5,
  ...over,
});

describe('halEvidenceFromFactCheck — the mapping, fail-closed', () => {
  it('vetoed → VETO', () => {
    expect(halEvidenceFromFactCheck(fcr({ decision: 'vetoed' })).verdict).toBe('VETO');
  });

  it('flagged + quorum → FLAG (flagged content is NOT cleared)', () => {
    expect(halEvidenceFromFactCheck(fcr({ decision: 'flagged', families_used: 5 })).verdict).toBe('FLAG');
  });

  it('flagged but DEGRADED → ABSTAIN (a total-outage neutral flag is "could not check", not a flag)', () => {
    expect(halEvidenceFromFactCheck(fcr({ decision: 'flagged', families_used: 0, providers_used: 0, degraded: true })).verdict).toBe('ABSTAIN');
  });

  it('flagged with only ONE family → ABSTAIN (a lone held verdict is not a real flag)', () => {
    expect(halEvidenceFromFactCheck(fcr({ decision: 'flagged', families_used: 1, families: ['groq'], providers_used: 1, degraded: true })).verdict).toBe('ABSTAIN');
  });

  it('abstain → ABSTAIN', () => {
    expect(halEvidenceFromFactCheck(fcr({ decision: 'abstain' })).verdict).toBe('ABSTAIN');
  });

  it('clean WITH a disjoint-family quorum (>= 2 families, not degraded) → PASS', () => {
    expect(halEvidenceFromFactCheck(fcr({ decision: 'clean', families_used: 2, degraded: false })).verdict).toBe('PASS');
  });

  it('clean with only ONE family → ABSTAIN (a single family can neither veto nor clear)', () => {
    const ev = halEvidenceFromFactCheck(fcr({ decision: 'clean', families_used: 1, families: ['groq'], providers_used: 1 }));
    expect(ev.verdict).toBe('ABSTAIN');
  });

  it('clean but DEGRADED → ABSTAIN', () => {
    expect(halEvidenceFromFactCheck(fcr({ decision: 'clean', families_used: 2, degraded: true })).verdict).toBe('ABSTAIN');
  });

  it('the local_slm fallback shape (clean, providers_used:1, degraded:true, no families_used) → ABSTAIN', () => {
    // A single heuristic is not a cross-LLM quorum. This exact shape is what fact-check.ts returns
    // when HAL_LOCAL_FALLBACK_ENABLED and 0 providers responded — it must never read as PASS.
    const local = { hal_score: 0.2, decision: 'clean', verdicts: [V('local_slm', 'TRUE')], providers_used: 1, agreement: 1, degraded: true, latency_ms: 1, fallback_used: 'local_slm' } as unknown;
    expect(halEvidenceFromFactCheck(local).verdict).toBe('ABSTAIN');
  });

  it('falls back to the `families` array length when `families_used` is absent', () => {
    expect(halEvidenceFromFactCheck(fcr({ decision: 'clean', families_used: undefined, families: ['a', 'b'] })).verdict).toBe('PASS');
    expect(halEvidenceFromFactCheck(fcr({ decision: 'clean', families_used: undefined, families: ['a'] })).verdict).toBe('ABSTAIN');
  });

  it('the quorum floor is 2 — one below is blocked, exactly-2 passes', () => {
    expect(MIN_DISJOINT_FAMILIES).toBe(2);
    expect(halEvidenceFromFactCheck(fcr({ decision: 'clean', families_used: MIN_DISJOINT_FAMILIES - 1, families: ['a'] })).verdict).toBe('ABSTAIN');
    expect(halEvidenceFromFactCheck(fcr({ decision: 'clean', families_used: MIN_DISJOINT_FAMILIES })).verdict).toBe('PASS');
  });
});

describe('halEvidenceFromFactCheck — unreadable shapes are NOT_CHECKED, never a pass (never throws)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'clean'],
    ['a number', 1],
    ['an empty object', {}],
    ['an unknown decision', { decision: 'approved', families_used: 9 }],
    ['decision missing but quorum present', { families_used: 9, providers_used: 9, degraded: false }],
  ])('%s → ABSTAIN', (_label, input) => {
    let ev: HalEvidence | undefined;
    expect(() => { ev = halEvidenceFromFactCheck(input); }).not.toThrow();
    expect(ev!.verdict).toBe('ABSTAIN');
  });
});

describe('halEvidenceFromFactCheck — a PASS can never restore a band on its own', () => {
  it('settled_by is null, grounded and same_domain are false, on EVERY mapped verdict', () => {
    for (const decision of ['vetoed', 'flagged', 'clean', 'abstain'] as const) {
      const ev = halEvidenceFromFactCheck(fcr({ decision, families_used: 3 }));
      expect(ev.settled_by).toBeNull();
      expect(ev.grounded).toBe(false);
      expect(ev.same_domain).toBe(false);
    }
  });
});

describe('halEvidenceFromFactCheck — votes are the counted providers, honestly', () => {
  it('TRUE→PASS, FALSE→FAIL, UNCERTAIN→ABSTAIN; ERROR and late are excluded', () => {
    const r = fcr({
      decision: 'flagged',
      verdicts: [
        V('groq', 'TRUE'),
        V('gemini', 'FALSE'),
        V('deepseek', 'UNCERTAIN'),
        V('fireworks', 'ERROR', { error: 'HTTP 402' }),
        V('mistral', 'TRUE', { counted: false, late: true }),
      ],
    });
    const votes = halEvidenceFromFactCheck(r).votes;
    expect(votes).toEqual([
      { family: 'groq', verdict: 'PASS' },
      { family: 'gemini', verdict: 'FAIL' },
      { family: 'deepseek', verdict: 'ABSTAIN' },
    ]);
  });

  it('votes is always an array (the gate requires it), even on an unreadable input', () => {
    expect(Array.isArray(halEvidenceFromFactCheck(null).votes)).toBe(true);
  });
});

describe('the trace reports what the adapter looked at', () => {
  it('records the decision, family count, degraded flag and whether the quorum sufficed', () => {
    let t: HalAdapterTrace | undefined;
    halEvidenceFromFactCheck(fcr({ decision: 'clean', families_used: 2, providers_used: 2, degraded: false }), (x) => { t = x; });
    expect(t).toEqual({ decision: 'clean', families_used: 2, providers_used: 2, degraded: false, quorum_sufficient: true });
  });
});

// ── NON-VACUITY: these assertions can tell PASS from not-PASS, and the real adapter is safe ───────
//
// The failure this whole seam exists to prevent is a wrong adapter that FAILS OPEN. Here, at the
// pure level, we show the discriminating cases where a plausible-but-wrong mapper would emit PASS
// and the REAL adapter does not. (The end-to-end proof — that such a PASS would make the kernel
// ALLOW a post — is in kernel-hal-integration.test.ts.)
describe('(non-vacuity) a wrong mapper would PASS exactly where the real one blocks', () => {
  /** The classic bugs: treat `flagged` as a pass, and clear a thin/degraded `clean`. */
  const wrongMapper = (r: FactCheckResult): HalEvidence['verdict'] =>
    r.decision === 'vetoed' ? 'VETO' : r.decision === 'abstain' ? 'ABSTAIN' : 'PASS';

  const failOpenCases: Array<[string, FactCheckResult]> = [
    ['flagged (quorum) — wrong mapper clears it', fcr({ decision: 'flagged', families_used: 5 })],
    ['a degraded/outage flagged', fcr({ decision: 'flagged', families_used: 0, providers_used: 0, degraded: true })],
    ['a lone-family clean', fcr({ decision: 'clean', families_used: 1, families: ['groq'], providers_used: 1 })],
    ['a degraded clean', fcr({ decision: 'clean', families_used: 2, degraded: true })],
  ];

  it.each(failOpenCases)('%s: wrong mapper → PASS (the bug), real adapter → not PASS (fail closed)', (_label, r) => {
    expect(wrongMapper(r)).toBe('PASS'); // proves the test can observe a fail-open
    expect(halEvidenceFromFactCheck(r).verdict).not.toBe('PASS'); // the real adapter refuses it
  });

  it('and on a real quorum the two AGREE on PASS, so the test is not just "never PASS"', () => {
    const good = fcr({ decision: 'clean', families_used: 3 });
    expect(wrongMapper(good)).toBe('PASS');
    expect(halEvidenceFromFactCheck(good).verdict).toBe('PASS');
  });
});
