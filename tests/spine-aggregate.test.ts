/**
 * S-SPINE — unit tests for the leaderboard aggregation + provider availability.
 * Pure logic, no DB. Runs in the main `npm test` gate.
 */
import { aggregate, SessionRow } from '../src/routes/leaderboard';
import { __providers } from '../src/routes/providers';

const row = (over: Partial<SessionRow>): SessionRow => ({
  llm_provider_used: 'groq',
  llm_model: 'llama-3.3-70b',
  hal_score: 0.2,
  hal_signals: {
    harm_probability: 0.05, epistemic_uncertainty: 0.1, evidence_quality: 0.8,
    scope_appropriateness: 0.9, certainty_at_claim: 0.85,
  },
  hal_verdict: 'PASS',
  hal_flagged_hallucination: false,
  created_at: '2026-06-01T00:00:00Z',
  ...over,
});

describe('leaderboard aggregate()', () => {
  it('groups by provider and ranks by lowest avg risk', () => {
    const rows = [
      row({ llm_provider_used: 'groq', hal_score: 0.2 }),
      row({ llm_provider_used: 'groq', hal_score: 0.4 }),
      row({ llm_provider_used: 'claude', hal_score: 0.1 }),
    ];
    const agg = aggregate(rows);
    expect(agg.map(a => a.name)).toEqual(['claude', 'groq']); // claude (0.10) ranks above groq (0.30)
    const groq = agg.find(a => a.name === 'groq')!;
    expect(groq.total_evaluations).toBe(2);
    expect(groq.avg_score).toBeCloseTo(0.3, 5);
  });

  it('computes hallucination_rate and veto_rate', () => {
    const rows = [
      row({ hal_flagged_hallucination: true, hal_verdict: 'VETO' }),
      row({ hal_flagged_hallucination: false, hal_verdict: 'PASS' }),
      row({ hal_flagged_hallucination: false, hal_verdict: 'PASS' }),
      row({ hal_flagged_hallucination: false, hal_verdict: 'PASS' }),
    ];
    const [g] = aggregate(rows);
    expect(g!.hallucination_rate).toBeCloseTo(0.25, 5);
    expect(g!.veto_rate).toBeCloseTo(0.25, 5);
  });

  it('averages the five HAL signals', () => {
    const rows = [
      row({ hal_signals: { harm_probability: 0.0, epistemic_uncertainty: 0.2, evidence_quality: 1.0, scope_appropriateness: 0.8, certainty_at_claim: 0.6 } }),
      row({ hal_signals: { harm_probability: 0.2, epistemic_uncertainty: 0.4, evidence_quality: 0.8, scope_appropriateness: 1.0, certainty_at_claim: 0.8 } }),
    ];
    const [g] = aggregate(rows);
    expect(g!.avg_signals.harm_probability).toBeCloseTo(0.1, 5);
    expect(g!.avg_signals.evidence_quality).toBeCloseTo(0.9, 5);
  });

  it('attaches display metadata for known providers and a fallback for unknown', () => {
    const agg = aggregate([row({ llm_provider_used: 'groq' }), row({ llm_provider_used: 'mystery-llm' })]);
    expect(agg.find(a => a.name === 'groq')!.company).toBe('Groq');
    const unknown = agg.find(a => a.name === 'mystery-llm')!;
    expect(unknown.display_name).toBe('mystery-llm');
    expect(unknown.company).toBe('—');
  });

  it('handles an empty input', () => {
    expect(aggregate([])).toEqual([]);
  });
});

describe('providers listing', () => {
  it('declares the canonical 8 providers with env + model', () => {
    const ids = __providers.map(p => p.id);
    expect(ids).toEqual(expect.arrayContaining(['anthropic', 'openai', 'groq', 'cerebras', 'fireworks', 'gemini', 'deepseek', 'cohere']));
    for (const p of __providers) {
      expect(p.env).toMatch(/_API_KEY$/);
      expect(p.default_model.length).toBeGreaterThan(0);
    }
  });
});
