/**
 * S-OPTIMIZE — cost summary aggregation + free-provider classification (pure, main gate).
 */
import { summarize } from '../src/routes/costs';
import { isFreeProvider, frontierCostEstimate, WORKING_FREE_PROVIDERS } from '../src/billing/free-providers';

const call = (over: any = {}) => ({
  provider: 'groq', model: 'llama-3.1-8b-instant',
  prompt_tokens: 100, completion_tokens: 50, total_tokens: 150,
  cost_usd: 0.0001, agent_id: 'trinity-veritas', task_hint: 'peer_verify', status: 'success', ...over,
});

describe('free-providers', () => {
  it('classifies the working free triad as free', () => {
    expect(isFreeProvider('groq')).toBe(true);
    expect(isFreeProvider('cerebras')).toBe(true);
    expect(isFreeProvider('fireworks')).toBe(true);
  });
  it('classifies paid providers as not free', () => {
    for (const p of ['anthropic', 'openai', 'cohere', 'deepseek']) expect(isFreeProvider(p)).toBe(false);
  });
  it('the working free triad excludes together (no key) and uses zai-glm-4.7 for cerebras', () => {
    const models = Object.fromEntries(WORKING_FREE_PROVIDERS.map(p => [p.provider, p.model]));
    expect(models.cerebras).toBe('zai-glm-4.7');
    expect(WORKING_FREE_PROVIDERS.some(p => p.provider === 'together')).toBe(false);
  });
  it('frontier estimate is monotonic in tokens', () => {
    expect(frontierCostEstimate(1000, 1000)).toBeGreaterThan(frontierCostEstimate(100, 100));
  });
});

describe('summarize()', () => {
  it('totals calls, tokens, cost', () => {
    const s = summarize([call(), call({ cost_usd: 0.0002, total_tokens: 200 })]);
    expect(s.last_24h.total_calls).toBe(2);
    expect(s.last_24h.total_tokens).toBe(350);
    expect(s.last_24h.total_cost_usd).toBeCloseTo(0.0003, 6);
  });

  it('splits free vs paid and computes savings for free calls', () => {
    const s = summarize([call({ provider: 'groq' }), call({ provider: 'anthropic', cost_usd: 0.01 })]);
    expect(s.last_24h.free_tier_calls).toBe(1);
    expect(s.last_24h.paid_tier_calls).toBe(1);
    expect(s.last_24h.free_tier_pct).toBe(50);
    // the free call would have cost a frontier model >0; savings >= that minus its tiny actual cost
    expect(s.last_24h.cost_saved_by_free_usd).toBeGreaterThan(0);
  });

  it('ranks top spenders by cost', () => {
    const s = summarize([
      call({ agent_id: 'a', cost_usd: 0.001 }),
      call({ agent_id: 'b', cost_usd: 0.005 }),
      call({ agent_id: 'b', cost_usd: 0.005 }),
    ]);
    expect(s.last_24h.top_spenders[0].agent).toBe('b');
    expect(s.last_24h.top_spenders[0].calls).toBe(2);
  });

  it('groups by provider and task_type', () => {
    const s = summarize([call({ provider: 'groq', task_hint: 'peer_verify' }), call({ provider: 'fireworks', task_hint: 'hal_fact_check' })]);
    expect(Object.keys(s.by_provider)).toEqual(expect.arrayContaining(['groq', 'fireworks']));
    expect(s.by_provider.groq.free).toBe(true);
    expect(Object.keys(s.by_task_type)).toEqual(expect.arrayContaining(['peer_verify', 'hal_fact_check']));
  });

  it('handles empty input', () => {
    const s = summarize([]);
    expect(s.last_24h.total_calls).toBe(0);
    expect(s.last_24h.free_tier_pct).toBe(0);
  });
});
