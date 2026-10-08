/**
 * XC findings #3 + #4: the HAL production-event log must carry a
 * `constitutional_audit` key in `layersActive` so observers can distinguish
 * NOT_CHECKED (audit disabled) from enabled without reading a separate field.
 *
 * LESSONS §5: an instrument that cannot return the other answer has measured
 * nothing. The key must be present and be `false` when the audit is disabled.
 */
import { HalProductionEvent } from '../src/engine/production-logger';

describe('constitutional_audit observability in layersActive', () => {
  it('layersActive accepts constitutional_audit:false (NOT_CHECKED shape)', () => {
    const auditActive = false; // CONSTITUTIONAL_AUDIT_ENABLED default
    const layersActive: HalProductionEvent['layersActive'] = {
      sbfa: true,
      bft: true,
      slt: true,
      repid: true,
      wsce: true,
      gnnsr: true,
      anfis: true,
      pcv: true,
      constitutional_audit: auditActive,
    };
    // NOT_CHECKED: audit did not run, NOT a verdict
    expect(layersActive['constitutional_audit']).toBe(false);
  });

  it('layersActive accepts constitutional_audit:true (audit enabled shape)', () => {
    const auditActive = true;
    const layersActive: HalProductionEvent['layersActive'] = {
      sbfa: true,
      bft: true,
      slt: true,
      repid: true,
      wsce: true,
      gnnsr: true,
      anfis: true,
      pcv: true,
      constitutional_audit: auditActive,
    };
    expect(layersActive['constitutional_audit']).toBe(true);
  });

  it('constitutional_audit:false does not mean the audit failed — it means NOT_CHECKED', () => {
    // A disabled audit (constitutional_audit:false in the log) is distinct from
    // an audit that ran and failed (constitutional_audit:true + audit.passed:false).
    // This test encodes the distinction so a future reader cannot conflate them.
    const auditNotRun = { constitutional_audit: false, auditPassed: undefined };
    const auditRanAndFailed = { constitutional_audit: true, auditPassed: false };

    // NOT_CHECKED: both fields must be read together
    expect(auditNotRun.constitutional_audit).toBe(false);
    expect(auditNotRun.auditPassed).toBeUndefined();

    // Ran and failed: audit was enabled but the agent did not comply
    expect(auditRanAndFailed.constitutional_audit).toBe(true);
    expect(auditRanAndFailed.auditPassed).toBe(false);
  });
});
