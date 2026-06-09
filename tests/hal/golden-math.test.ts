/**
 * A3 — family-independence audit (deterministic) + the GOLDEN-MATH TRIPWIRE.
 *
 * Math is HAL's crown jewel (F1 0.94, zero false positives). This fixture freezes 20 exact-checkable
 * arithmetic claims — 10 false (MUST be caught / vetoed = recall) and 10 true (MUST NOT be vetoed =
 * 0 false positives). The tripwire runs them through HAL's REAL decision path and FAILS if math
 * recall < 1.0 or any math false-positive appears. It runs only when provider keys are present
 * (skips keyless in unit CI); GA's keyed CI runs it for real.
 */
import { auditFamilyIndependence, buildFactCheckProviders, factCheck, type FactCheckProviderCfg } from '../../src/hal/fact-check';

describe('A3 family-independence audit', () => {
  it('flags a collapse when two providers share a base model family', () => {
    const collapsed: FactCheckProviderCfg[] = [
      { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'llama-3.3-70b', family: 'llama' },
      { name: 'cerebras', endpoint: 'x', apiKey: 'k', model: 'llama-3.1-8b', family: 'llama' }, // SAME family
      { name: 'gemini', endpoint: 'x', apiKey: 'k', model: 'gemini-2.0-flash', family: 'gemini' },
    ];
    const a = auditFamilyIndependence(collapsed);
    expect(a.independent).toBe(false);
    expect(a.collapsed).toEqual([{ family: 'llama', providers: ['groq', 'cerebras'] }]);
  });
  it('passes when all providers are distinct families', () => {
    const ok: FactCheckProviderCfg[] = [
      { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'llama-3.3-70b', family: 'llama' },
      { name: 'gemini', endpoint: 'x', apiKey: 'k', model: 'gemini-2.0-flash', family: 'gemini' },
      { name: 'deepseek', endpoint: 'x', apiKey: 'k', model: 'deepseek-chat', family: 'deepseek' },
    ];
    expect(auditFamilyIndependence(ok).independent).toBe(true);
  });
});

// GOLDEN MATH SET — frozen. false arithmetic must be vetoed; true arithmetic must not.
export const GOLDEN_MATH_FALSE = [
  '2 + 2 = 5', '7 * 8 = 54', '12 / 4 = 4', '100 - 37 = 73', '9 squared is 80',
  'The square root of 144 is 11', '3 to the power of 4 is 64', '15 % 4 = 2',
  '1000 / 8 = 120', 'The sum of the first 5 prime numbers is 26',
];
export const GOLDEN_MATH_TRUE = [
  '2 + 2 = 4', '7 * 8 = 56', '12 / 4 = 3', '100 - 37 = 63', '9 squared is 81',
  'The square root of 144 is 12', '3 to the power of 4 is 81', '15 % 4 = 3',
  '1000 / 8 = 125', 'The sum of the first 5 prime numbers is 28',
];

const HAS_KEYS = !!(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || process.env.DEEPSEEK_API_KEY);
(HAS_KEYS ? describe : describe.skip)('GOLDEN-MATH TRIPWIRE (real providers)', () => {
  const providers = buildFactCheckProviders();
  jest.setTimeout(120_000);

  it('recall = 1.0 — every false arithmetic claim is vetoed', async () => {
    const missed: string[] = [];
    for (const claim of GOLDEN_MATH_FALSE) {
      const r = await factCheck(claim, providers);
      if (r.decision !== 'vetoed') missed.push(`${claim} -> ${r.decision}`);
    }
    expect(missed).toEqual([]); // any miss = math recall dropped below 1.0
  });

  it('0 false positives — no true arithmetic claim is vetoed', async () => {
    const falsePos: string[] = [];
    for (const claim of GOLDEN_MATH_TRUE) {
      const r = await factCheck(claim, providers);
      if (r.decision === 'vetoed') falsePos.push(`${claim} -> ${r.decision}`);
    }
    expect(falsePos).toEqual([]); // any veto on true math = a math false positive
  });
});
