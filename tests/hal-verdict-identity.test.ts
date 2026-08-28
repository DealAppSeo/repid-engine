/**
 * Verdict identity — the model and the family must survive the trip from the
 * provider call to everything that judges it.
 *
 * TWO DEFECTS, ONE ROOT CAUSE, BOTH MEASURED ON PRODUCTION 2026-08-28 at commit
 * 736062e via a keyless `POST /api/v1/hal/evaluate`. A ProviderVerdict is the
 * only record of who said what; both bugs are it arriving downstream stripped.
 *
 * ── 1. THE SUCCESS PATH DROPPED `model`. ─────────────────────────────────────
 *
 * queryProvider's three ERROR returns all set `model: cfg.model`. The one return
 * that carries a real verdict did not. So the field was populated on exactly the
 * paths where no model had answered, and empty on every path where one had.
 *
 * Live evidence — `provider_responses` came back with no model at all:
 *
 *     {"provider":"groq","verdict":"TRUE","confidence":100,"latency_ms":216}
 *
 * ProviderVerdict has declared `model?: string` since CC2, whose comment reads
 * "declaring it here prevents a silent future drop". Declaring a field prevents
 * nothing; the drop was already there, under the declaration meant to stop it.
 *
 * This got worse the day self-healing model selection shipped. Selection now
 * swaps a retired model for a live one automatically (production is currently
 * running a substituted deepseek model chosen from the key's live catalog). The
 * record of WHICH model actually answered is precisely what makes an automatic
 * swap auditable, and it was the thing being discarded.
 *
 * ── 2. THE FAMILY NEVER REACHED SBFA — so the §5 correlated-panel warning was
 *       STRUCTURALLY ALWAYS-ON, and INVERTED. ──────────────────────────────────
 *
 * sbfa-consensus computes:
 *
 *     correlated_warning = oneSided && votes.length >= 4 && families.size <= 2
 *
 * `families` is filled from `v.familyKey`, which votesFromVerdicts sets from
 * `v.family` — a field ProviderVerdict never had. So `families.size` was 0 on
 * every live call, and the warning fired whenever 4+ providers agreed.
 *
 * Live evidence — 4 genuinely independent families answering, and the trace:
 *
 *     "families":["openai","gemini","mistral","qwen"], "quorum":"full"
 *     "⚠ Correlated panel: 0 independent families across 4 one-sided votes"
 *
 * A warning that cannot not-fire carries no information. This one is worse than
 * uninformative: it is loudest exactly when the panel is healthiest, because
 * agreement across MORE independent families raises `votes.length` while
 * `families.size` stays pinned at 0. It inverts the signal it exists to give.
 *
 * The correct family map already existed in the same function — `familyByName`,
 * registry-primary, the source every other family computation in the quorum
 * uses. It was simply never handed to SBFA. The fix passes that one map rather
 * than deriving families a second way that could disagree with it.
 *
 * WHY THESE TESTS WOULD HAVE FAILED BEFORE THE FIX, which is the only reason to
 * trust them: each asserts on a value that was provably absent (undefined model,
 * empty family set), not on a shape that happened to be right.
 */

import { votesFromVerdicts, sbfaConsensus, ConstantReliabilityOracle } from '../src/hal/sbfa-consensus';

const oracle = new ConstantReliabilityOracle(0.7, 4);

/** The exact panel production returned on 2026-08-28: 4 families, all agreeing TRUE. */
const LIVE_PANEL = [
  { provider: 'groq', model: 'openai/gpt-oss-20b', verdict: 'TRUE' as const, confidence: 100 },
  { provider: 'gemini', model: 'gemini-2.5-flash', verdict: 'TRUE' as const, confidence: 100 },
  { provider: 'mistral', model: 'mistral-small-latest', verdict: 'TRUE' as const, confidence: 100 },
  { provider: 'openrouter', model: 'qwen/qwen-2.5-72b-instruct', verdict: 'TRUE' as const, confidence: 100 },
];

const LIVE_FAMILIES: Record<string, string> = {
  groq: 'openai',
  gemini: 'gemini',
  mistral: 'mistral',
  openrouter: 'qwen',
};

describe('DEFECT 2: the family must reach SBFA, or the correlated warning is theatre', () => {
  it('THE BUG: with no family resolver, 4 independent families register as ZERO', () => {
    // This is what production did on every call. Kept as a test so the broken
    // shape is pinned: it is the baseline the fix has to move.
    const votes = votesFromVerdicts(LIVE_PANEL);
    expect(votes.every((v) => v.familyKey === undefined)).toBe(true);

    const v = sbfaConsensus({ votes, stakes: 'medium', action: 'protective', category: 'factual', oracle });
    expect(v.correlated_warning).toBe(true); // fires on a PERFECT panel
    expect(v.trace.lines.join('\n')).toMatch(/0 independent families/);
  });

  it('THE FIX: the resolver carries the registry families through to the vote', () => {
    const votes = votesFromVerdicts(LIVE_PANEL, (p) => LIVE_FAMILIES[p]);
    expect(votes.map((v) => v.familyKey)).toEqual(['openai', 'gemini', 'mistral', 'qwen']);
  });

  it('THE POINT: 4 independent families agreeing no longer trips the warning', () => {
    const votes = votesFromVerdicts(LIVE_PANEL, (p) => LIVE_FAMILIES[p]);
    const v = sbfaConsensus({ votes, stakes: 'medium', action: 'protective', category: 'factual', oracle });
    expect(v.correlated_warning).toBe(false);
    expect(v.trace.lines.join('\n')).not.toMatch(/Correlated panel/);
  });

  it('FAILABILITY: a genuinely correlated panel STILL trips it', () => {
    // Without this the fix could be "delete the warning" and the suite would pass.
    // Four providers, one family — the case §5 is actually about.
    const oneFamily = { groq: 'openai', gemini: 'openai', mistral: 'openai', openrouter: 'openai' };
    const votes = votesFromVerdicts(LIVE_PANEL, (p) => (oneFamily as Record<string, string>)[p]);
    const v = sbfaConsensus({ votes, stakes: 'medium', action: 'protective', category: 'factual', oracle });
    expect(v.correlated_warning).toBe(true);
    expect(v.trace.lines.join('\n')).toMatch(/1 independent family\b/);
  });

  it('FAILABILITY: exactly 2 families still trips it (the boundary is <= 2, unchanged)', () => {
    const twoFamilies = { groq: 'openai', gemini: 'openai', mistral: 'gemini', openrouter: 'gemini' };
    const votes = votesFromVerdicts(LIVE_PANEL, (p) => (twoFamilies as Record<string, string>)[p]);
    const v = sbfaConsensus({ votes, stakes: 'medium', action: 'protective', category: 'factual', oracle });
    expect(v.correlated_warning).toBe(true);
  });

  it('3 families across 4 votes does NOT trip it — the fix must not just move the goalposts', () => {
    const threeFamilies = { groq: 'openai', gemini: 'gemini', mistral: 'mistral', openrouter: 'gemini' };
    const votes = votesFromVerdicts(LIVE_PANEL, (p) => (threeFamilies as Record<string, string>)[p]);
    const v = sbfaConsensus({ votes, stakes: 'medium', action: 'protective', category: 'factual', oracle });
    expect(v.correlated_warning).toBe(false);
  });

  it('an UNRESOLVABLE provider degrades to no family — it must not invent one', () => {
    // A resolver miss has to leave familyKey undefined so the vote is counted as
    // "unknown independence", never silently folded into a family it never had.
    const votes = votesFromVerdicts(LIVE_PANEL, (p) => (p === 'openrouter' ? undefined : LIVE_FAMILIES[p]));
    expect(votes.find((v) => v.validator === 'openrouter')!.familyKey).toBeUndefined();
    expect(votes.filter((v) => v.familyKey).length).toBe(3);
  });

  it('the resolver is OPTIONAL — every existing call site keeps working', () => {
    const votes = votesFromVerdicts(LIVE_PANEL);
    expect(votes).toHaveLength(4);
  });

  it('an explicit verdict.family still wins over the resolver', () => {
    // The builder pre-tags family on some paths; that tag is registry-primary
    // and must not be overwritten by a lookup that could disagree with it.
    const votes = votesFromVerdicts(
      [{ provider: 'groq', model: 'm', verdict: 'TRUE', confidence: 90, family: 'explicit' }],
      () => 'from-resolver',
    );
    expect(votes[0]!.familyKey).toBe('explicit');
  });

  it('ERROR verdicts are still dropped before the family is ever consulted', () => {
    const votes = votesFromVerdicts(
      [...LIVE_PANEL, { provider: 'cerebras', model: 'dead', verdict: 'ERROR' as const, confidence: 0 }],
      (p) => LIVE_FAMILIES[p] ?? 'zai',
    );
    expect(votes).toHaveLength(4);
    expect(votes.some((v) => v.validator === 'cerebras')).toBe(false);
  });
});

describe('DEFECT 1: modelVersion must be the MODEL, not the provider name', () => {
  it('THE BUG SHAPE: a verdict with no model degrades modelVersion to the host', () => {
    // Pinned deliberately. This is what production produced, and it is also the
    // correct DEGRADE behaviour when a model genuinely is unknown — what was
    // wrong is that the success path made it unknown for every live call.
    const votes = votesFromVerdicts([{ provider: 'groq', verdict: 'TRUE', confidence: 100 }]);
    expect(votes[0]!.modelVersion).toBe('groq');
  });

  it('THE FIX: when the verdict carries its model, SBFA keys on the model', () => {
    // §2.1 is explicit that reliability is tracked PER-VERSION, not per-host. With
    // self-healing selection swapping models automatically, a host-keyed oracle
    // would hand a freshly substituted model the retired model's track record.
    const votes = votesFromVerdicts(LIVE_PANEL);
    expect(votes.map((v) => v.modelVersion)).toEqual([
      'openai/gpt-oss-20b',
      'gemini-2.5-flash',
      'mistral-small-latest',
      'qwen/qwen-2.5-72b-instruct',
    ]);
    expect(votes.every((v) => v.modelVersion !== v.validator)).toBe(true);
  });

  it('two models on ONE host stay distinguishable in the trace', () => {
    // The case host-keying silently collapses, and the reason it matters.
    const votes = votesFromVerdicts([
      { provider: 'openrouter', model: 'qwen/qwen-2.5-72b-instruct', verdict: 'TRUE', confidence: 90 },
      { provider: 'openrouter', model: 'deepseek/deepseek-v4', verdict: 'FALSE', confidence: 90 },
    ]);
    expect(new Set(votes.map((v) => v.modelVersion)).size).toBe(2);
  });
});
