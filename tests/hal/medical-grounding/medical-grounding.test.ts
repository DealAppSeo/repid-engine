/**
 * medical-grounding.test.ts — the proof-carrying abstain mechanism, asserted on real-sourced
 * medical-guidance-change fixtures (historical/bibliographic; NOT medical advice — see cases.ts).
 *
 * Per case: commit the guidance → the proof-carrying agent grounds an answer citing it (grounded
 * BEFORE the update) → the record is updated (superseded cases revoked, controls left intact) → ask
 * again. Superseded cases MUST make the agent abstain; controls MUST NOT. The naive baseline, which
 * re-asserts its stored answer, hallucinates exactly on the superseded cases. Real Poseidon2, no network.
 */
import {
  MEDICAL_GROUNDING_CASES,
  SUPERSEDED_CASES,
  CONTROL_CASES,
} from './cases';
import { runCase, evaluate } from '../../../scripts/hal/medical-grounding-eval';

describe('HAL medical-flavored grounding / abstention — the mechanism holds per case', () => {
  it('has a well-formed, sourced fixture set (8–15 cases, every case cites a real URL)', () => {
    expect(MEDICAL_GROUNDING_CASES.length).toBeGreaterThanOrEqual(8);
    expect(MEDICAL_GROUNDING_CASES.length).toBeLessThanOrEqual(15);
    expect(SUPERSEDED_CASES.length).toBeGreaterThan(0);
    expect(CONTROL_CASES.length).toBeGreaterThan(0);
    for (const c of MEDICAL_GROUNDING_CASES) {
      expect(c.sourceUrls.length).toBeGreaterThan(0);
      for (const u of c.sourceUrls) expect(u).toMatch(/^https:\/\//);
      // Controls are still-valid — they must not carry a supersession record.
      if (!c.shouldAbstainAfterUpdate) expect(c.supersededOn).toBeNull();
      else expect(c.supersededOn).not.toBeNull();
    }
  });

  describe.each(MEDICAL_GROUNDING_CASES.map((c) => [c.id, c] as const))('case: %s', (_id, c) => {
    const o = runCase(c);

    it('the proof-carrying answer is grounded BEFORE the record is updated', () => {
      expect(o.groundedBeforeUpdate).toBe(true);
    });

    if (c.shouldAbstainAfterUpdate) {
      it('ABSTAINS after the guidance is superseded/revoked', () => {
        expect(o.pcAbstainedAfterUpdate).toBe(true);
        expect(o.pcAbstainReason).toMatch(/abstain/);
        expect(o.halWouldAbstain).toBe(true);
      });
      it('the naive baseline re-asserts a now-ungrounded answer (hallucination)', () => {
        expect(o.naiveAnswerGroundedAfterUpdate).toBe(false);
        expect(o.naiveHallucinated).toBe(true);
      });
    } else {
      it('does NOT abstain — the guidance is still current (false-abstention guard)', () => {
        expect(o.pcAbstainedAfterUpdate).toBe(false);
        expect(o.naiveAnswerGroundedAfterUpdate).toBe(true);
        expect(o.naiveHallucinated).toBe(false);
      });
    }
  });

  it('aggregate: perfect separation on this fixture set (F1=1, zero false-abstention, naive hallucinates on every superseded case)', () => {
    const m = evaluate(MEDICAL_GROUNDING_CASES.map(runCase));
    expect(m.allGroundedBeforeUpdate).toBe(true);
    expect(m.f1).toBe(1);
    expect(m.falseAbstentionRateOnControls).toBe(0);
    expect(m.naiveHallucinationRateOnPositives).toBe(1);
    expect(m.fp).toBe(0);
    expect(m.fn).toBe(0);
  });
});
