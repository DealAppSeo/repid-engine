/** Hard rule: an agent may not validate its own work. */
import { isIndependentlyVerified } from '../src/services/trinity-task-bridge';

describe('isIndependentlyVerified', () => {
  test('self-completed, no verifier → NOT verified', () => {
    expect(isIndependentlyVerified({ verifier_agent_id: null, verify_count: 0, final_verdict: null, verifier_verdict: null })).toBe(false);
  });

  test('independent verifier + pass verdict → verified', () => {
    expect(isIndependentlyVerified({ verifier_agent_id: 'uuid-b', verify_count: 1, verifier_verdict: 'pass' })).toBe(true);
    expect(isIndependentlyVerified({ verifier_agent_id: 'uuid-b', verify_count: 1, final_verdict: 'verified' })).toBe(true);
  });

  test('independent verifier but DISPUTED → NOT verified', () => {
    expect(isIndependentlyVerified({ verifier_agent_id: 'uuid-b', verify_count: 1, verifier_verdict: 'disputed' })).toBe(false);
    expect(isIndependentlyVerified({ verifier_agent_id: 'uuid-b', verify_count: 1, final_verdict: 'fail' })).toBe(false);
  });

  test('verify_count 0 (verifier field set but no actual verification) → NOT verified', () => {
    expect(isIndependentlyVerified({ verifier_agent_id: 'uuid-b', verify_count: 0, verifier_verdict: 'pass' })).toBe(false);
  });

  test('pass verdict but no verifier id → NOT verified (cannot self-assert)', () => {
    expect(isIndependentlyVerified({ verifier_agent_id: null, verify_count: 1, verifier_verdict: 'pass' })).toBe(false);
  });

  /**
   * The cases above assert against a vocabulary the DATABASE rejects. Prod carries
   * (read 2026-07-27):
   *   verifier_verdict ∈ {approved, rejected, unclear}
   *   final_verdict    ∈ {verified_done, disputed_done, rejected, unverified, spot_audited}
   * So 'pass' / 'verified' / 'fail' can never reach these columns — a write raises
   * 23514. These are the values that actually can.
   */
  describe('DB-legal verdict vocabulary', () => {
    const V = 'uuid-b';

    test('final_verdict=verified_done is a pass (it could not be, before)', () => {
      expect(isIndependentlyVerified({ verifier_agent_id: V, verify_count: 1, final_verdict: 'verified_done' })).toBe(true);
    });

    test('final_verdict=spot_audited is a pass', () => {
      expect(isIndependentlyVerified({ verifier_agent_id: V, verify_count: 1, final_verdict: 'spot_audited' })).toBe(true);
    });

    test('verifier_verdict=approved is a pass', () => {
      expect(isIndependentlyVerified({ verifier_agent_id: V, verify_count: 1, verifier_verdict: 'approved' })).toBe(true);
    });

    test.each(['disputed_done', 'rejected', 'unverified'])(
      'final_verdict=%s is NOT a pass',
      (fv) => {
        expect(isIndependentlyVerified({ verifier_agent_id: V, verify_count: 1, final_verdict: fv })).toBe(false);
      }
    );

    test.each(['rejected', 'unclear'])('verifier_verdict=%s is NOT a pass', (vv) => {
      expect(isIndependentlyVerified({ verifier_agent_id: V, verify_count: 1, verifier_verdict: vv })).toBe(false);
    });

    /**
     * The widened vocabulary changes NOTHING on live data: `verifier_agent_id` is
     * non-null on 0 of 362,965 rows all-time, so `hasIndependentVerifier` is false
     * for every row that exists and the verdict branch is never reached.
     */
    test('no verifier id still short-circuits, whatever the verdict says', () => {
      for (const fv of ['verified_done', 'spot_audited']) {
        expect(isIndependentlyVerified({ verifier_agent_id: null, verify_count: 5, final_verdict: fv })).toBe(false);
      }
    });
  });
});
