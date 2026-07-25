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
});
