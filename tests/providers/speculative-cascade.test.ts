/**
 * ANFIS speculative cascade (backlog item 8, 2026-08-31).
 *
 * Pure decision layer: run a cheap draft, escalate only when its measured confidence
 * misses the bar. No provider calls here — `draft`/`escalate` are injected fakes standing
 * in for a real cheap/strong model call, exactly like slm-tier.test.ts and
 * anfis-escalation-gate.test.ts test their neighbors.
 */
import {
  runSpeculativeCascade,
  CASCADE_CONFIDENCE_THRESHOLD,
} from '../../src/providers/speculative-cascade';

function attempt(output: string, confidence: number, costUsd: number) {
  return async () => ({ output, confidence, costUsd });
}

describe('runSpeculativeCascade', () => {
  test('accepts the draft when confidence clears the default threshold — no escalation', async () => {
    const escalate = jest.fn(attempt('strong', 0.99, 0.05));
    const decision = await runSpeculativeCascade({
      draft: attempt('cheap', 0.9, 0.01),
      escalate,
      escalateBaselineCostUsd: 0.05,
    });

    expect(decision.usedEscalation).toBe(false);
    expect(decision.output).toBe('cheap');
    expect(decision.draftConfidence).toBe(0.9);
    expect(decision.finalConfidence).toBe(0.9);
    expect(decision.costUsd).toBe(0.01);
    expect(decision.savedUsd).toBeCloseTo(0.04);
    expect(escalate).not.toHaveBeenCalled();
  });

  test('escalates when draft confidence misses the threshold, and reports total cost', async () => {
    const decision = await runSpeculativeCascade({
      draft: attempt('cheap', 0.4, 0.01),
      escalate: attempt('strong', 0.95, 0.05),
      escalateBaselineCostUsd: 0.05,
    });

    expect(decision.usedEscalation).toBe(true);
    expect(decision.output).toBe('strong');
    expect(decision.draftConfidence).toBe(0.4);
    expect(decision.finalConfidence).toBe(0.95);
    expect(decision.costUsd).toBeCloseTo(0.06);
    // draft + escalate cost more than the always-escalate baseline — the draft was wasted spend.
    expect(decision.savedUsd).toBeCloseTo(-0.01);
  });

  test('a custom confidenceThreshold overrides the default', async () => {
    const escalate = jest.fn(attempt('strong', 0.99, 0.05));
    const decision = await runSpeculativeCascade({
      draft: attempt('cheap', 0.5, 0.01),
      escalate,
      escalateBaselineCostUsd: 0.05,
      confidenceThreshold: 0.4,
    });

    expect(decision.usedEscalation).toBe(false);
    expect(escalate).not.toHaveBeenCalled();
  });

  test('exact-threshold confidence is accepted, not escalated (>=, not >)', async () => {
    const escalate = jest.fn(attempt('strong', 0.99, 0.05));
    const decision = await runSpeculativeCascade({
      draft: attempt('cheap', CASCADE_CONFIDENCE_THRESHOLD, 0.01),
      escalate,
      escalateBaselineCostUsd: 0.05,
    });

    expect(decision.usedEscalation).toBe(false);
    expect(escalate).not.toHaveBeenCalled();
  });

  test('savedUsd never goes negative on the accept-draft path even if draft cost exceeds baseline', async () => {
    const decision = await runSpeculativeCascade({
      draft: attempt('cheap', 0.8, 10),
      escalate: attempt('strong', 0.99, 0.05),
      escalateBaselineCostUsd: 0.05,
    });

    expect(decision.usedEscalation).toBe(false);
    expect(decision.savedUsd).toBe(0);
  });
});
