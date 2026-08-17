/**
 * zkrepid-witness-exclusion.test.ts — proves the public surface rejects witness fields AT COMPILE
 * TIME, by running the real compiler and reading its output.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SUBPROCESS AND NOT `@ts-expect-error`
 * ════════════════════════════════════════════════════════════════════════════════
 * MEASURED 2026-08-17, both halves:
 *   1. `jest.config.js` uses the stock `ts-jest` preset with no `diagnostics` option. A bogus
 *      `@ts-expect-error` placed on an error-free line left this suite GREEN at 43/43 — so type
 *      errors in test files are not enforced at test time.
 *   2. `tsconfig.json` has `include: ["src/**\/*"]` and `exclude: ["tests", ...]`, so `npm run
 *      build` and a bare `tsc --noEmit` never look at `tests/` either.
 *
 * Both roads that would normally carry a compile-time assertion are therefore inert here. Writing
 * `@ts-expect-error` anyway would have produced a test that cannot fail while appearing to guard
 * the single most important property of this module (LESSONS §6, and the fake-pass class in
 * CLAUDE.md RULE-4). Invoking `tsc` and asserting on its diagnostics is the version that goes red.
 *
 * THE CHECK IS TWO-SIDED, deliberately:
 *   - every `@EXPECT_TS_ERROR` line MUST produce an error → catches the guard being WEAKENED.
 *   - the control line and every other line MUST NOT → catches the guard being made so broad it
 *     rejects legitimate surfaces, which would be "passing" for the wrong reason.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_REL = 'tests/fixtures/witness-exclusion.fixture.ts';
const FIXTURE_ABS = join(__dirname, 'fixtures', 'witness-exclusion.fixture.ts');
const REPO_ROOT = join(__dirname, '..');

/** Lines tagged `@EXPECT_TS_ERROR` — the marker sits on the line BEFORE the offending statement. */
function expectedErrorLines(): Map<number, string> {
  const src = readFileSync(FIXTURE_ABS, 'utf8').split('\n');
  const out = new Map<number, string>();
  src.forEach((line, i) => {
    const m = line.match(/@EXPECT_TS_ERROR\s+(\S+)/);
    // The marker is a comment; the statement it describes is the next line. `i` is 0-based, so
    // `i + 2` is the 1-based line number of that statement.
    if (m && m[1]) out.set(i + 2, m[1]);
  });
  return out;
}

interface Diag {
  line: number;
  code: string;
  text: string;
}

/**
 * Compile the fixture alone, with the project's strictness, and return its diagnostics.
 *
 * `tsc` exits non-zero when it reports errors, which is the EXPECTED outcome here — so a non-zero
 * status is not itself a failure and `execFileSync`'s throw is caught and its stdout read.
 */
function compileFixture(): Diag[] {
  let raw = '';
  try {
    // `-p` with a dedicated project, NOT a file argument: `tsc` rejects command-line files when a
    // tsconfig.json exists (TS5112). That project mirrors the root tsconfig's strictness.
    raw = execFileSync(
      'npx',
      ['tsc', '-p', 'tests/fixtures/tsconfig.witness-exclusion.json', '--pretty', 'false'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    raw = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }

  const diags: Diag[] = [];
  for (const line of raw.split('\n')) {
    // e.g. tests/fixtures/witness-exclusion.fixture.ts(52,44): error TS2353: Object literal ...
    const m = line.match(/witness-exclusion\.fixture\.ts\((\d+),\d+\):\s+error\s+(TS\d+):\s*(.*)$/);
    if (m && m[1] && m[2]) diags.push({ line: Number(m[1]), code: m[2], text: m[3] ?? '' });
  }
  return diags;
}

// One compile, shared. `tsc` cold-starts slowly and this suite would otherwise pay it per test.
let diags: Diag[];
let expected: Map<number, string>;

beforeAll(() => {
  expected = expectedErrorLines();
  diags = compileFixture();
}, 120_000);

describe('the witness cannot reach the public surface — enforced by the compiler', () => {
  it('the fixture actually declares cases to check', () => {
    // Guards the guard: if the markers were renamed or the fixture emptied, every assertion below
    // would vacuously pass over an empty set.
    expect(expected.size).toBeGreaterThanOrEqual(7);
  });

  it('the compiler actually ran and produced parseable diagnostics', () => {
    // Distinguishes REAL from ENV (LESSONS §7): zero diagnostics could mean the guard is perfect
    // or that `npx tsc` never executed. The fixture is designed to fail, so silence is suspicious.
    expect(diags.length).toBeGreaterThan(0);
  });

  it.each([...expectedErrorLines()].map(([line, label]) => [label, line] as const))(
    'rejects `%s` (fixture line %i)',
    (label, line) => {
      // The asserted VALUE carries the diagnosis, because this jest version does not accept a
      // message argument on `expect`. On failure the report reads
      // `'repid_score@52: NO COMPILE ERROR ...'` rather than `0 is not > 0`.
      const hit = diags.filter((d) => d.line === line);
      const verdict =
        hit.length > 0
          ? `${label}@${line}: rejected (${hit.map((d) => d.code).join(',')})`
          : `${label}@${line}: NO COMPILE ERROR — ForbiddenWitnessFields has been weakened, and ` +
            `the public surface would now accept this witness-bearing field`;
      expect(verdict).toBe(`${label}@${line}: rejected (${hit.map((d) => d.code).join(',')})`);
      expect(hit.length).toBeGreaterThan(0);
    },
  );

  it('does NOT reject a legitimate public surface', () => {
    // The control. A guard that rejects everything is not a guard; it is a broken module that
    // happens to pass every negative test.
    const unexpected = diags
      .filter((d) => !expected.has(d.line))
      .map((d) => `${FIXTURE_REL}:${d.line} ${d.code}: ${d.text}`);
    expect(unexpected).toEqual([]);
  });
});
