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

/**
 * MEASURED WIDTH — the number of independent families the F1 0.94 / zero-FP claim was
 * established at. A result gathered at fewer families is a result about a DIFFERENT
 * configuration, so it can neither confirm nor refute the frozen number.
 */
const MEASURED_AT_FAMILIES = 3;

/**
 * Run the set once and report the width it actually ran at alongside the outcome.
 *
 * WHY THE WIDTH IS RETURNED, not just the verdicts (2026-08-01): this tripwire failed
 * locally and read as "math accuracy regressed". It had not. A stale GROQ key 401'd and
 * gemini 404'd, so HAL answered on 2 families — exactly MIN_QUORUM_FOR_VETO, so it was
 * never marked degraded and returned ordinary verdicts. The quality assertion then failed
 * for a reason that had nothing to do with quality.
 *
 * A tripwire that reports a provider outage as a quality regression costs more than it
 * saves: it sends whoever reads it hunting for a bug in the scoring path. And a bare
 * pass is just as misleading in the other direction — green at 2 families does not
 * re-establish a number measured at 3. Same defect as the HAL F1 spread (0.34 / 0.74 /
 * 0.886 / 0.890): different rulers reported as one scale.
 *
 * So the width is asserted FIRST and separately. A dead key now fails as a dead key.
 */
async function runGoldenSet(claims: string[], providers: ReturnType<typeof buildFactCheckProviders>) {
  const results: Array<{ claim: string; decision: string; families: number }> = [];
  let minFamilies = Infinity;
  for (const claim of claims) {
    const r = await factCheck(claim, providers);
    const width = r.families_used ?? r.providers_used;
    minFamilies = Math.min(minFamilies, width);
    results.push({ claim, decision: r.decision, families: width });
  }
  return { results, minFamilies };
}

const widthFailure = (minFamilies: number, claimName: string, results: Array<{ claim: string; decision: string }>) =>
  new Error(
    `PROVIDER FLEET DEGRADED, NOT A QUALITY REGRESSION: HAL answered on ${minFamilies} independent ` +
    `famil${minFamilies === 1 ? 'y' : 'ies'}, but the frozen ${claimName} claim was measured at ` +
    `${MEASURED_AT_FAMILIES}. Fix the provider keys, then re-read this result. ` +
    `Decisions at this width: ${results.map((r) => `${r.claim} -> ${r.decision}`).join(' | ')}`,
  );

(HAS_KEYS ? describe : describe.skip)('GOLDEN-MATH TRIPWIRE (real providers)', () => {
  const providers = buildFactCheckProviders();
  jest.setTimeout(180_000);

  it('recall = 1.0 — every false arithmetic claim is vetoed', async () => {
    const { results, minFamilies } = await runGoldenSet(GOLDEN_MATH_FALSE, providers);
    // Width first: below this, a quality result is uninterpretable either way.
    if (minFamilies < MEASURED_AT_FAMILIES) throw widthFailure(minFamilies, 'recall=1.0', results);
    const missed = results.filter((r) => r.decision !== 'vetoed').map((r) => `${r.claim} -> ${r.decision}`);
    // atFamilies rides along so a green tick records the width it was green AT.
    expect({ missed, atFamilies: minFamilies }).toEqual({ missed: [], atFamilies: minFamilies });
  });

  it('0 false positives — no true arithmetic claim is vetoed', async () => {
    const { results, minFamilies } = await runGoldenSet(GOLDEN_MATH_TRUE, providers);
    if (minFamilies < MEASURED_AT_FAMILIES) throw widthFailure(minFamilies, 'zero-false-positive', results);
    const falsePos = results.filter((r) => r.decision === 'vetoed').map((r) => `${r.claim} -> ${r.decision}`);
    expect({ falsePos, atFamilies: minFamilies }).toEqual({ falsePos: [], atFamilies: minFamilies });
  });
});
