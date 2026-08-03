/**
 * Provider-list integrity — the width half of the ruler must refuse corrupt input.
 *
 * Every fixture here is a shape VERIFIED to exist in production `hal_runner_results`
 * on 2026-08-03 (1825 rows; column confirmed `text[]` via information_schema):
 *
 *   1419 rows  '{}'                     -> empty-list
 *      1 row   NULL                     -> not-an-array
 *     69 rows  {"used:1"}               -> count-smuggled-as-name
 *     12 rows  {"used:2"}               -> count-smuggled-as-name  (array_length 1, truth 2)
 *    324 rows  {"litellm"}              -> gateway-not-a-family
 *     10 rows  {"gemini"} / 3 {"groq"}  -> the only real family names in the table
 *
 * The point of every assertion below is REFUSAL. Nothing here may coerce `used:2`
 * into the number 2, and nothing may treat an empty list as a width of 0.
 */

import {
  GATEWAY_PROVIDER_LABELS,
  MalformedProviderListError,
  WidthCollapseError,
  assertProviderList,
  assertUniformCaseWidth,
  caseWidthFromProviderList,
  censusCaseWidths,
  configurationWidthFromCensus,
  inspectProviderList,
  providerListFaults,
  summarizeCaseWidths,
  widthCollapseFault,
} from '../src/hal/provider-width';
import { describeWidth } from '../src/hal/measurement-ruler';
import { assessRunIntegrity } from '../src/hal/measurement-integrity';

function kinds(raw: unknown): string[] {
  return providerListFaults(raw).map((f) => f.kind);
}

describe('the live corruption: a count smuggled into a name array', () => {
  it('refuses {"used:2"} — the exact 12 live rows', () => {
    expect(kinds(['used:2'])).toEqual(['count-smuggled-as-name']);
    expect(() => caseWidthFromProviderList(['used:2'])).toThrow(MalformedProviderListError);
  });

  it('refuses {"used:1"} — the other 69 live rows', () => {
    expect(kinds(['used:1'])).toEqual(['count-smuggled-as-name']);
  });

  it('never recovers the count: "used:2" does not become 2, it becomes a refusal', () => {
    const verdict = inspectProviderList(['used:2']);
    expect(verdict.usable).toBe(false);
    // The bug in one line: array_length is 1 while the run reached 2.
    expect((['used:2'] as string[]).length).toBe(1);
  });

  it('explains WHY the length lies, so the message cannot be skimmed as generic', () => {
    let msg = '';
    try {
      caseWidthFromProviderList(['used:2'], 'run ga-internal');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('COUNT');
    expect(msg).toContain('understates width');
    expect(msg).toContain('array_length 1');
    expect(msg).toContain('run ga-internal');
  });

  it('also refuses the bare-number variant the same writer would degrade into', () => {
    expect(kinds(['2'])).toEqual(['count-smuggled-as-name']);
    expect(kinds(['used = 3'])).toEqual(['count-smuggled-as-name']);
  });

  it('does not mistake a real provider name that merely contains digits', () => {
    expect(providerListFaults(['llama3', 'gpt-4o'])).toEqual([]);
    expect(caseWidthFromProviderList(['llama3', 'gpt-4o'])).toBe(2);
  });
});

describe('empty and absent lists are UNKNOWN width, never zero', () => {
  it('refuses the empty array — 1419 live rows', () => {
    expect(kinds([])).toEqual(['empty-list']);
    expect(() => caseWidthFromProviderList([])).toThrow(MalformedProviderListError);
  });

  it('refuses NULL — the 1 live row', () => {
    expect(kinds(null)).toEqual(['not-an-array']);
    expect(kinds(undefined)).toEqual(['not-an-array']);
  });

  it('says UNKNOWN rather than 0, because 0 would be a quotable number', () => {
    expect(providerListFaults([])[0]!.detail).toContain('UNKNOWN, not 0');
    expect(providerListFaults(null)[0]!.detail).toContain('NOT zero');
  });

  it('refuses a non-array that is not null (a bare string, an object)', () => {
    expect(kinds('litellm')).toEqual(['not-an-array']);
    expect(kinds({ providers: ['groq'] })).toEqual(['not-an-array']);
    expect(kinds(2)).toEqual(['not-an-array']);
  });
});

describe('a gateway is not a family', () => {
  it('refuses {"litellm"} — the 324 rows that LOOK clean', () => {
    expect(kinds(['litellm'])).toEqual(['gateway-not-a-family']);
    expect(() => caseWidthFromProviderList(['litellm'])).toThrow(MalformedProviderListError);
  });

  it('accepts the genuinely real family names found in the same column', () => {
    expect(providerListFaults(['gemini'])).toEqual([]);
    expect(providerListFaults(['groq'])).toEqual([]);
    expect(caseWidthFromProviderList(['gemini', 'groq'])).toBe(2);
  });

  it('is case-insensitive and covers the other transports', () => {
    expect(kinds(['LiteLLM'])).toEqual(['gateway-not-a-family']);
    for (const g of GATEWAY_PROVIDER_LABELS) expect(kinds([g])).toEqual(['gateway-not-a-family']);
  });

  it('states the consequence: counting a gateway would overstate independence', () => {
    expect(providerListFaults(['litellm'])[0]!.detail).toContain('overstate the independence');
  });

  /**
   * The decisive live shape. `gemini` (10) and `groq` (3) NEVER appear without `litellm` — the
   * ga-internal width-2 cases are {litellm, gemini}, not two families. Element arithmetic confirms it:
   * 312 rows at width 1 + 11 at width 2 + 1 at width 3 = 337 elements = 324 litellm + 10 gemini + 3 groq.
   * So the "width 2" a naive count reports is one gateway plus one family: true width UNKNOWN, not 2.
   */
  it('refuses a gateway+family pair — the shape a naive count would call "2 families"', () => {
    expect(kinds(['litellm', 'gemini'])).toEqual(['gateway-not-a-family']);
    expect(() => caseWidthFromProviderList(['litellm', 'gemini'])).toThrow(MalformedProviderListError);
    expect(kinds(['litellm', 'gemini', 'groq'])).toEqual(['gateway-not-a-family']);
  });
});

describe('other malformed shapes', () => {
  it('refuses non-string and blank elements', () => {
    // A numeric element is refused as non-string before the count check ever sees it —
    // either way it is refused, which is the property that matters.
    expect(kinds([2])).toEqual(['non-string-element']);
    expect(kinds([null])).toEqual(['non-string-element']);
    expect(kinds([{ provider: 'groq' }])).toEqual(['non-string-element']);
    expect(kinds(['   '])).toEqual(['blank-element']);
  });

  it('refuses duplicates rather than inflating the width', () => {
    expect(kinds(['groq', 'groq'])).toEqual(['duplicate-provider']);
    expect(kinds(['groq', 'GROQ'])).toEqual(['duplicate-provider']);
  });

  it('reports every fault at once, not just the first', () => {
    expect(kinds(['used:2', 'litellm', ''])).toEqual([
      'count-smuggled-as-name',
      'gateway-not-a-family',
      'blank-element',
    ]);
  });

  it('offers no lenient mode — there is no fallback parameter to reach for', () => {
    expect(caseWidthFromProviderList.length).toBe(2); // (raw, context) only
    expect(() => assertProviderList(['used:2'])).toThrow(MalformedProviderListError);
  });
});

describe('per-case width collapse cannot be reported as a run-level width', () => {
  /** The live distribution of run ga-internal-2026-06-09T04-05-38-350Z, independently verified. */
  const GA_INTERNAL = [
    ...Array<string[]>(312).fill(['groq']),
    ...Array<string[]>(11).fill(['groq', 'gemini']),
    ...Array<string[]>(1).fill(['groq', 'gemini', 'deepseek']),
  ];

  it('reproduces the verified live shape: 312 at 1, 11 at 2, 1 at 3', () => {
    const census = censusCaseWidths(GA_INTERNAL);
    expect(census.total).toBe(324);
    expect(summarizeCaseWidths(census).histogram).toEqual([
      { width: 1, cases: 312 },
      { width: 2, cases: 11 },
      { width: 3, cases: 1 },
    ]);
  });

  it('refuses to call that run "3 families" (the flattering max)', () => {
    const fault = widthCollapseFault(censusCaseWidths(GA_INTERNAL));
    expect(fault).not.toBeNull();
    expect(fault).toContain('NON-UNIFORM');
    expect(fault).toContain('RANGE 1-3');
    expect(() => assertUniformCaseWidth(censusCaseWidths(GA_INTERNAL))).toThrow(WidthCollapseError);
  });

  it('reports no fractional mean — no case was ever judged at 1.04 families', () => {
    const s = summarizeCaseWidths(censusCaseWidths(GA_INTERNAL));
    expect(s.description).not.toMatch(/\d\.\d/);
    expect(s.min).toBe(1);
    expect(s.max).toBe(3);
    expect(s.uniform).toBe(false);
  });

  it('preserves the collapse into the ruler, where it degrades the width and blocks the number', () => {
    const width = configurationWidthFromCensus({
      census: censusCaseWidths(GA_INTERNAL),
      familiesConfigured: 3,
      strictness: 2,
      decisionRequiresQuorum: true,
      penaltyRequiresQuorum: true,
    });
    expect(width.familiesMin).toBe(1);
    expect(width.familiesMax).toBe(3);
    // #327's renderer must show the degradation rather than a single flattering number.
    expect(describeWidth(width)).toContain('1-3 families (observed)');
    expect(describeWidth(width)).toContain('DEGRADED: configured 3');
    // ...and #327's gate must refuse the measurement outright.
    expect(assessRunIntegrity({ attempts: [], width }).measurable).toBe(false);
  });

  it('permits a run-level width only when every case truly reached the same width', () => {
    const census = censusCaseWidths(Array<string[]>(50).fill(['groq', 'gemini']));
    expect(widthCollapseFault(census)).toBeNull();
    expect(() => assertUniformCaseWidth(census)).not.toThrow();
    expect(summarizeCaseWidths(census).description).toBe('all 50 cases judged at 2 families');
  });

  it('a refused case is not a case at width 0 — it makes the run-level width unknown', () => {
    const census = censusCaseWidths([['groq', 'gemini'], [], ['groq', 'gemini']]);
    expect(census.usableWidths).toEqual([2, 2]); // the empty list is NOT folded in as 0
    expect(census.refused).toHaveLength(1);
    // Min would otherwise be a silent 0, which reads as a real observation.
    expect(widthCollapseFault(census)).toContain('not a case at width 0');
    expect(() =>
      configurationWidthFromCensus({
        census,
        familiesConfigured: 2,
        strictness: 2,
        decisionRequiresQuorum: true,
        penaltyRequiresQuorum: true,
      }),
    ).toThrow(WidthCollapseError);
  });

  it('refuses a width for the all-empty runs (the 1419-row shape) rather than reporting 0', () => {
    const census = censusCaseWidths(Array<string[]>(330).fill([]));
    expect(census.usableWidths).toEqual([]);
    expect(summarizeCaseWidths(census).description).toContain('UNKNOWN');
    expect(() =>
      configurationWidthFromCensus({
        census,
        familiesConfigured: 2,
        strictness: 2,
        decisionRequiresQuorum: true,
        penaltyRequiresQuorum: true,
      }),
    ).toThrow(WidthCollapseError);
  });

  it('refuses the mixed empty+smuggled run (cc-measure: 43 empty, 66 counts)', () => {
    const census = censusCaseWidths([
      ...Array<string[]>(43).fill([]),
      ...Array<string[]>(66).fill(['used:1']),
    ]);
    expect(census.total).toBe(109);
    expect(census.refused).toHaveLength(109); // every single case refused
    expect(census.usableWidths).toEqual([]);
  });
});

describe('purity — this module may not touch a decision or the environment', () => {
  it('is deterministic and reads no env', () => {
    const before = JSON.stringify(process.env);
    expect(caseWidthFromProviderList(['groq', 'gemini'])).toBe(2);
    expect(caseWidthFromProviderList(['groq', 'gemini'])).toBe(2);
    expect(JSON.stringify(process.env)).toBe(before);
  });

  it('does not mutate the input list', () => {
    const raw = ['groq', 'gemini'];
    caseWidthFromProviderList(raw);
    expect(raw).toEqual(['groq', 'gemini']);
  });
});
