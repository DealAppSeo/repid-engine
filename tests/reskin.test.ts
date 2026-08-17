/**
 * Re-skin transforms — the tests that make the probe trustworthy.
 *
 * The whole value of re-skin invariance is that the null hypothesis is airtight: these
 * transformations CANNOT change whether a claim is true, so any movement in HAL's output is
 * attributable to the instrument rather than to the input. That argument only holds if the
 * transforms really are what they claim to be, so this file checks the claim rather than trusting
 * the docstring.
 *
 * The load-bearing test is MARKER NEUTRALITY. HAL deliberately measures style — overconfidence
 * markers, hedges — as a proxy for hallucination risk, so a transform that added or removed one
 * would produce movement that is a correct measurement rather than a defect, and the finding would
 * be worthless. That test is what caught `'100%'` being a literal OVERCONFIDENCE_MARKER, which
 * `percent-to-word` would otherwise have deleted.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  RESKIN_TRANSFORMS,
  RESKIN_TRANSFORM_SET_VERSION,
  applyReskin,
  transformById,
} from '../src/hal/reskin';
import {
  EPISTEMIC_HEDGES,
  OVERCONFIDENCE_MARKERS,
  INJECTION_MARKERS,
} from '../src/hal/lib/constants';

const CORPUS = path.join(__dirname, '../eval/canary/canary-corpus-v1.1.jsonl');

const CLAIMS: string[] = fs
  .readFileSync(CORPUS, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l).claim as string)
  .filter((c) => typeof c === 'string' && c.trim() !== '');

/** The marker sets HAL reads, matched the way HAL matches them: lowercase substring. */
function markerFingerprint(text: string): string {
  const lower = text.toLowerCase();
  const hit = (list: readonly string[]) => list.filter((m) => lower.includes(m)).sort().join('|');
  return [hit(OVERCONFIDENCE_MARKERS), hit(EPISTEMIC_HEDGES), hit(INJECTION_MARKERS)].join('##');
}

describe('the corpus loaded', () => {
  it('has claims to transform', () => {
    expect(CLAIMS.length).toBeGreaterThan(20);
  });
});

describe('transform hygiene', () => {
  it('every transform carries a justification and a probe target', () => {
    for (const t of RESKIN_TRANSFORMS) {
      expect(t.id.trim()).not.toBe('');
      expect(t.justification.trim().length).toBeGreaterThan(20);
      expect(t.probes.trim()).not.toBe('');
    }
  });

  it('transform ids are unique and findable', () => {
    const ids = RESKIN_TRANSFORMS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(transformById(id)?.id).toBe(id);
  });

  it('every transform is deterministic', () => {
    for (const t of RESKIN_TRANSFORMS) {
      for (const claim of CLAIMS) {
        expect(t.apply(claim)).toBe(t.apply(claim));
      }
    }
  });

  it('has a version string, because results under different sets are not comparable', () => {
    expect(RESKIN_TRANSFORM_SET_VERSION).toMatch(/^reskin-v\d+$/);
  });
});

describe('MARKER NEUTRALITY — the property the whole probe rests on', () => {
  it('no transform adds or removes an overconfidence marker, hedge, or injection marker', () => {
    const violations: string[] = [];
    for (const t of RESKIN_TRANSFORMS) {
      for (const claim of CLAIMS) {
        const before = markerFingerprint(claim);
        const after = markerFingerprint(t.apply(claim));
        if (before !== after) {
          violations.push(`[${t.id}] "${claim}"\n    before=${before}\n    after =${after}`);
        }
      }
    }
    // A violation here would mean the transform changed a stylistic property HAL claims to measure,
    // so movement under it would be a correct measurement rather than a finding.
    expect(violations).toEqual([]);
  });

  it('specifically leaves "100%" alone, since that string IS an overconfidence marker', () => {
    const percent = transformById('percent-to-word');
    expect(percent).toBeDefined();
    const claim = 'The treatment is 100% effective in all recorded cases.';
    expect(percent?.apply(claim)).toBe(claim);
    expect(markerFingerprint(claim)).toContain('100%');
  });

  it('still converts an ordinary percentage', () => {
    expect(transformById('percent-to-word')?.apply('Yields rose 5% last year.')).toBe(
      'Yields rose 5 percent last year.',
    );
  });
});

describe('the negative control', () => {
  it('identity changes nothing, on every claim', () => {
    const identity = transformById('identity');
    expect(identity).toBeDefined();
    for (const claim of CLAIMS) {
      const app = applyReskin(identity!, claim);
      expect(app.reskinned).toBe(claim);
      expect(app.changed).toBe(false);
    }
  });
});

describe('individual transforms do what they say', () => {
  it('terminal-period toggles the final stop', () => {
    const t = transformById('terminal-period')!;
    expect(t.apply('X is true.')).toBe('X is true');
    expect(t.apply('X is true')).toBe('X is true.');
  });

  it('digit-grouping strips thousands separators but not other commas', () => {
    const t = transformById('digit-grouping')!;
    expect(t.apply('It weighs 1,000 kilograms.')).toBe('It weighs 1000 kilograms.');
    // A comma that is not a thousands separator must survive, or the transform changes the sentence.
    expect(t.apply('Rome, Italy is a city.')).toBe('Rome, Italy is a city.');
  });

  it('initial-lowercase touches only the first character', () => {
    const t = transformById('initial-lowercase')!;
    expect(t.apply('The Empire State Building is tall.')).toBe('the Empire State Building is tall.');
  });

  it('full-lowercase lowercases everything', () => {
    expect(transformById('full-lowercase')!.apply('The Great Wall')).toBe('the great wall');
  });

  it('contentless-prefix adds exactly five words and asserts nothing new', () => {
    const t = transformById('contentless-prefix')!;
    const claim = 'The sky is blue.';
    const out = t.apply(claim);
    expect(out).toBe('It is the case that the sky is blue.');
    expect(out.split(/\s+/).length - claim.split(/\s+/).length).toBe(5);
  });

  it('contentless-prefix is exactly initial-lowercase plus the padding — the factorial the harness reads', () => {
    // The harness subtracts initial-lowercase's drift from contentless-prefix's to isolate the
    // length term. That subtraction is only valid if this composition holds exactly.
    const prefix = transformById('contentless-prefix')!;
    const initial = transformById('initial-lowercase')!;
    for (const claim of CLAIMS) {
      expect(prefix.apply(claim)).toBe(`It is the case that ${initial.apply(claim)}`);
    }
  });
});
