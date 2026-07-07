/**
 * Anti-Sybil MVP (2026-07-07) — T2 hole #3 close (counterparty diversity).
 *
 * Proves the KEYSTONE invariant from the task: 2 sockpuppet (SIMULATED) buyers
 * no longer clear the AUTONOMOUS floor once simulated counterparties are excluded.
 *
 * Executable in CI (no prod mutation): this exercises the TS mirror in
 * src/services/counterparty-diversity.ts, which encodes the SAME rule as
 * migration 20260707120000_counterparty_exclude_simulated.sql (the reference the
 * SQL must match). The live SQL gate is proved separately by the live-DB test
 * (counterparty-gate.test.ts) once the migration is Sean-applied.
 */
import {
  countUniqueCounterparties,
  computeTierWithFloor,
  contractIsNonSimulated,
} from '../../../src/services/counterparty-diversity';

const AUTONOMOUS_REPID = 6000; // score-tier AUTONOMOUS; only the cp floor can cap it

// The §3 farm: provider P, 2 sockpuppet buyers B1/B2, all contracts simulated.
const SIM_FARM = [
  { buyer_agent_id: 'B1', settlement_is_simulated: true,  metadata: {}, payload: {} },
  { buyer_agent_id: 'B2', settlement_is_simulated: true,  metadata: {}, payload: {} },
  { buyer_agent_id: 'B1', metadata: { is_simulated: 'true' }, payload: {} }, // jsonb-flag variant
];

// Two REAL paying buyers.
const REAL_TWO = [
  { buyer_agent_id: 'R1', settlement_is_simulated: false, metadata: {}, payload: {} },
  { buyer_agent_id: 'R2', settlement_is_simulated: false, metadata: {}, payload: {} },
];

describe('counterparty diversity excludes simulated (T2 hole #3)', () => {
  it('sim-flag detection matches the truthy normalizer', () => {
    expect(contractIsNonSimulated({ buyer_agent_id: 'x', settlement_is_simulated: true })).toBe(false);
    expect(contractIsNonSimulated({ buyer_agent_id: 'x', metadata: { is_simulated: 'YES' } })).toBe(false);
    expect(contractIsNonSimulated({ buyer_agent_id: 'x', payload: { is_simulated: 1 } })).toBe(false);
    expect(contractIsNonSimulated({ buyer_agent_id: 'x', settlement_is_simulated: false })).toBe(true);
  });

  it('flag OFF (default): 2 sim sockpuppets STILL clear AUTONOMOUS (today’s hole, unchanged)', () => {
    const cp = countUniqueCounterparties(SIM_FARM, /* excludeSimulated */ false);
    expect(cp).toBe(2); // B1, B2 both count
    expect(computeTierWithFloor(AUTONOMOUS_REPID, cp)).toBe('AUTONOMOUS');
  });

  it('flag ON: 2 sim sockpuppets → cp 0 → CAPPED at ESTABLISHED (the close)', () => {
    const cp = countUniqueCounterparties(SIM_FARM, /* excludeSimulated */ true);
    expect(cp).toBe(0); // all simulated → none count
    const tier = computeTierWithFloor(AUTONOMOUS_REPID, cp);
    expect(tier).toBe('ESTABLISHED');
    expect(tier).not.toBe('AUTONOMOUS');
  });

  it('flag ON: 2 REAL buyers still clear AUTONOMOUS (honest earning unaffected)', () => {
    const cp = countUniqueCounterparties(REAL_TWO, /* excludeSimulated */ true);
    expect(cp).toBe(2);
    expect(computeTierWithFloor(AUTONOMOUS_REPID, cp)).toBe('AUTONOMOUS');
  });

  it('flag ON: 1 real + 1 sim buyer → cp 1 → still capped (need 2 real)', () => {
    const mixed = [
      { buyer_agent_id: 'R1', settlement_is_simulated: false },
      { buyer_agent_id: 'S1', settlement_is_simulated: true },
    ];
    const cp = countUniqueCounterparties(mixed, true);
    expect(cp).toBe(1);
    expect(computeTierWithFloor(AUTONOMOUS_REPID, cp)).toBe('ESTABLISHED');
  });
});
