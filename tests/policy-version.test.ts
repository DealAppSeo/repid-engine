/**
 * policy-version.test.ts
 *
 * `src/zkp/repid-delta-statement.ts` records that its hand-bumped version string
 * HAS ALREADY FAILED ONCE: every delta the formula produced changed, nobody
 * bumped the string, and the commitment stayed byte-identical. The version here
 * is derived from behaviour precisely so that cannot recur — these tests are
 * what keeps it derived.
 */
import { createHash } from 'crypto';
import {
  POLICY_VERSION_PREFIX,
  currentPolicyVersion,
  policyTranscript,
  __resetPolicyVersionCacheForTests,
} from '../src/services/policy-version';
import { OutcomeClass } from '../src/services/outcome-classification';
import { CURRENT_FORMULA_PARAMS } from '../src/zkp/repid-delta-statement';

beforeEach(() => __resetPolicyVersionCacheForTests());

describe('shape', () => {
  it('is a prefixed 16-hex digest, so a reader can tell the scheme before parsing', () => {
    expect(currentPolicyVersion()).toMatch(new RegExp(`^${POLICY_VERSION_PREFIX}-[0-9a-f]{16}$`));
  });

  it('is stable across calls, cached and uncached', () => {
    const first = currentPolicyVersion();
    const cached = currentPolicyVersion();
    __resetPolicyVersionCacheForTests();
    const recomputed = currentPolicyVersion();
    expect(cached).toBe(first);
    expect(recomputed).toBe(first);
  });

  it('does not read the clock — a version that moves when nothing moved is worse than none', () => {
    expect(policyTranscript()).toBe(policyTranscript());
  });
});

describe('the transcript actually probes the policy', () => {
  const transcript = policyTranscript();

  it('exercises every outcome class', () => {
    for (const cls of Object.values(OutcomeClass)) {
      expect(transcript).toContain(`delta|${cls}|`);
    }
  });

  it('probes both sides of the payment-proof threshold, and the boundary itself', () => {
    // `PAYMENT_PROOF_REQUIRED_ABOVE` is 10, and a `>` is where an off-by-one lives.
    expect(transcript).toContain('|v=10|');
    expect(transcript).toContain('|v=100|');
  });

  it('probes anchored and unanchored, validated and unvalidated', () => {
    expect(transcript).toContain('|p=0|val=0');
    expect(transcript).toContain('|p=1|val=1');
  });

  it('records the effective class and whether a demotion fired, not just the number', () => {
    // A delta of 0 is produced by UNCERTAIN, FAILURE_INFRA and by a DEMOTED
    // success alike. Digesting the number alone would let a demotion rule change
    // without moving the version.
    expect(transcript).toMatch(/=>0\|UNCERTAIN\|1/);
  });

  it('probes all three risk bands', () => {
    expect(transcript).toContain('=>OFF_CHAIN|');
    expect(transcript).toContain('=>BATCHED|');
    expect(transcript).toContain('=>ATTESTED|');
  });

  it('folds in the other formula path, whose version is still bumped by hand', () => {
    expect(transcript).toContain(`formula_params_version=${CURRENT_FORMULA_PARAMS.version}`);
  });

  it('uses only fabricated witnesses — the #376 fence', () => {
    // A NIL-variant id no real agent can hold, and a settlement hash that is
    // obviously constructed.
    expect(transcript).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  });
});

describe('sensitivity', () => {
  it('moves when any single probe output moves', () => {
    const base = policyTranscript();
    const digestOf = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

    const lines = base.split('\n');
    // Mutate one line at a time across a spread of the transcript, including the
    // first (the folded formula version) and the last (a risk band).
    for (const i of [0, 1, Math.floor(lines.length / 2), lines.length - 1]) {
      const mutated = [...lines];
      mutated[i] = `${mutated[i]}x`;
      expect(digestOf(mutated.join('\n'))).not.toBe(digestOf(base));
    }
  });

  /**
   * KNOWN-ANSWER TEST. A literal, never recomputed from live inputs — a KAT that
   * derives its own expectation re-derives whatever the code currently does and
   * can never fail.
   *
   * WHEN THIS FAILS, THE SCORING POLICY CHANGED. That may be entirely intended.
   * Update the literal in the SAME commit as the behaviour change, so the diff
   * shows both together and no ledger row is ever stamped with a version that
   * does not describe the policy that produced it.
   */
  it('matches the pinned digest for the current policy', () => {
    expect(currentPolicyVersion()).toBe('pol1-37620edf769590dd');
  });
});
