/**
 * LESSONS §5 non-vacuity check: the disabled constitutional-audit stub must be
 * capable of returning a NOT_CHECKED result (passed: false, enabled: false).
 * A stub that always returns passed: true is an instrument that cannot return
 * the other answer — it has measured nothing.
 *
 * These tests run WITHOUT CONSTITUTIONAL_AUDIT_ENABLED, which is the default
 * production state. They verify the sentinel shape callers depend on.
 */

// Ensure the env flag is off for these tests (default, but explicit).
delete process.env['CONSTITUTIONAL_AUDIT_ENABLED'];

import { auditConstitutionalCompliance, CONSTITUTIONAL_AUDIT_ENABLED } from '../src/layers/constitutional-audit';

describe('constitutional-audit disabled stub (NOT_CHECKED sentinel)', () => {
  it('CONSTITUTIONAL_AUDIT_ENABLED is false by default', () => {
    expect(CONSTITUTIONAL_AUDIT_ENABLED).toBe(false);
  });

  it('disabled stub returns enabled: false (NOT_CHECKED, not a measurement)', async () => {
    const result = await auditConstitutionalCompliance({
      agentId: 'test-agent',
      actionType: 'SCORE_EVENT',
      actionMetadata: {},
    });
    expect(result.enabled).toBe(false);
  });

  it('disabled stub returns passed: false — instrument CAN return the other answer (LESSONS §5)', async () => {
    // LESSONS §5: "An instrument that cannot return the other answer has measured nothing."
    // The stub must return passed: false so that a future caller that forgets to check
    // `enabled` gets a NOT_CHECKED fence, not a misleading pass.
    const result = await auditConstitutionalCompliance({
      agentId: 'test-agent',
      actionType: 'SCORE_EVENT',
      actionMetadata: {},
    });
    expect(result.passed).toBe(false);
  });

  it('disabled stub does not block callers that correctly gate on enabled', async () => {
    // All current callers check `audit.enabled` (or `auditActive`) before trusting
    // `audit.passed`. This test proves the gating pattern works: a caller that
    // routes around the stub when `enabled: false` should not be affected by
    // the `passed: false` sentinel.
    const result = await auditConstitutionalCompliance({
      agentId: 'test-agent',
      actionType: 'SCORE_EVENT',
      actionMetadata: {},
    });
    // Simulates how repid-update.ts, mcp.ts, challenge.ts all gate:
    //   const auditActive = audit.enabled;
    //   if (auditActive && !audit.passed) { /* block */ }
    const auditActive = result.enabled;
    const wouldBlock = auditActive && !result.passed;
    expect(wouldBlock).toBe(false); // disabled audit never blocks
  });

  it('disabled stub complianceScore is 1.0 neutral placeholder, not a measurement', async () => {
    const result = await auditConstitutionalCompliance({
      agentId: 'test-agent',
      actionType: 'CHALLENGE',
      actionMetadata: { certainty: 0.95 },
    });
    // Score is 1.0 identity placeholder — callers record null when enabled=false.
    // The value itself is not meaningful when enabled=false.
    expect(result.complianceScore).toBe(1.0);
    expect(result.enabled).toBe(false); // must read alongside enabled
  });
});
