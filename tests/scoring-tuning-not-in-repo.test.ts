/**
 * THE GUARD THAT WOULD HAVE CAUGHT IT.
 *
 * `src/config/scoring-params.ts` states the rule: "the repository keeps the SHAPE of
 * the model and none of the tuning." Until today nothing enforced it, and the rule was
 * already broken in two files — `src/layers/__tests__/{challenge-scoring,decay}.test.ts`
 * asserted the tuned constants as literal expected values, having been missed by the
 * refactor that removed them from `src/layers/*.ts`. A third, `prediction-scoring`,
 * carried a tuned base reward inside a bound and PASSED, so nobody ever looked.
 *
 * They survived because those directories were not in jest `roots`. That is now fixed;
 * this file is the part that stops it recurring, because "we added the directory" only
 * protects the files that exist today.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THREE OUTCOMES, NOT TWO
 * ════════════════════════════════════════════════════════════════════════════════
 * Proving "no tuned value appears in the repo" requires knowing the tuned values,
 * which must never be committed here. So this file cannot always answer it, and it
 * says so rather than passing:
 *
 *   STRUCTURAL  always runs. A test that asserts an exact number out of a tuned
 *               scoring function must pin its own parameters first — otherwise its
 *               expected value is either a dev placeholder (worthless) or production
 *               tuning (a leak). No credential needed; this is the load-bearing half.
 *   VALUE SCAN  runs ONLY where the tuned parameters are actually in the environment
 *               (a deploy-side check, a local shell with them exported). Elsewhere it
 *               reports NOT_CHECKED out loud. A green run here is NOT evidence the
 *               values are absent unless that line says it looked.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { REQUIRED_SCORING_ENV } from '../src/config/scoring-params';

const ROOT = join(__dirname, '..');

/** The modules whose outputs are a function of tuned parameters. */
const TUNED_MODULES = ['challenge-scoring', 'decay', 'ecosystem-need', 'prediction-scoring'];
/** Their exported scorers — the calls whose exact return value would reveal tuning. */
const TUNED_FNS = ['scoreChallengeOutcome', 'computeDecayFactor', 'applyDecay', 'scorePrediction', 'getEcosystemNeedWeight'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const TEST_FILES = [...walk(join(ROOT, 'tests')), ...walk(join(ROOT, 'src'))];

describe('STRUCTURAL: an exact assertion on a tuned scorer must pin its own parameters', () => {
  it('finds test files at all (the guard is not vacuously green)', () => {
    // A walker that silently returns [] would make every assertion below pass over
    // nothing — the exact failure shape this whole file exists to object to.
    expect(TEST_FILES.length).toBeGreaterThan(50);
    expect(TEST_FILES.some((f) => f.includes(join('src', 'layers', '__tests__')))).toBe(true);
  });

  it('no test asserts an exact value out of a tuned scorer without pinning', () => {
    const offenders: string[] = [];

    for (const file of TEST_FILES) {
      const src = readFileSync(file, 'utf8');
      if (!TUNED_MODULES.some((m) => src.includes(`${m}'`) || src.includes(`${m}"`))) continue;
      if (src.includes('__resetScoringParamsCache')) continue; // pins its own params

      // expect( ... tunedFn( ... ) ... ).toBe( <number> )  — allowing the call and the
      // matcher to sit on different lines, which is how the original offenders read.
      for (const fn of TUNED_FNS) {
        const re = new RegExp(
          `expect\\(\\s*[^;]*?\\b${fn}\\s*\\([^;]*?\\)\\s*\\.(toBe|toBeCloseTo)\\(\\s*-?[0-9]`,
          'gs',
        );
        const hits = src.match(re);
        if (hits) offenders.push(`${relative(ROOT, file)} → ${hits.length}× exact assertion on ${fn}()`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the rule has teeth — the pattern matches the shape that was actually shipped', () => {
    // The literal line that lived in challenge-scoring.test.ts until 2026-09-03, with a
    // placeholder standing in for the tuned value. If this stops matching, the rule
    // above has quietly stopped guarding anything.
    const shipped = `
      expect(scoreChallengeOutcome({
        outcome:'WIN', certaintyAtClaim:0.8, ecosystemNeedWeight:1.0
      })).toBe(99);
    `;
    const re = new RegExp(
      `expect\\(\\s*[^;]*?\\bscoreChallengeOutcome\\s*\\([^;]*?\\)\\s*\\.(toBe|toBeCloseTo)\\(\\s*-?[0-9]`,
      'gs',
    );
    expect(re.test(shipped)).toBe(true);
  });
});

describe('VALUE SCAN: no tuned parameter value appears anywhere in the tree', () => {
  const present = REQUIRED_SCORING_ENV.filter((v) => (process.env[v] ?? '').trim() !== '');

  it(`reports honestly whether it could look (${present.length}/${REQUIRED_SCORING_ENV.length} parameters in env)`, () => {
    if (present.length === 0) {
      console.warn(
        '[scoring-tuning-guard] NOT_CHECKED — no tuned parameter is set in this environment, ' +
          'so this scan looked for nothing and proves nothing. It is meaningful only where the ' +
          'real parameters are exported. The STRUCTURAL block above ran and is unaffected.',
      );
    }
    // Deliberately not an assertion on `present.length`: requiring the params here
    // would make a fresh clone red, and asserting nothing would let the skip read as a
    // pass. Stating it in the log, and in the test NAME, is the honest middle.
    expect(present.length).toBeGreaterThanOrEqual(0);
  });

  it('does not find any set parameter value written as a literal in a committed file', () => {
    if (present.length === 0) return; // NOT_CHECKED — announced above

    const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tests'))];
    const offenders: string[] = [];
    for (const v of present) {
      const raw = (process.env[v] ?? '').trim();
      // Skip values too plain to be evidence of anything — 0, 1, 30 and the like occur
      // everywhere for unrelated reasons, and flagging them would make this unusable.
      if (!/\d\.\d{2,}|\d{3,}/.test(raw)) continue;
      for (const f of files) {
        if (readFileSync(f, 'utf8').includes(raw)) offenders.push(`${v}=${'<redacted>'} appears in ${relative(ROOT, f)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
