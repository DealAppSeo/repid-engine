/**
 * HAL production quorum width.
 *
 * `golden-math.test.ts` already refuses to report a quality number when the fleet
 * answers on fewer families than the frozen claim was measured at — for the TEST.
 * Production records the same information (`hal_classifications.model` carries
 * `fact-check-quorum:llama+glm+gemini+…`) and nothing ever read it back.
 *
 * Observed live 2026-08-04 over the prior week: 5 families on 08-02, 4 on 08-01, 3 on
 * 08-03 (gemini absent) and 3 on 08-04 (glm absent). The width fell from 5 to 3, the
 * membership churned, and no surface said anything.
 *
 * These tests pin the reading, and above all the two refusals: an unrecorded family
 * list is UNKNOWN rather than assumed, and only a run at the declared width may be
 * compared to a frozen claim.
 */

import {
  DECLARED_QUORUM_WIDTH,
  MINIMUM_MEANINGFUL_WIDTH,
  formatWidth,
  missingFamilies,
  readQuorumWidth,
  summariseWidth,
} from '../src/hal/quorum-width-monitor';

const q = (fams: string) => `fact-check-quorum:${fams}`;

describe('reading the width out of the live label', () => {
  it('reads the real 5-family label observed on 2026-08-02', () => {
    const r = readQuorumWidth(q('llama+glm+gemini+mistral+qwen'));
    expect(r.width).toBe(5);
    expect(r.verdict).toBe('AT_DECLARED_WIDTH');
    expect(r.comparableToFrozenClaims).toBe(true);
  });

  it('THE LIVE DEGRADATION: the 3-family label observed on 2026-08-04', () => {
    const r = readQuorumWidth(q('llama+gemini+mistral'));
    expect(r.width).toBe(3);
    expect(r.verdict).toBe('DEGRADED');
    expect(r.comparableToFrozenClaims).toBe(false);
    expect(r.reason).toMatch(/DIFFERENT\s+configuration/);
  });

  it('names which declared families were absent, not just how many', () => {
    const declared = ['llama', 'glm', 'gemini', 'mistral', 'qwen'];
    expect(missingFamilies(readQuorumWidth(q('llama+gemini+mistral')), declared)).toEqual(['glm', 'qwen']);
    expect(missingFamilies(readQuorumWidth(q('llama+glm+mistral')), declared)).toEqual(['gemini', 'qwen']);
  });

  it('is case-insensitive and tolerates spacing', () => {
    expect(readQuorumWidth(q(' Llama + GLM + Gemini ')).families).toEqual(['llama', 'glm', 'gemini']);
  });
});

describe('the two refusals', () => {
  it('REFUSAL 1: a quorum with no recorded family list is UNREADABLE, never assumed', () => {
    // The bare `fact-check-quorum` label means a quorum was met and the list was lost.
    // Calling that 0 would invent a failure; calling it the declared width would invent
    // a success. Both are inventing a measurement.
    const r = readQuorumWidth('fact-check-quorum');
    expect(r.verdict).toBe('UNREADABLE');
    expect(r.width).toBeNull();
    expect(r.comparableToFrozenClaims).toBe(false);
    expect(r.reason).toMatch(/not zero, and not the declared width/);
  });

  it('REFUSAL 2: only the declared width is comparable to a frozen claim', () => {
    for (let w = MINIMUM_MEANINGFUL_WIDTH; w < DECLARED_QUORUM_WIDTH; w++) {
      const fams = Array.from({ length: w }, (_, i) => `fam${i}`).join('+');
      expect(readQuorumWidth(q(fams)).comparableToFrozenClaims).toBe(false);
    }
    const full = Array.from({ length: DECLARED_QUORUM_WIDTH }, (_, i) => `fam${i}`).join('+');
    expect(readQuorumWidth(q(full)).comparableToFrozenClaims).toBe(true);
  });
});

describe('what is not a quorum', () => {
  it('one family is a second opinion, not cross-examination', () => {
    const r = readQuorumWidth(q('llama'));
    expect(r.verdict).toBe('NOT_A_QUORUM');
    expect(r.reason).toMatch(/second opinion/);
  });

  it('DUPLICATES ARE NOT INDEPENDENCE — two routes to one family is one family', () => {
    // Counting the transport would overstate exactly the property being claimed.
    const r = readQuorumWidth(q('llama+llama+llama'));
    expect(r.width).toBe(1);
    expect(r.verdict).toBe('NOT_A_QUORUM');
  });

  it.each(['deterministic-extractor', 'extractor-fallback', 'fact-check-partial', 'hal-error-fallback'])(
    '%s is NO_QUORUM_PATH, not a width failure',
    (label) => {
      const r = readQuorumWidth(label);
      expect(r.verdict).toBe('NO_QUORUM_PATH');
      expect(r.comparableToFrozenClaims).toBe(false);
    },
  );

  it('an empty or null label does not crash and claims nothing', () => {
    for (const l of [null, undefined, '', '   ']) {
      const r = readQuorumWidth(l);
      expect(r.comparableToFrozenClaims).toBe(false);
      expect(r.width).toBeNull();
    }
  });

  it('an empty family list after the colon is unreadable, not zero-width', () => {
    expect(readQuorumWidth('fact-check-quorum:').verdict).toBe('UNREADABLE');
  });
});

describe('the declared width is a constant, not a high-water mark', () => {
  it('a run WIDER than declared is still comparable', () => {
    // Extra corroboration does not invalidate a claim; it exceeds it.
    expect(readQuorumWidth(q('a+b+c+d+e+f')).comparableToFrozenClaims).toBe(true);
  });

  it('the declared width does not move when a wider run appears', () => {
    // A high-water baseline redefines itself upward on a lucky run and makes
    // degradation invisible by construction — the ratchet running the wrong way.
    summariseWidth([{ label: q('a+b+c+d+e+f+g') }]);
    expect(readQuorumWidth(q('a+b+c')).verdict).toBe('DEGRADED');
  });
});

describe('the weekly summary reproduces what was actually observed', () => {
  const week = [
    { label: q('llama+glm+gemini+mistral+qwen'), at: '2026-08-02' },
    { label: q('llama+glm+gemini+mistral'), at: '2026-08-01' },
    { label: q('llama+glm+mistral'), at: '2026-08-03' },
    { label: q('llama+gemini+mistral'), at: '2026-08-04' },
  ];

  it('counts one comparable run and three narrower ones', () => {
    const s = summariseWidth(week);
    expect(s.comparable).toBe(1);
    expect(s.byVerdict.DEGRADED).toBe(3);
    expect(s.narrowest).toBe(3);
    expect(s.widest).toBe(5);
  });

  it('reports the union of families seen, which exposes the churn', () => {
    expect(summariseWidth(week).familiesSeen).toEqual(['gemini', 'glm', 'llama', 'mistral', 'qwen']);
  });

  it('says the fleet is losing families intermittently', () => {
    expect(summariseWidth(week).headline).toMatch(/losing families intermittently/);
  });

  it('when NOTHING reaches the declared width it says so unmistakably', () => {
    const s = summariseWidth([{ label: q('llama+mistral') }, { label: q('llama+gemini+mistral') }]);
    expect(s.comparable).toBe(0);
    expect(s.headline).toMatch(/must not be compared to them/);
  });

  it('an empty window is not health', () => {
    // Zero runs and zero problems look identical in a count and mean opposite things.
    expect(summariseWidth([]).headline).toMatch(/absence is not health/);
  });

  it('the rendered block marks which rows are comparable', () => {
    expect(formatWidth(summariseWidth(week))).toMatch(/only these are comparable/);
  });
});

describe('it reports width, never quality, and cannot write', () => {
  it('has no db import, no write verb, and no accuracy vocabulary', () => {
    // Keeping width and accuracy separable is the whole point: a provider outage must
    // never read as a scoring problem, and a scoring problem must never hide behind one.
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'hal', 'quorum-width-monitor.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"]\.\.\/db['"]/);
    expect(src).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
    expect(src).not.toMatch(/\bf1\b|precision\s*=|recall\s*=/i);
  });
});
