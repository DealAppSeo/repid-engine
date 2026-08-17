/**
 * dispatch-scoped-lessons.test.ts — gates the scoped-lesson layer in
 * `scripts/dispatch/run-agent.mjs`.
 *
 * WHY THIS FILE EXISTS. The layer can fail three ways and only one is loud:
 *
 *   1. recall dies               → the dispatch must still ship LESSONS.md
 *   2. nothing is ever written   → the read path retrieves an empty set forever
 *   3. the block grows unbounded → it crowds out the shared rules above it
 *
 * (2) is the one that matters. A retrieval layer with no writer looks perfectly
 * healthy — the API answers, the block is simply empty — and that is lesson 3,
 * a mechanism wired at one end. So `extractLessons` is tested hardest here: it
 * is the writer, and the realistic way it breaks is matching nothing silently
 * because agents decorate the marker (`- LESSON:`, `> LESSON:`) and a strict
 * line-start matcher harvests zero without ever erroring.
 *
 * HOW IT RUNS. The dispatcher is ESM and jest's VM sandbox refuses a dynamic
 * `import()` without `--experimental-vm-modules`, so each case runs in a real
 * Node process — the same idiom as `dispatch-runner-seams.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const RUNNER = path.resolve(__dirname, '../scripts/dispatch/run-agent.mjs').replace(/\\/g, '/');

function call(fnBody: string): any {
  const src = `
    import * as api from '${RUNNER}';
    const out = (${fnBody})(api);
    process.stdout.write(JSON.stringify(out ?? null));`;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', src], {
      encoding: 'utf8',
      env: { ...process.env },
    }),
  );
}

const scopeOf = (task: unknown) =>
  call(`({scopeForTask}) => scopeForTask(${JSON.stringify(task)})`);
const blockFor = (scope: string, results: unknown) =>
  call(`({scopedLessonBlock}) => scopedLessonBlock(${JSON.stringify(scope)}, ${JSON.stringify(results)})`);
const lessonsIn = (output: unknown) =>
  call(`({extractLessons}) => extractLessons(${JSON.stringify(output)})`);

describe('scopeForTask', () => {
  it('routes subsystem work to its own scope', () => {
    expect(scopeOf('wire the plonky3 circuit for the ZKP drain')).toBe('zkp');
    expect(scopeOf('retune the ANFIS fuzzy membership functions')).toBe('anfis');
    expect(scopeOf('HAL is hallucinating on the substance gate')).toBe('hal');
    expect(scopeOf('fix the tier trigger on repid score events')).toBe('repid-engine');
  });

  it('falls back to global rather than guessing', () => {
    expect(scopeOf('tidy up the README')).toBe('global');
    expect(scopeOf('')).toBe('global');
    expect(scopeOf(null)).toBe('global');
  });

  it('only ever returns a scope the API will accept', () => {
    const scopes = call('({LESSON_SCOPES}) => LESSON_SCOPES');
    for (const t of ['zkp thing', 'anfis thing', 'hal thing', 'repid thing', 'nothing', '']) {
      expect(scopes).toContain(scopeOf(t));
    }
  });
});

describe('scopedLessonBlock', () => {
  it('contributes NOTHING when recall failed — the fail-open guarantee', () => {
    // null is the failure signal from fetchScopedLessons. If this ever returned
    // a non-empty array, a dead recall API would start editing the preamble.
    expect(blockFor('global', null)).toEqual([]);
    expect(blockFor('global', [])).toEqual([]);
  });

  it('renders retrieved lessons with their similarity', () => {
    const text = blockFor('zkp', [
      { similarity: 0.82, content: 'The drain worker needs its own attestor key.' },
    ]).join('\n');
    expect(text).toContain('scope: zkp');
    expect(text).toContain('The drain worker needs its own attestor key.');
    expect(text).toContain('0.82');
  });

  it('caps total size so it cannot crowd out the shared lessons above it', () => {
    const cap = call('({SCOPED_CONTEXT_MAX}) => SCOPED_CONTEXT_MAX');
    const huge = Array.from({ length: 50 }, (_, i) => ({
      similarity: 0.9,
      content: `lesson ${i} ` + 'x'.repeat(500),
    }));
    const text = blockFor('global', huge).join('\n');
    expect(text.length).toBeLessThan(cap + 600);
  });

  it('skips empty content instead of emitting blank bullets', () => {
    expect(blockFor('hal', [
      { similarity: 0.7, content: '   ' },
      { similarity: 0.7, content: '' },
    ])).toEqual([]);
  });
});

describe('extractLessons — the writer, and the half that was missing', () => {
  it('pulls a LESSON: block out of a report', () => {
    const out = [
      'I ran the suite and it passed.',
      '',
      'LESSON: a green suite says nothing about the six __tests__ dirs jest never roots.',
      '',
    ].join('\n');
    expect(lessonsIn(out)).toEqual([
      'a green suite says nothing about the six __tests__ dirs jest never roots.',
    ]);
  });

  it('finds lessons behind markdown decoration', () => {
    // The realistic silent failure: agents write "- LESSON:" / "> LESSON:", and
    // a bare-line-start matcher harvests nothing while erroring never.
    const found = lessonsIn([
      '- LESSON: committed is not landed is not deployed, check the content.',
      '',
      '> LESSON: an exact-match list fails open for every value added later.',
      '',
    ].join('\n'));
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('committed is not landed');
    expect(found[1]).toContain('fails open');
  });

  it('is case-insensitive and collapses a wrapped lesson into one entry', () => {
    const found = lessonsIn(
      'lesson: the survivor alert fired correctly\nfor thirty days into a table nobody reads.\n\n',
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(
      'the survivor alert fired correctly for thirty days into a table nobody reads.',
    );
  });

  it('drops stubs too short to be a lesson', () => {
    expect(lessonsIn('LESSON: none\n\n')).toEqual([]);
    expect(lessonsIn('LESSON:\n\n')).toEqual([]);
  });

  it('returns [] on lesson-free output and never throws on junk input', () => {
    expect(lessonsIn('a normal report with no lesson block')).toEqual([]);
    expect(lessonsIn('')).toEqual([]);
    expect(lessonsIn(null)).toEqual([]);
  });

  it('truncates a runaway lesson rather than posting it whole', () => {
    const found = lessonsIn(`LESSON: ${'y'.repeat(9000)}\n\n`);
    expect(found).toHaveLength(1);
    expect(found[0].length).toBeLessThanOrEqual(4000);
  });
});
