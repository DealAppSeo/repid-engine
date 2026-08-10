/**
 * lessons-injectable.test.ts — keeps LESSONS.md a thing agents actually read.
 *
 * THE PROBLEM THIS GUARDS. This repo contains 116 dated report files, and
 * `CLAUDE.md` referenced none of them. `reports/2026-07-31/SCHOOL_OF_HARD_KNOCKS`
 * records "unverified inference — again, THIRD occurrence"; the same class then
 * recurred twice more on 2026-08-05. Writing a lesson down demonstrably does not
 * prevent its recurrence — the lesson has to be put in front of the worker.
 *
 * So LESSONS.md is INJECTED into every dispatch preamble rather than filed. That
 * only stays true if it stays small: a file that grows without bound becomes too
 * expensive to inject, gets dropped from the preamble, and quietly becomes the
 * 117th report nobody reads. The size cap is not tidiness — it is what keeps the
 * mechanism alive, and it forces new lessons to REPLACE or GENERALISE old ones
 * rather than accumulate.
 *
 * XC and GA cannot read living-docs, `~/.claude` memory, or claude-mem. The
 * dispatch preamble is the only channel that reaches them, which is why the
 * shared file lives in git — where a disagreement surfaces as a merge conflict
 * instead of two silently diverging copies.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const LESSONS = join(ROOT, 'LESSONS.md');
const RUNNER = join(ROOT, 'scripts', 'dispatch', 'run-agent.mjs');
const MAX = 6000;

describe('LESSONS.md stays injectable', () => {
  it('exists at the repo root where every reader can find it', () => {
    expect(existsSync(LESSONS)).toBe(true);
  });

  it(`is under the ${MAX}-char cap — over it, the mechanism dies quietly`, () => {
    const size = readFileSync(LESSONS, 'utf8').length;
    // If this fails, CONSOLIDATE. Do not raise the cap: raising it is the first
    // step of the exact decay this file exists to prevent, and the second step is
    // someone deciding the preamble is too long and dropping the injection.
    expect(size).toBeLessThanOrEqual(MAX);
  });

  it('every lesson carries a proof, not just an assertion', () => {
    const text = readFileSync(LESSONS, 'utf8');
    const lessons = text.split(/^## \d+\. /m).slice(1);
    expect(lessons.length).toBeGreaterThanOrEqual(8);
    // A rule with no incident behind it is someone's preference, and preferences
    // are what make a rules file long enough to stop being read.
    const withoutProof = lessons.filter((l) => !/\*Proof:\*|`event_type`|Classify \*\*ENV/.test(l));
    expect(withoutProof).toEqual([]);
  });

  it('states the cap inside itself, so an editor meets it before appending', () => {
    expect(readFileSync(LESSONS, 'utf8')).toMatch(new RegExp(`${MAX}`));
  });
});

describe('the dispatcher actually injects it', () => {
  const src = readFileSync(RUNNER, 'utf8');

  it('reads LESSONS.md and puts it in the preamble', () => {
    // The whole point. A shared lessons file nothing injects is the 117th report.
    expect(src).toMatch(/LESSONS_PATH/);
    expect(src).toMatch(/SHARED LESSONS/);
    const readAt = src.indexOf('LESSONS_PATH');
    const preambleAt = src.indexOf('const preamble = [');
    expect(readAt).toBeLessThan(preambleAt);
  });

  it('reports a missing or oversized file LOUDLY instead of skipping it', () => {
    // Silently dropping the rules would be this file's own lesson #4 — fail loud —
    // turned on itself.
    expect(src).toMatch(/MISSING — dispatching without shared lessons/);
    expect(src).toMatch(/over the \$\{LESSONS_MAX\} cap/);
  });

  it('tells the agent to REPORT a new lesson, not to edit shared state', () => {
    expect(src).toMatch(/LESSON:/);
    expect(src).toMatch(/Do not[\s\S]{0,40}edit LESSONS\.md yourself/);
  });
});

describe('a key rename cannot silently un-dispatch an agent', () => {
  const src = readFileSync(RUNNER, 'utf8');

  it('accepts multiple key names per agent', () => {
    // FOUND LIVE 2026-08-05: .env.master was canonicalised to XAI_API_KEY (#398)
    // while this runner hardcoded GROK_API_KEY. XC became undispatchable, and the
    // failure reads like "the agent had nothing to say" — the same silent shape as
    // the renamed SUPABASE_SECRET_KEY that crash-looped zkp-postcard for days.
    expect(src).toMatch(/keyVars: \['XAI_API_KEY', 'GROK_API_KEY'\]/);
    expect(src).not.toMatch(/keyVar:\s*'/);
  });

  it('names every key it looked for when none resolve', () => {
    expect(src).toMatch(/none of \[\$\{agent\.keyVars\.join/);
    expect(src).toMatch(/A key RENAME is the usual cause/);
  });

  it('says so when it falls back to a non-preferred name', () => {
    // A fallback that works silently hides the rename until the fallback also goes.
    expect(src).toMatch(/authenticating via fallback/);
  });
});
