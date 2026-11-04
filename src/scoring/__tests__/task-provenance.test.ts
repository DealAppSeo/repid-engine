/**
 * task-provenance.test.ts — E/O/S demand-provenance classification (TrustLattice v0.3 §2).
 * The load-bearing property: no affirmative signal ⇒ S (smallest cap, no multiplier), so a
 * swarm-generated task can never masquerade as externally valuable (Grok red-team #1).
 */
import { classifyProvenance, PROVENANCE_CAPS } from '../task-provenance';

describe('classifyProvenance — demand provenance class', () => {
  it("insert_source='system' (the automated swarm) is S, capped, no multiplier", () => {
    const v = classifyProvenance({ insert_source: 'system' });
    expect(v.provenanceClass).toBe('S');
    expect(v.rewardCap).toBe(PROVENANCE_CAPS.S);
    expect(v.multiplierEligible).toBe(false);
  });

  it('a human-conductor dispatch source is O', () => {
    for (const src of ['claude-sprint', 'claude-loop', 'claude-now', 'strategy-claude-phone-dispatch', 'cowork-cl-session', 'cc-open-pool-day-2026-09-10']) {
      expect(classifyProvenance({ insert_source: src }).provenanceClass).toBe('O');
    }
    const v = classifyProvenance({ insert_source: 'claude-sprint' });
    expect(v.rewardCap).toBe(PROVENANCE_CAPS.O);
    expect(v.multiplierEligible).toBe(false); // O is fixed at D=1
  });

  it('an explicit owner signature in metadata is O even from an unknown source', () => {
    expect(classifyProvenance({ insert_source: 'some-one-off', metadata: { owner_signed: true } }).provenanceClass).toBe('O');
  });

  it('an affirmative external-demand signal is E, and only E may carry a multiplier', () => {
    const sponsor = classifyProvenance({ insert_source: 'system', metadata: { external_sponsor: 'acme-corp' } });
    expect(sponsor.provenanceClass).toBe('E'); // beats the 'system' default — evidence wins
    expect(sponsor.multiplierEligible).toBe(true);
    expect(sponsor.rewardCap).toBe(PROVENANCE_CAPS.E);
    expect(classifyProvenance({ insert_source: 'x', metadata: { demand_evidence_ref: 'gh#1234' } }).provenanceClass).toBe('E');
  });

  it('unknown / null / empty / historical one-off sources default to S (conservative floor)', () => {
    for (const src of [null, undefined, '', 'always-on-v1', 'autonomous-apr4', 'overnight-apr5', 'evergreen-apr20', 'trustshell-day1', 'mvp-launch-apr19']) {
      const v = classifyProvenance({ insert_source: src });
      expect(v.provenanceClass).toBe('S');
      expect(v.multiplierEligible).toBe(false);
    }
  });

  it('empty/whitespace metadata signals do not promote out of S (nonEmpty guard)', () => {
    expect(classifyProvenance({ insert_source: 'system', metadata: { external_sponsor: '   ' } }).provenanceClass).toBe('S');
    expect(classifyProvenance({ insert_source: 'system', metadata: { owner_signed: 'true' } }).provenanceClass).toBe('S'); // string, not boolean true
  });

  it('cap ordering encodes the anti-gaming intent: E > O > S', () => {
    expect(PROVENANCE_CAPS.E).toBeGreaterThan(PROVENANCE_CAPS.O);
    expect(PROVENANCE_CAPS.O).toBeGreaterThan(PROVENANCE_CAPS.S);
  });
});
