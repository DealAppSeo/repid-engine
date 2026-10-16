/**
 * The A2A ring/Sybil simulation is a ruler. It must be deterministic for a given seed, and it must be
 * able to return the other answer: under the owner-distinct counterfactual the same-operator income
 * goes to zero while honest income does not move.
 */
import { runA2ARingSim } from '../scripts/repid-sim/a2a-ring-sim';

const base = { seed: 12345, days: 30, ringTradesPerPairPerDay: 2 };

describe('a2a ring/Sybil sim', () => {
  it('is deterministic per seed', () => {
    expect(runA2ARingSim({ ...base, ownerDistinctRule: false })).toEqual(runA2ARingSim({ ...base, ownerDistinctRule: false }));
  });

  it('live rules: same-operator trading out-earns honest delivery (the finding)', () => {
    const r = runA2ARingSim({ ...base, ownerDistinctRule: false });
    expect(r.honest_beats.fabrication).toBe(true);
    expect(r.honest_beats.collusion).toBe(false);
    expect(r.honest_beats.sybil).toBe(false);
    // The DB counterparty gate counts agents, so a ring clears it; counted by operator it would not.
    expect(r.ring_member.tier).toBe('VETERAN');
    expect(r.ring_member.tier_if_counterparties_by_operator).toBe('ESTABLISHED');
  });

  it('owner-distinct counterfactual: ring and sock-puppet income go to zero, honest income is unchanged', () => {
    const live = runA2ARingSim({ ...base, ownerDistinctRule: false });
    const rule = runA2ARingSim({ ...base, ownerDistinctRule: true });
    expect(rule.ring_member.net_avg).toBe(0);
    expect(rule.sybil_provider.net).toBe(0);
    expect(rule.honest.net).toBe(live.honest.net);
    expect(rule.honest_beats).toMatchObject({ fabrication: true, collusion: true, sybil: true });
  });
});
