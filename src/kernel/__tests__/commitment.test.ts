/**
 * Mission 1 — acceptance test for the loop's Predict → Commit leg (test #4).
 *
 * The kernel commits {expectedResult, successCriteria, confidence, resourceLimits, deadline},
 * keyed + timestamped, BEFORE the grant; a later outcome references that immutable commitment;
 * and calibration is RECORDED, never scored. These assertions pin exactly that.
 *
 * KEYED, not a bare salted hash: the commitment is an HMAC under a server secret the agent never
 * holds, so a short/sensitive value (a one-line success criterion, a confidence of 0.7) cannot be
 * brute-forced or forged for a different value. The tests below prove the wrong key cannot verify
 * and cannot reproduce the commitment.
 */
import {
  commitPrediction,
  verifyRevealedPrediction,
  committedBeforeGrant,
  recordCalibration,
  CommitmentError,
  COMMITMENT_SECRET_MISSING,
  type PredictionClaim,
} from '../commitment';

const KEY = 'test-only-kernel-commitment-key';
const OTHER_KEY = 'a-different-secret-the-agent-does-not-hold';

const CLAIM: PredictionClaim = {
  expectedResult: 'the target file compiles and the suite passes',
  successCriteria: 'npm test exits 0 and tsc --noEmit is clean',
  confidence: 0.7,
  resourceLimits: { usdc: 5, seconds: 120 },
  deadline: '2026-10-14T00:00:00.000Z',
};
const COMMIT_AT = Date.parse('2026-10-13T10:00:00.000Z');
const nowAt = (ms: number) => () => ms;

// The env secret must be ABSENT for the fail-closed tests; every other test passes opts.key.
beforeEach(() => { delete process.env.KERNEL_COMMITMENT_KEY; });
afterEach(() => { delete process.env.KERNEL_COMMITMENT_KEY; });

describe('(1) a prediction is committed, keyed + timestamped, BEFORE the grant', () => {
  it('commits and verifies the exact revealed claim', () => {
    const rec = commitPrediction(CLAIM, { key: KEY, now: nowAt(COMMIT_AT) });
    expect(rec.scheme).toBe('hmac-sha256');
    expect(rec.committedAt).toBe('2026-10-13T10:00:00.000Z');
    expect(typeof rec.commitment).toBe('string');
    expect(rec.commitment).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(verifyRevealedPrediction(CLAIM, rec, { key: KEY })).toEqual({ matches: true, reason: 'ok' });
  });

  it('committedBeforeGrant: the commitment precedes the grant', () => {
    const rec = commitPrediction(CLAIM, { key: KEY, now: nowAt(COMMIT_AT) });
    expect(committedBeforeGrant(rec, COMMIT_AT + 5 * 60_000)).toBe(true);  // grant 5 min AFTER commit
    expect(committedBeforeGrant(rec, COMMIT_AT - 5 * 60_000)).toBe(false); // a "commit" after the grant is refused
  });
});

describe('(2) the commitment is immutable — tampering with ANY committed field is detected', () => {
  const rec = () => commitPrediction(CLAIM, { key: KEY, now: nowAt(COMMIT_AT) });
  const tampered: Array<[string, PredictionClaim]> = [
    ['expectedResult', { ...CLAIM, expectedResult: 'something easier' }],
    ['successCriteria', { ...CLAIM, successCriteria: 'it ran at all' }],
    ['confidence', { ...CLAIM, confidence: 0.99 }],
    ['resourceLimits', { ...CLAIM, resourceLimits: { usdc: 500, seconds: 120 } }],
    ['deadline', { ...CLAIM, deadline: '2027-01-01T00:00:00.000Z' }],
  ];
  it.each(tampered)('a changed %s does not verify against the original commitment', (_field, altered) => {
    const r = verifyRevealedPrediction(altered, rec(), { key: KEY });
    expect(r.matches).toBe(false);
    expect(r.reason).toBe('commitment_mismatch');
  });
});

describe('(3) KEYED, not a bare salted hash — the wrong key cannot verify or reproduce it', () => {
  it('a commitment made under KEY does not verify under a different key', () => {
    const rec = commitPrediction(CLAIM, { key: KEY, now: nowAt(COMMIT_AT) });
    expect(verifyRevealedPrediction(CLAIM, rec, { key: OTHER_KEY }).matches).toBe(false);
  });
  it('the same claim under two secrets yields two different commitments', () => {
    const a = commitPrediction(CLAIM, { key: KEY, now: nowAt(COMMIT_AT) });
    const b = commitPrediction(CLAIM, { key: OTHER_KEY, now: nowAt(COMMIT_AT) });
    expect(a.commitment).not.toBe(b.commitment);
  });
});

describe('(4) a later outcome references the immutable commitment; calibration is RECORDED, never scored', () => {
  it('the calibration row carries the commitment and the predicted confidence, with NO score', () => {
    const rec = commitPrediction(CLAIM, { key: KEY, now: nowAt(COMMIT_AT) });
    const row = recordCalibration(CLAIM, rec, { outcome: 'right', at: COMMIT_AT + 3600_000 });
    expect(row.commitment).toBe(rec.commitment);            // ties the outcome to the earlier commitment
    expect(row.predictedConfidence).toBe(0.7);
    expect(row.outcome).toBe('right');
    expect(row.committedAt).toBe(rec.committedAt);
    // Calibration is SHADOW — recorded, never scored. No delta/score may leak in.
    expect('delta' in row).toBe(false);
    expect('score' in row).toBe(false);
    expect('appliedDelta' in row).toBe(false);
    expect('repIdAfter' in row).toBe(false);
  });
});

describe('(5) fail closed — no key means no commitment can be made or verified', () => {
  it('commitPrediction with no key (env unset) throws', () => {
    expect(() => commitPrediction(CLAIM)).toThrow(CommitmentError);
    expect(() => commitPrediction(CLAIM)).toThrow(COMMITMENT_SECRET_MISSING);
  });
  it('verify with no key does not silently pass — it returns not-matched', () => {
    const rec = commitPrediction(CLAIM, { key: KEY, now: nowAt(COMMIT_AT) });
    const r = verifyRevealedPrediction(CLAIM, rec); // no key, env unset
    expect(r.matches).toBe(false);
    expect(r.reason).toBe('secret_missing');
  });
  it('reads the key from KERNEL_COMMITMENT_KEY when no opts.key is given', () => {
    process.env.KERNEL_COMMITMENT_KEY = KEY;
    const rec = commitPrediction(CLAIM, { now: nowAt(COMMIT_AT) });
    expect(verifyRevealedPrediction(CLAIM, rec).matches).toBe(true);
  });
});

describe('(6) a malformed claim is refused before anything is committed', () => {
  it.each([
    ['confidence > 1', { ...CLAIM, confidence: 1.5 }],
    ['confidence < 0', { ...CLAIM, confidence: -0.1 }],
    ['confidence NaN', { ...CLAIM, confidence: Number.NaN }],
    ['empty expectedResult', { ...CLAIM, expectedResult: '' }],
    ['empty successCriteria', { ...CLAIM, successCriteria: '   ' }],
    ['bad deadline', { ...CLAIM, deadline: 'tomorrow-ish' }],
    ['negative resource limit', { ...CLAIM, resourceLimits: { usdc: -1 } }],
  ])('%s → CommitmentError', (_why, bad) => {
    expect(() => commitPrediction(bad as PredictionClaim, { key: KEY, now: nowAt(COMMIT_AT) })).toThrow(CommitmentError);
  });
});
