/**
 * Earn-gate — a POSITIVE RepID reward requires an affirmative signal (a real deliverable
 * domain, or a HAL fact-check that returned clean), not merely "HAL didn't veto it".
 *
 * This is the fix for the /run "+19 per prompt" theater: an advisory chatbot answer
 * (task_domain 'general', asserted outcome 'success') is not verified good, only not-caught,
 * so it must earn ~0. A real deliverable, or a fact-checked-clean factual claim, still earns.
 */
import { isDeliverableDomain } from '../src/scoring/task-purpose';

describe('isDeliverableDomain — the reward gate signal', () => {
  it('is TRUE for explicit work-product domains', () => {
    for (const d of ['code', 'service_contract', 'build', 'bugfix', 'refactor', 'engineering']) {
      expect(isDeliverableDomain(d)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isDeliverableDomain('CODE')).toBe(true);
    expect(isDeliverableDomain('Service_Contract')).toBe(true);
  });

  it('is FALSE for advisory / conversational / unknown domains (the /run chatbot case)', () => {
    for (const d of ['general', 'chat', 'conversation', 'qa', 'advice', 'random', '']) {
      expect(isDeliverableDomain(d)).toBe(false);
    }
    expect(isDeliverableDomain(null)).toBe(false);
    expect(isDeliverableDomain(undefined)).toBe(false);
  });
});

describe('earn decision — positiveEarned = deliverableDomain OR factCheckClean', () => {
  // Mirror of the score-event gate so the policy is asserted as a unit, not just at the route.
  const earned = (domain: string | null, factCheckClean: boolean) =>
    isDeliverableDomain(domain) || factCheckClean;

  it('advisory chatbot answer, not fact-checked → NOT earned (this is the +19 bug)', () => {
    expect(earned('general', false)).toBe(false);
  });

  it('advisory prompt that IS a verifiable claim, fact-check clean → earned', () => {
    // e.g. "Paris is the capital of France" — HAL fact-check ran and confirmed clean
    expect(earned('general', true)).toBe(true);
  });

  it('real deliverable (code) earns without needing a fact-check', () => {
    expect(earned('code', false)).toBe(true);
  });

  it('a deliverable that is also fact-check clean still earns', () => {
    expect(earned('service_contract', true)).toBe(true);
  });
});
