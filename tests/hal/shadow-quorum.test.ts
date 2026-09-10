/**
 * Shadow planner for the 6-provider HAL claim.
 *
 * Live fact-check STOPS at 2 families (MIN_QUORUM_FOR_VETO) so it does not
 * spend the rest of the card. This planner names the gap. It never fetches.
 *
 * Production change that fails this: live stop no longer 2, or claimed slots
 * no longer 6, or failover that does not keep going after a failed free wave.
 */
import {
  CLAIMED_PROVIDER_SLOTS,
  LIVE_STOP_AT_FAMILIES,
  planQuorum,
  type ShadowProvider,
} from '../../src/hal/shadow-quorum';

const SIX: ShadowProvider[] = [
  { name: 'groq', family: 'llama' },
  { name: 'gemini', family: 'gemini' },
  { name: 'mistral', family: 'mistral' },
  { name: 'zai', family: 'glm' },
  { name: 'cerebras', family: 'llama' },
  // no family → costTierOf ranks openrouter as escalation (the paid wave)
  { name: 'openrouter' },
];

describe('shadow quorum toward 6 providers', () => {
  it('names the claim as 6 slots and the live stop as 2 families', () => {
    expect(CLAIMED_PROVIDER_SLOTS).toBe(6);
    expect(LIVE_STOP_AT_FAMILIES).toBe(2);
  });

  it('live path stops once 2 families succeed — does not dial escalation', () => {
    const plan = planQuorum({
      providers: SIX,
      wouldSucceed: new Set(['groq', 'gemini']),
    });
    expect(plan.liveWouldCall).not.toContain('openrouter');
    expect(plan.liveWouldCall).toContain('groq');
    expect(plan.liveFamilies.size).toBeGreaterThanOrEqual(LIVE_STOP_AT_FAMILIES);
    expect(plan.gap).toContain('openrouter');
  });

  it('failover still dials later tiers when the free wave gets zero families', () => {
    const plan = planQuorum({
      providers: SIX,
      wouldSucceed: new Set(['openrouter']),
    });
    expect(plan.liveWouldCall).toContain('openrouter');
    expect(plan.shadowWouldCall).toEqual(SIX.map((p) => p.name));
  });

  it('does not call fetch', () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    planQuorum({ providers: SIX, wouldSucceed: new Set(['groq', 'gemini']) });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
