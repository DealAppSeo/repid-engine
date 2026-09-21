import { callWithCascade } from '../../src/providers/cascade-integration';

const LONG_CONFIDENT_OUTPUT =
  'The answer is 42. This is confirmed by multiple studies conducted in 2023 across 15 countries. ' +
  'The primary mechanism involves three distinct pathways: alpha, beta, and gamma, each contributing ' +
  'approximately 33% to the final outcome. Statistical significance: p < 0.001.';

const SHORT_UNCERTAIN_OUTPUT = "I'm not sure about this.";

function makeCall(output: string, costUsd = 0.001): () => Promise<{ output: string; costUsd: number }> {
  return async () => ({ output, costUsd });
}

describe('callWithCascade', () => {
  const origEnv = process.env['CASCADE_SPECULATION_ENABLED'];

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['CASCADE_SPECULATION_ENABLED'];
    } else {
      process.env['CASCADE_SPECULATION_ENABLED'] = origEnv;
    }
  });

  it('returns skipped:true when gate is off', async () => {
    delete process.env['CASCADE_SPECULATION_ENABLED'];
    const result = await callWithCascade({
      draftFn: makeCall(LONG_CONFIDENT_OUTPUT),
      escalateFn: makeCall(LONG_CONFIDENT_OUTPUT, 0.01),
      escalateBaselineCostUsd: 0.01,
    });
    expect(result.skipped).toBe(true);
    if (result.skipped) expect(result.reason).toBe('gate_disabled');
  });

  it('accepts high-confidence draft without calling escalate', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    let escalateCalled = false;
    const result = await callWithCascade({
      draftFn: makeCall(LONG_CONFIDENT_OUTPUT, 0.001),
      escalateFn: async () => { escalateCalled = true; return { output: 'escalated', costUsd: 0.01 }; },
      escalateBaselineCostUsd: 0.01,
    });
    expect(escalateCalled).toBe(false);
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.usedEscalation).toBe(false);
      expect(result.savedUsd).toBeGreaterThan(0);
    }
  });

  it('escalates when draft confidence is too low', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    let escalateCalled = false;
    const result = await callWithCascade({
      draftFn: makeCall(SHORT_UNCERTAIN_OUTPUT, 0.001),
      escalateFn: async () => { escalateCalled = true; return { output: LONG_CONFIDENT_OUTPUT, costUsd: 0.01 }; },
      escalateBaselineCostUsd: 0.01,
    });
    expect(escalateCalled).toBe(true);
    expect(result.skipped).toBe(false);
    if (!result.skipped) expect(result.usedEscalation).toBe(true);
  });

  it('falls back to draft gracefully when escalate throws', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    const result = await callWithCascade({
      draftFn: makeCall(SHORT_UNCERTAIN_OUTPUT, 0.001),
      escalateFn: async () => { throw new Error('provider unavailable'); },
      escalateBaselineCostUsd: 0.01,
    });
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      // Escalate threw; fallback used draft output
      expect(result.output).toBe(SHORT_UNCERTAIN_OUTPUT);
    }
  });

  it('reports savedUsd correctly on accept-draft path', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    const baselineCost = 0.02;
    const draftCost = 0.001;
    const result = await callWithCascade({
      draftFn: makeCall(LONG_CONFIDENT_OUTPUT, draftCost),
      escalateFn: makeCall(LONG_CONFIDENT_OUTPUT, baselineCost),
      escalateBaselineCostUsd: baselineCost,
    });
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.savedUsd).toBeCloseTo(baselineCost - draftCost, 5);
    }
  });
});
