/**
 * provider-liveness.test.ts
 *
 * The rules that matter here are the REFUSALS — the cases where the module
 * declines to act on something that looks like bad news. Those are what stop an
 * automatic exclusion from becoming a worse outage than the one it prevents:
 *
 *   - INCONCLUSIVE never excludes (a timeout is not evidence about a key)
 *   - a stale DEAD verdict never excludes (a rotated key must recover)
 *   - exclusion is withheld entirely when it would drop independent family width
 *     below the floor — HAL counts families, so quietly narrowing the quorum
 *     trades a loud failure for a silent one
 *   - `off` is inert
 */

import {
  assessLiveness,
  deadProviders,
  recordVerdict,
  clearVerdicts,
  getVerdicts,
  parseLivenessMode,
  livenessExcludedProviders,
  livenessLogLine,
  refreshFleetLiveness,
  familyOf,
  DEFAULT_MIN_FAMILIES,
  LIVENESS_MODE_ENV,
  type LivenessVerdict,
} from '../src/providers/provider-liveness';

const NOW = 1_800_000_000_000;

/** Real families from the probe table: groq/cerebras=llama, gemini, deepseek, mistral, grok... */
const CHAIN = ['groq', 'gemini', 'deepseek', 'mistral', 'openrouter'];

function verdict(provider: string, status: LivenessVerdict['status'], ageMs = 0): LivenessVerdict {
  return { provider, status, detail: `test ${status}`, observedAt: NOW - ageMs };
}

beforeEach(() => {
  clearVerdicts();
  delete process.env[LIVENESS_MODE_ENV];
});

afterAll(() => {
  clearVerdicts();
  delete process.env[LIVENESS_MODE_ENV];
});

describe('mode parsing', () => {
  it('defaults to off for unset, empty and unrecognised values', () => {
    for (const raw of [undefined, null, '', '  ', 'yes', 'true', 'ENFORCED']) {
      expect(parseLivenessMode(raw as any)).toBe('off');
    }
  });

  it('accepts shadow and enforce case- and whitespace-insensitively', () => {
    expect(parseLivenessMode(' ShAdOw ')).toBe('shadow');
    expect(parseLivenessMode('ENFORCE')).toBe('enforce');
  });
});

describe('deadProviders — only fresh DEAD counts', () => {
  it('returns a fresh DEAD provider', () => {
    recordVerdict(verdict('groq', 'DEAD'));
    expect(deadProviders(NOW, 60_000)).toEqual(['groq']);
  });

  it('ignores INCONCLUSIVE — a timeout is not evidence about a key', () => {
    recordVerdict(verdict('groq', 'INCONCLUSIVE'));
    expect(deadProviders(NOW, 60_000)).toEqual([]);
  });

  it('ignores LIVE', () => {
    recordVerdict(verdict('groq', 'LIVE'));
    expect(deadProviders(NOW, 60_000)).toEqual([]);
  });

  it('ignores a DEAD verdict older than the TTL, so a rotated key recovers', () => {
    recordVerdict(verdict('groq', 'DEAD', 90_000));
    expect(deadProviders(NOW, 60_000)).toEqual([]);
  });

  it('treats a verdict exactly at the TTL boundary as still fresh', () => {
    recordVerdict(verdict('groq', 'DEAD', 60_000));
    expect(deadProviders(NOW, 60_000)).toEqual(['groq']);
  });

  it('a later verdict replaces an earlier one for the same provider', () => {
    recordVerdict(verdict('groq', 'DEAD'));
    recordVerdict(verdict('groq', 'LIVE'));
    expect(getVerdicts()).toHaveLength(1);
    expect(deadProviders(NOW, 60_000)).toEqual([]);
  });
});

describe('assessLiveness — the family-width floor', () => {
  it('withholds exclusion when it would drop below the floor, even in enforce', () => {
    // Killing 3 of 4 independent families leaves 1 — under the floor of 3.
    const a = assessLiveness({
      chainProviders: CHAIN,
      dead: ['gemini', 'deepseek', 'mistral'],
      mode: 'enforce',
      minFamilies: DEFAULT_MIN_FAMILIES,
    });

    expect(a.excluded).toEqual([]);
    expect(a.withheldForFamilyFloor).toBe(true);
    expect(a.familiesAfter).toEqual(['llama']); // groq survives; openrouter is 'mixed'
    expect(a.reason).toMatch(/refusing to exclude/);
  });

  it('excludes when enough independent families survive', () => {
    const a = assessLiveness({
      chainProviders: CHAIN,
      dead: ['mistral'],
      mode: 'enforce',
      minFamilies: 3,
    });

    expect(a.excluded).toEqual(['mistral']);
    expect(a.withheldForFamilyFloor).toBe(false);
    expect(a.familiesAfter).toEqual(['deepseek', 'gemini', 'llama']);
  });

  it('does not count a reseller as an independent family', () => {
    // openrouter is family 'mixed' — it must not prop the count up.
    const a = assessLiveness({
      chainProviders: ['groq', 'openrouter'],
      dead: ['groq'],
      mode: 'enforce',
      minFamilies: 1,
    });

    expect(a.familiesAfter).toEqual([]);
    expect(a.withheldForFamilyFloor).toBe(true);
  });

  it('applies the same floor verdict in shadow as in enforce', () => {
    const args = { chainProviders: CHAIN, dead: ['gemini', 'deepseek', 'mistral'], minFamilies: 3 };
    const shadow = assessLiveness({ ...args, mode: 'shadow' });
    const enforce = assessLiveness({ ...args, mode: 'enforce' });

    // A shadow run that measured a different rule would measure nothing useful.
    expect(shadow.withheldForFamilyFloor).toBe(enforce.withheldForFamilyFloor);
    expect(shadow.deadCandidates).toEqual(enforce.deadCandidates);
    expect(shadow.familiesAfter).toEqual(enforce.familiesAfter);
  });
});

describe('assessLiveness — mode gating', () => {
  it('off computes the finding but excludes nothing', () => {
    const a = assessLiveness({ chainProviders: CHAIN, dead: ['mistral'], mode: 'off', minFamilies: 3 });
    expect(a.deadCandidates).toEqual(['mistral']);
    expect(a.excluded).toEqual([]);
  });

  it('shadow reports what it would do but excludes nothing', () => {
    const a = assessLiveness({ chainProviders: CHAIN, dead: ['mistral'], mode: 'shadow', minFamilies: 3 });
    expect(a.deadCandidates).toEqual(['mistral']);
    expect(a.excluded).toEqual([]);
    expect(a.reason).toMatch(/would exclude/);
  });

  it('ignores a dead provider that is not in this walk', () => {
    const a = assessLiveness({ chainProviders: ['groq'], dead: ['cohere'], mode: 'enforce', minFamilies: 0 });
    expect(a.deadCandidates).toEqual([]);
    expect(a.excluded).toEqual([]);
  });

  it('is case-insensitive about provider names', () => {
    const a = assessLiveness({ chainProviders: ['GROQ', 'Gemini'], dead: ['groq'], mode: 'enforce', minFamilies: 1 });
    expect(a.excluded).toEqual(['groq']);
  });
});

describe('livenessExcludedProviders — the router-facing entry point', () => {
  it('is inert when the env flag is unset', () => {
    recordVerdict(verdict('mistral', 'DEAD'));
    expect(livenessExcludedProviders(CHAIN, NOW)).toEqual([]);
  });

  it('is inert in shadow', () => {
    process.env[LIVENESS_MODE_ENV] = 'shadow';
    recordVerdict(verdict('mistral', 'DEAD'));
    expect(livenessExcludedProviders(CHAIN, NOW)).toEqual([]);
  });

  it('excludes in enforce', () => {
    process.env[LIVENESS_MODE_ENV] = 'enforce';
    recordVerdict(verdict('mistral', 'DEAD'));
    expect(livenessExcludedProviders(CHAIN, NOW)).toEqual(['mistral']);
  });
});

describe('refreshFleetLiveness', () => {
  const ENV = 'GROQ_API_KEY';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV];
    else process.env[ENV] = original;
  });

  it('records a verdict for a present key and never returns key material', async () => {
    process.env[ENV] = 'sk-not-a-real-key';
    const fake = jest.fn().mockResolvedValue({ status: 'DEAD', detail: 'HTTP 401 — credential rejected' });

    const out = await refreshFleetLiveness(() => NOW, fake as any);
    const groq = out.find((v) => v.provider === 'groq');

    expect(groq).toBeDefined();
    expect(groq!.status).toBe('DEAD');
    expect(JSON.stringify(out)).not.toContain('sk-not-a-real-key');
  });

  it('records NO verdict for an absent key — "not configured" is keylessProviders() job', async () => {
    delete process.env[ENV];
    const fake = jest.fn().mockResolvedValue({ status: 'LIVE', detail: 'HTTP 200' });

    const out = await refreshFleetLiveness(() => NOW, fake as any);

    expect(out.find((v) => v.provider === 'groq')).toBeUndefined();
    expect(fake).not.toHaveBeenCalledWith('groq', expect.anything());
  });
});

describe('reporting helpers', () => {
  it('names the withheld case distinctly so a shadow run can be counted', () => {
    const withheld = assessLiveness({ chainProviders: CHAIN, dead: ['gemini', 'deepseek', 'mistral'], mode: 'enforce', minFamilies: 3 });
    const would = assessLiveness({ chainProviders: CHAIN, dead: ['mistral'], mode: 'shadow', minFamilies: 3 });
    const did = assessLiveness({ chainProviders: CHAIN, dead: ['mistral'], mode: 'enforce', minFamilies: 3 });

    expect(livenessLogLine(withheld)).toContain('WITHHELD');
    expect(livenessLogLine(would)).toContain('WOULD-EXCLUDE');
    expect(livenessLogLine(did)).toContain('EXCLUDED');
    expect(livenessLogLine(did)).toContain('[provider-liveness]');
  });

  it('familyOf resolves real families and refuses resellers', () => {
    expect(familyOf('groq')).toBe('llama');
    expect(familyOf('gemini')).toBe('gemini');
    expect(familyOf('openrouter')).toBeNull();
    expect(familyOf('nope')).toBeNull();
  });
});
