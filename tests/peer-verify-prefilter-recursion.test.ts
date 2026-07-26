/**
 * L2 breaker 2.3 — structural self-referential ban.
 * A peer-verify task must be detectable so the bridge never spawns a
 * peer-verification of a peer-verification (the unbounded recursion root-caused
 * in reports/2026-07-25/BEAT2_PEER_VERIFY_STALL_AND_GATE_ROOTCAUSE.md).
 */
import { isPeerVerificationTask } from '../src/services/peer-verify-prefilter';

describe('isPeerVerificationTask (breaker 2.3)', () => {
  test('task_type=peer_verify → true (the reader-stamped signal)', () => {
    expect(isPeerVerificationTask({ task_type: 'peer_verify' })).toBe(true);
    expect(isPeerVerificationTask({ task_type: 'PEER_VERIFY' })).toBe(true);
  });

  test('title prefix [PEER_VERIFY] / [PEER_VERIFY_PANEL] → true', () => {
    expect(
      isPeerVerificationTask({ title: '[PEER_VERIFY] Verify response from trinity-orch' })
    ).toBe(true);
    expect(
      isPeerVerificationTask({ title: '[PEER_VERIFY_PANEL] Verify response from trinity-apm' })
    ).toBe(true);
    // leading whitespace tolerated
    expect(isPeerVerificationTask({ title: '  [PEER_VERIFY] x' })).toBe(true);
  });

  test('metadata.peer_verification_queue_id present → true (object or JSON string)', () => {
    expect(isPeerVerificationTask({ metadata: { peer_verification_queue_id: 42 } })).toBe(true);
    expect(
      isPeerVerificationTask({ metadata: JSON.stringify({ peer_verification_queue_id: 'q-1' }) })
    ).toBe(true);
  });

  test('ordinary deliverable task → false (first-order verification still allowed)', () => {
    expect(
      isPeerVerificationTask({
        task_type: 'code_contribution',
        title: 'Implement CRAG stage-0',
        metadata: { provider_used: 'groq' },
      })
    ).toBe(false);
  });

  test('empty / malformed inputs → false (no crash, no false ban)', () => {
    expect(isPeerVerificationTask({})).toBe(false);
    expect(isPeerVerificationTask({ task_type: null, title: null, metadata: null })).toBe(false);
    expect(isPeerVerificationTask({ metadata: 'not json{' })).toBe(false);
    // a title that merely mentions the phrase mid-string is NOT a peer-verify task
    expect(isPeerVerificationTask({ title: 'Discuss the [PEER_VERIFY] design' })).toBe(false);
  });
});
