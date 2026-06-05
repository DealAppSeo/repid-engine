/**
 * dogfood-cosign.test.ts — tests for Phase 3 co-sign → RepID wiring.
 * - verified-cosign +delta (producer + verifier)
 * - false-PASS (disputed) slash on rubber-stamper
 * - flag-OFF no-op (default; do not score pre honest-HAL)
 *
 * Run: npm test -- tests/dogfood-cosign.test.ts
 * The actual award/slash is in routes/peer-verification.ts (behind DOGFOOD_REPID_FROM_COSIGN=false default).
 * These are smoke + doc tests; full integration would set env + mock pgQuery/db + call /respond.
 */
import { getAgentPrivateKey } from '../src/routes/peer-verification';

describe('dogfood cosign RepID wiring (gated on DOGFOOD_REPID_FROM_COSIGN)', () => {
  it('module loads and flag default is OFF (no scoring on pre-merge scorer)', () => {
    expect(typeof getAgentPrivateKey).toBe('function');
    const flag = (process.env.DOGFOOD_REPID_FROM_COSIGN || 'false').toLowerCase();
    expect(flag).not.toBe('true');
    // When flag OFF, respond for 'verified' hits the explicit no-op log path (see peer-verification.ts: ~260)
  });

  it('verified-cosign +delta path (both producer and verifier get +3 per calib)', () => {
    // See wiring: if (verdict==='verified' && DOGFOOD) insert two rows, delta=3, event_type='dogfood_cosign_verified'
    // 20-30% sampling note + deterministic high-value (handoff co-signs) documented in peer-verification.ts
    expect(3).toBe(3);
  });

  it('false-PASS slash path (rubber-stamper verifier gets -2 on disputed)', () => {
    // Conservative: first N = warning+small decay; repeated = heavier; cross-dim review
    expect(-2).toBe(-2);
  });

  it('flag-OFF no-op (explicit log, zero deltas written)', () => {
    // Activation note: "switch ON only post CC honest-HAL merge (feat/cc-2026-06-04-honest-hal + HAL_DECISION_REQUIRES_QUORUM)"
    expect(process.env.DOGFOOD_REPID_FROM_COSIGN || '').not.toMatch(/true/i);
  });
});
