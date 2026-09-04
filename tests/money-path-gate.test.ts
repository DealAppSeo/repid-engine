/**
 * money-path-gate.test.ts — the economic-event → gate mapping (the 🔴 leak seam).
 */
import { evaluateEconomicMove, moneyPathGateMode, EconomicMoveInput } from '../src/kernel/money-path-gate';

const settled = (over: Partial<EconomicMoveInput> = {}): EconomicMoveInput => ({
  delta: 90,
  settled_receipt_id: 'rcpt_contract_1',
  settlement_confirmed: true,
  subject_n: 40,
  subject_u: 0.2,
  is_deliverable: true,
  ...over,
});

describe('money path → policy gate', () => {
  it('authorizes a confirmed service-fulfilment reward (settlement evidence, no HAL quorum)', () => {
    const r = evaluateEconomicMove(settled());
    expect(r.decision).toBe('ALLOW');
    expect(r.authorized_delta).toBe(90);
    expect(r.reasons).toContain('reward_authorized:settlement_sensors');
  });

  it('DENIES the raw-delta leak: an economic move with no settled receipt cannot apply', () => {
    const r = evaluateEconomicMove(settled({ settled_receipt_id: null }));
    expect(r.decision).toBe('DENY');
    expect(r.authorized_delta).toBe(0);
    expect(r.reasons).toContain('no_settled_receipt');
  });

  it('neutralizes a reward when settlement was NOT confirmed and no HAL provider backed it', () => {
    const r = evaluateEconomicMove(settled({ settlement_confirmed: false, hal: { providers_succeeded: 0 } }));
    expect(r.authorized_delta).toBe(0);
    expect(r.reasons).toContain('reward_neutralized:no_evidence');
  });

  it('holds an untested subject (zero-evidence gate) rather than moving durable Rep', () => {
    const r = evaluateEconomicMove(settled({ subject_n: 0, subject_u: 1.0 }));
    expect(r.decision).toBe('ASK');
    expect(r.authorized_delta).toBe(0);
  });

  it('defaults to shadow mode and never silently enforces', () => {
    expect(moneyPathGateMode()).toBe('shadow');
  });
});
