/**
 * S-HARDEN Phase 6 — provider routing contract.
 *
 * Drives the real `routeRequest()` ANFIS/tiered router and asserts the routing
 * contract. The billing cap-check and ANFIS DB lookup are mocked so the test is
 * deterministic and offline; provider *health* is the in-memory tracker (all
 * healthy by default), so no network is touched.
 *
 * Asserts:
 *   - low-complexity + tier_preference 'auto' routes to a cheap SLM tier
 *   - excludeProviders is honoured — an excluded provider is never chosen and is
 *     recorded in decision.tried
 *   - the returned decision is structurally well-formed (valid tier/reason enums)
 */

// Cap check: always allowed → never the reason routing diverges.
jest.mock('../../src/billing/caps', () => ({
  checkCap: jest.fn().mockResolvedValue({ allowed: true, remaining: 1_000_000 }),
}));

// ANFIS DB lookup + any db touch → inert (no recommendation → deterministic priority order).
jest.mock('../../src/db', () => ({
  db: { rpc: jest.fn().mockResolvedValue({ data: null, error: null }) },
}));

// Token-dependent test: SLM isHealthy checks for HF/Cerebras tokens.
// If no token in env (CI without secret), SKIP visibly (never fake pass with dummy, never WARN downgrade).
// This makes the test honest: skipped when env missing (network/token kind), not broken code.
const HAS_HF_TOKEN = !!process.env.HUGGINGFACE_API_TOKEN;

import { routeRequest } from '../../src/providers/router';

const SHORT = 'Is the sky blue? yes or no';
const VALID_TIERS = ['0a', '1', 'none'];
const VALID_REASONS = [
  'priority_healthy', 'fallback_after_failure', 'tier1_required',
  'all_exhausted', 'cap_hit', 'slm_low_complexity',
];

describe('provider routing — contract', () => {
  it.skipIf(!HAS_HF_TOKEN)('routes a low-complexity auto request to the SLM tier', async () => {
    const { adapter, decision } = await routeRequest({ prompt: SHORT, tier_preference: 'auto' });
    expect(adapter).not.toBeNull();
    expect(decision.chosen_tier).toBe('0a');
    expect(decision.reason).toBe('slm_low_complexity');
    expect(VALID_TIERS).toContain(decision.chosen_tier);
    expect(VALID_REASONS).toContain(decision.reason);
  });

  it('honours excludeProviders — excluded provider is never chosen and is recorded as tried', async () => {
    // First learn which SLM it would pick unprompted...
    const first = await routeRequest({ prompt: SHORT, tier_preference: 'auto' });
    const firstChoice = first.decision.chosen_provider;
    expect(firstChoice).toBeTruthy();

    // ...then exclude it and confirm the router picks something else.
    const { decision } = await routeRequest({ prompt: SHORT, tier_preference: 'auto' }, [firstChoice]);
    expect(decision.chosen_provider).not.toBe(firstChoice);
    expect(decision.tried).toContain(firstChoice);
  });

  it('returns a structurally valid decision even when all SLMs are excluded', async () => {
    const { decision } = await routeRequest(
      { prompt: SHORT, tier_preference: 'auto' },
      ['llama-3-2-1b', 'gemma-3-2b', 'phi-4'],
    );
    expect(VALID_TIERS).toContain(decision.chosen_tier);
    expect(VALID_REASONS).toContain(decision.reason);
    expect(Array.isArray(decision.tried)).toBe(true);
    // none of the excluded SLMs may be the chosen provider
    expect(['llama-3-2-1b', 'gemma-3-2b', 'phi-4']).not.toContain(decision.chosen_provider);
  });
});
