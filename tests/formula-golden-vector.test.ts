/**
 * formula-golden-vector.test.ts — the tripwire that makes a silent formula change go RED.
 *
 * WHAT THIS IS FOR. On 2026-08-17 the clean branch's orientation was corrected (it consumed
 * hallucination RISK where it needed QUALITY). That changed EVERY delta the formula produces while
 * `formulaCommitment()` stayed byte-identical, because the commitment covers the band, the clamp and
 * a hand-maintained `version` string — and nothing bumped the string. An old proof therefore still
 * matches on commitment while failing its recompute check, so a version skew presents as a FORGED
 * DELTA. Full write-up: docs/FORMULA-VERSIONING.md.
 *
 * The defect was not "someone forgot". A hand-maintained version behind a hash no test reads is
 * wired at one end only. This file is the other end.
 *
 * READ BEFORE "FIXING" A FAILURE HERE. If the digest assertion fails, the honest question is
 * "did behaviour change?", not "what is the new digest?". Pasting the new digest over the existing
 * entry is the exact silent-drift move this file exists to block: an entry describes what a version
 * DID, and rewriting it makes every proof issued under that version unverifiable against its own
 * declared regime. The fix for a deliberate behaviour change is to BUMP
 * `CURRENT_FORMULA_PARAMS.version` and ADD an entry.
 */

import { createHash } from 'node:crypto';

import {
  BEHAVIOUR_DIGESTS,
  GOLDEN_VECTOR,
  UNRECOMPUTABLE_VERSIONS,
  behaviourDigest,
  observeGoldenVector,
} from '../src/zkp/formula-golden-vector';
import { CURRENT_FORMULA_PARAMS, formulaCommitment } from '../src/zkp/repid-delta-statement';
import { deriveHalDecision } from '../src/scoring/pipeline';

describe('formula golden vector — preconditions', () => {
  /**
   * The one env input on this path. Asserted rather than assumed: without this, a CI environment
   * that flipped the floor flag would surface as an unexplained digest mismatch, and the first
   * instinct would be to repin the digest — which would bake the flag's behaviour into a version
   * that never declared it.
   */
  it('runs with the delta floor flag at its default (the digest is pinned for that regime)', () => {
    expect(process.env.REPID_DELTA_FLOOR_RECONCILED).not.toBe('true');
  });

  it('pins only reachable clean cases — deriveHalDecision must agree with every clean row', () => {
    // The orientation defect survived its own unit tests because those tests asserted on `clean` at
    // risk 0.75, which `deriveHalDecision` never emits. A vector with an unreachable row pins
    // behaviour production cannot exhibit, which is worse than no pin at all: it reads as coverage.
    const unreachable = GOLDEN_VECTOR.filter(
      (c) =>
        c.hal_decision === 'clean' &&
        // Only in-range scores are claimed reachable; the two clamp-probe rows are deliberately
        // out of spec (-1.0, 2.0) and exist to pin the clamp, not to model a real HAL output.
        c.hal_score >= 0 &&
        c.hal_score <= 1 &&
        deriveHalDecision(c.hal_score, false) !== 'clean',
    );
    expect(unreachable).toEqual([]);
  });

  it('covers the branches whose behaviour the band commitment cannot see', () => {
    const decisions = new Set(GOLDEN_VECTOR.map((c) => c.hal_decision));
    expect(decisions).toEqual(new Set(['clean', 'flagged', 'vetoed', 'abstain']));
    // floor protection and the vesting cliff are behaviour, so they belong in the digest
    expect(GOLDEN_VECTOR.some((c) => c.current_repid < 10)).toBe(true);
    expect(GOLDEN_VECTOR.some((c) => c.vesting_cliff_active)).toBe(true);
    // both clamp ends, reached via deliberately out-of-spec scores
    expect(GOLDEN_VECTOR.some((c) => c.hal_score < 0)).toBe(true);
    expect(GOLDEN_VECTOR.some((c) => c.hal_score > 1)).toBe(true);
  });
});

describe('formula golden vector — the tripwire', () => {
  it('has a pinned digest for the CURRENT formula version', () => {
    // The half that catches "bumped the version, forgot the entry". Keying by version rather than
    // pinning one constant is what makes this case fail at all.
    const version = CURRENT_FORMULA_PARAMS.version;
    expect(Object.keys(BEHAVIOUR_DIGESTS)).toContain(version);
    expect(BEHAVIOUR_DIGESTS[version]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('observable behaviour matches the digest pinned for this version', () => {
    // The half that catches "changed behaviour, forgot to bump". This is the assertion that would
    // have gone red on 2026-08-17.
    const version = CURRENT_FORMULA_PARAMS.version;
    expect(behaviourDigest()).toBe(BEHAVIOUR_DIGESTS[version]);
  });

  it('the digest actually depends on observed deltas, not just on the inputs', () => {
    // A digest computed over inputs alone would pass every assertion above while detecting nothing.
    // Recompute the same canonical rendering with one delta perturbed and require a different hash.
    const observations = observeGoldenVector();
    const render = (deltas: readonly [number, number][]) =>
      `sha256:${createHash('sha256')
        .update(
          observations
            .map((o, i) =>
              [
                o.input.hal_score.toFixed(4),
                o.input.hal_decision,
                String(o.input.current_repid),
                o.input.agent_tier,
                o.input.vesting_cliff_active ? 'vesting' : 'vested',
                deltas[i]![0].toFixed(4),
                deltas[i]![1].toFixed(4),
              ].join('|'),
            )
            .join('\n'),
          'utf8',
        )
        .digest('hex')}`;

    const actual = observations.map((o) => [o.delta_calculated, o.delta_applied] as [number, number]);
    expect(render(actual)).toBe(behaviourDigest());

    const perturbed = actual.map(
      ([c, a], i) => (i === 0 ? [c + 0.1, a + 0.1] : [c, a]) as [number, number],
    );
    expect(render(perturbed)).not.toBe(behaviourDigest());
  });

  it('does not pin a digest for a version whose formula is no longer in the tree', () => {
    // `repid-delta-a7` is the pre-bump orientation. Its behaviour cannot be observed here, so a
    // proof declaring it is NOT_CHECKED, not FAILED (docs/FORMULA-VERSIONING.md §3). A digest
    // under that key would be a fabrication — it would necessarily hold a8's behaviour.
    for (const version of UNRECOMPUTABLE_VERSIONS) {
      expect(Object.keys(BEHAVIOUR_DIGESTS)).not.toContain(version);
    }
    expect(UNRECOMPUTABLE_VERSIONS).toContain('repid-delta-a7');
  });
});

describe('formula golden vector — the version reaches the commitment', () => {
  it('a version bump changes formulaCommitment (so the two ends are actually wired)', () => {
    // If the version did not reach the commitment, bumping it would be cosmetic and the digest
    // would be the only guard. It does reach it — this is what makes the bump meaningful on the
    // wire as well as in this file.
    // An explicit salt, not the env one: `formulaCommitment` fails closed without a salt, and this
    // assertion is about whether `version` is an input to the hash — not about deployment config.
    const salt = 'golden-vector-test-salt';
    const base = formulaCommitment(CURRENT_FORMULA_PARAMS, salt);
    const bumped = formulaCommitment(
      { ...CURRENT_FORMULA_PARAMS, version: `${CURRENT_FORMULA_PARAMS.version}-probe` },
      salt,
    );
    expect(bumped).not.toBe(base);
  });
});
