/**
 * tests/anfis-category-router.test.ts
 *
 * Unit tests for C1 (category → provider routing) and C2 (cheapest-competent selection).
 * No DB calls — shadow log is not invoked. All assertions are on pure decision logic.
 */

import {
  selectForCategory,
  inferCategory,
  PROVIDER_POOL,
  type ProviderCandidate,
  type PromptCategory,
} from '../src/services/anfis-category-router';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Build a minimal provider pool for isolated tests. */
function makePool(overrides: Partial<ProviderCandidate>[] = []): ProviderCandidate[] {
  return overrides.map((o, i) => ({
    provider: `provider-${i}`,
    model: `model-${i}`,
    hitRate: 0.90,
    avgLatencyMs: 300,
    avgCostUsdc: 100,
    ...o,
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// C1: category → provider routing
// ──────────────────────────────────────────────────────────────────────────────

describe('C1: selectForCategory', () => {
  test('returns a decision with required fields', () => {
    const d = selectForCategory('factual');
    expect(d).toMatchObject({
      provider: expect.any(String),
      modelSlug: expect.stringContaining('/'),
      confidence: expect.any(Number),
      costTier: expect.stringMatching(/^(free|cheap|escalation)$/),
      category: 'factual',
    });
  });

  test('modelSlug is provider/model format', () => {
    const d = selectForCategory('math');
    const [prov, ...rest] = d.modelSlug.split('/');
    expect(prov).toBe(d.provider);
    expect(rest.join('/')).toBeTruthy();
  });

  test('confidence is clamped to [0, 1]', () => {
    const d = selectForCategory('code');
    expect(d.confidence).toBeGreaterThanOrEqual(0);
    expect(d.confidence).toBeLessThanOrEqual(1);
  });

  test('all categories produce a valid decision', () => {
    const categories: PromptCategory[] = [
      'factual', 'math', 'code', 'creative', 'opinion',
      'classification', 'routing_decision', 'quick_check', 'general',
    ];
    for (const cat of categories) {
      const d = selectForCategory(cat);
      expect(d.provider).toBeTruthy();
      expect(d.category).toBe(cat);
    }
  });

  test('decision is consistent across multiple calls for same input', () => {
    const d1 = selectForCategory('factual');
    const d2 = selectForCategory('factual');
    expect(d1.provider).toBe(d2.provider);
    expect(d1.confidence).toBeCloseTo(d2.confidence, 5);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// C2: cheapest-competent selection
// ──────────────────────────────────────────────────────────────────────────────

describe('C2: cheapest-competent selection', () => {
  test('picks free-tier provider when it clears the competence floor', () => {
    // groq is free tier and has hitRate 0.92, which clears every category floor
    const d = selectForCategory('factual');
    // The default pool has groq (free) as highest-fitness in its tier
    expect(['groq', 'cerebras']).toContain(d.provider);
    expect(d.costTier).toBe('free');
  });

  test('escalates to next tier when free tier misses the floor', () => {
    // Build a pool where free-tier providers are below the floor for 'math' (floor 0.88)
    const pool: ProviderCandidate[] = [
      { provider: 'groq',     model: 'llama-3.1-8b-instant', hitRate: 0.70, avgLatencyMs: 180, avgCostUsdc: 68 },
      { provider: 'cerebras', model: 'llama3.1-8b',           hitRate: 0.72, avgLatencyMs: 150, avgCostUsdc: 75 },
      { provider: 'deepseek', model: 'deepseek-chat',         hitRate: 0.90, avgLatencyMs: 900, avgCostUsdc: 270 },
    ];
    const d = selectForCategory('math', pool);
    // Only deepseek clears 0.88 floor, even though it's not free tier
    expect(d.provider).toBe('deepseek');
  });

  test('costSavedUsd is ≥ 0', () => {
    const d = selectForCategory('general');
    expect(d.costSavedUsd).toBeGreaterThanOrEqual(0);
  });

  test('rejectedCheaper includes providers that missed the floor', () => {
    // Build a pool where one provider is too weak for 'math' (floor 0.88)
    const pool: ProviderCandidate[] = [
      { provider: 'weak',   model: 'weak-model',   hitRate: 0.60, avgLatencyMs: 100, avgCostUsdc: 50  },
      { provider: 'groq',   model: 'llama-3.1-8b-instant', hitRate: 0.92, avgLatencyMs: 180, avgCostUsdc: 68  },
    ];
    const d = selectForCategory('math', pool);
    expect(d.rejectedCheaper.some(r => r.provider === 'weak')).toBe(true);
    expect(d.provider).toBe('groq');
  });

  test('falls back gracefully when all providers miss the floor', () => {
    // All below floor — should still return a decision (best available)
    const pool: ProviderCandidate[] = [
      { provider: 'groq', model: 'tiny', hitRate: 0.50, avgLatencyMs: 100, avgCostUsdc: 10 },
    ];
    const d = selectForCategory('math', pool);
    expect(d.provider).toBe('groq'); // fallback to only available
  });

  test('alternativesTried lists higher-tier or lower-fitness candidates', () => {
    // Multi-provider pool: winner is free-tier; alternatives in same tier are listed
    const pool: ProviderCandidate[] = [
      { provider: 'groq',     model: 'm', hitRate: 0.92, avgLatencyMs: 180, avgCostUsdc: 68  },
      { provider: 'cerebras', model: 'm', hitRate: 0.88, avgLatencyMs: 150, avgCostUsdc: 75  },
      { provider: 'gemini',   model: 'm', hitRate: 0.85, avgLatencyMs: 400, avgCostUsdc: 90  },
    ];
    const d = selectForCategory('factual', pool);
    // groq wins (highest fitness in free tier); cerebras + gemini are alternatives
    expect(d.alternativesTried).toContain('cerebras');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Category inference (inferCategory)
// ──────────────────────────────────────────────────────────────────────────────

describe('inferCategory', () => {
  test('classification hint → classification', () => {
    expect(inferCategory('classify this', 'classification')).toBe('classification');
  });

  test('math expression → math', () => {
    expect(inferCategory('What is 12 × 12?')).toBe('math');
  });

  test('short prompt → quick_check', () => {
    expect(inferCategory('ok', undefined)).toBe('quick_check');
  });

  test('code keyword → code', () => {
    expect(inferCategory('Implement a binary search function in Python')).toBe('code');
  });

  test('creative keyword → creative', () => {
    expect(inferCategory('Write a short story about a dragon')).toBe('creative');
  });

  test('factual question → factual', () => {
    expect(inferCategory('What is the capital of France?')).toBe('factual');
  });

  test('routing_decision hint → classification', () => {
    expect(inferCategory('route this request', 'routing_decision')).toBe('classification');
  });

  test('long generic prompt → general', () => {
    const longPrompt = 'Please analyze the following scenario in detail and provide a comprehensive answer considering all perspectives. '.repeat(5);
    expect(inferCategory(longPrompt)).toBe('general');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Default pool sanity
// ──────────────────────────────────────────────────────────────────────────────

describe('PROVIDER_POOL sanity', () => {
  test('pool is non-empty', () => {
    expect(PROVIDER_POOL.length).toBeGreaterThan(0);
  });

  test('every candidate has required fields', () => {
    for (const p of PROVIDER_POOL) {
      expect(typeof p.provider).toBe('string');
      expect(typeof p.model).toBe('string');
      expect(p.hitRate).toBeGreaterThan(0);
      expect(p.avgLatencyMs).toBeGreaterThan(0);
      expect(p.avgCostUsdc).toBeGreaterThan(0);
    }
  });

  test('includes both free and non-free providers for escalation coverage', () => {
    const tiers = new Set(PROVIDER_POOL.map(p => {
      // Mirror the costTierOf logic: groq/gemini/cerebras = free, deepseek = cheap, rest = escalation
      const k = p.provider.toLowerCase();
      if (/groq|gemini|cerebras/.test(k)) return 'free';
      if (/deepseek/.test(k)) return 'cheap';
      return 'escalation';
    }));
    expect(tiers.has('free')).toBe(true);
    expect(tiers.has('escalation')).toBe(true);
  });
});
