import { scoreChallengeOutcome } from '../challenge-scoring';

describe('scoreChallengeOutcome', () => {
  test('WIN: base reward', () => {
    expect(scoreChallengeOutcome({
      outcome:'WIN', certaintyAtClaim:0.8, ecosystemNeedWeight:1.0
    })).toBe(25);
  });
  test('WIN: capped at 40', () => {
    expect(scoreChallengeOutcome({
      outcome:'WIN', certaintyAtClaim:0.9, ecosystemNeedWeight:2.0
    })).toBe(40);
  });
  test('LOSS: certainty-squared penalty', () => {
    // -50 × 0.81 = -40.5 → -41
    expect(scoreChallengeOutcome({
      outcome:'LOSS', certaintyAtClaim:0.9, ecosystemNeedWeight:1.0
    })).toBe(-41);
  });
  test('LOSS: low certainty = lower penalty', () => {
    // -50 × 0.25 = -12.5 → -13
    expect(scoreChallengeOutcome({
      outcome:'LOSS', certaintyAtClaim:0.5, ecosystemNeedWeight:1.0
    })).toBe(-13);
  });
  test('EPISTEMIC_VIOLATION: 1.5x multiplier', () => {
    // -50 × 1.5 × 0.9025 = -67.69 → -68
    expect(scoreChallengeOutcome({
      outcome:'EPISTEMIC_VIOLATION', certaintyAtClaim:0.95, ecosystemNeedWeight:1.0
    })).toBe(-68);
  });
  test('CONSTITUTIONAL_VIOLATION: same penalty as epistemic violation', () => {
    const ev = scoreChallengeOutcome({
      outcome:'EPISTEMIC_VIOLATION', certaintyAtClaim:0.9, ecosystemNeedWeight:1.0
    });
    const cv = scoreChallengeOutcome({
      outcome:'CONSTITUTIONAL_VIOLATION', certaintyAtClaim:0.9, ecosystemNeedWeight:1.0
    });
    expect(cv).toBe(ev);
  });
  test('DRAW + peacemaker = +15', () => {
    expect(scoreChallengeOutcome({
      outcome:'DRAW', certaintyAtClaim:0.5, ecosystemNeedWeight:1.0, isPeacemaker:true
    })).toBe(15);
  });
  test('LOSS + selfMonitoring reduces penalty', () => {
    // -50 × 0.64 = -32, + 10 = -22
    expect(scoreChallengeOutcome({
      outcome:'LOSS', certaintyAtClaim:0.8, ecosystemNeedWeight:1.0, selfMonitoring:true
    })).toBe(-22);
  });
  test('WIN + constitutionalAdherence bonus', () => {
    // 25 + 8 = 33, under cap
    expect(scoreChallengeOutcome({
      outcome:'WIN', certaintyAtClaim:0.8, ecosystemNeedWeight:1.0,
      constitutionalAdherence:true
    })).toBe(33);
  });
});
