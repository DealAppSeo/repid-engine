/**
 * No HAL call path may DEFAULT to a model its vendor has switched off (2026-08-25).
 *
 * MEASURED, in production, not hypothesised. A keyless evaluate returned:
 *
 *   provider_health: { attempted: 5, succeeded: 3, failed: [
 *     { name: 'groq',     error: 'HTTP 404: The model `llama-3.1-8b-instant` does not exist
 *                                  or you do not have access to it' },
 *     { name: 'cerebras', error: 'HTTP 404: Model zai-glm-4.7 is archived and unavailable' } ] }
 *
 * Neither was an outage. Groq SHUT DOWN llama-3.1-8b-instant on 2026-08-16 (announced
 * 2026-06-17, alongside llama-3.3-70b-versatile) and Cerebras deprecated zai-glm-4.7 on
 * 2026-08-17. Two scheduled vendor deprecations a day apart.
 *
 * WHY A TEST AND NOT JUST THE FIX. The repo already KNEW: src/providers/groq.ts documents the
 * shutdown date, src/providers/cost-class.ts had already migrated to openai/gpt-oss-20b, and
 * src/routes/hal-stats.ts names both failures. The knowledge existed in four files while the
 * live quorum kept calling the dead models anyway, because nothing connected knowing to the
 * call path. That is the recurring defect here — a fact recorded where the worker never reads
 * it — and a test is the one form of record the build refuses to ignore.
 *
 * WHAT THIS DOES AND DOES NOT CATCH. It cannot know about a FUTURE deprecation; nothing static
 * can. It pins the ones we have paid for, so a revert, a bad merge, or a copied-from-an-old-file
 * default cannot quietly resurrect them. The live check is provider_health after deploy.
 *
 * SCOPE. Live call paths only. Historical records are deliberately NOT covered:
 * src/decisioning/family-registry.ts holds observations of past runs with evidence counts, and
 * src/billing/pricing.ts must keep price rows for models we already spent money on. Rewriting
 * either to "fix" a grep would be falsifying history to satisfy a linter.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RETIRED_MODELS } from '../src/hal/retired-models';

/**
 * THE LIST MOVED INTO src/ (2026-08-28) — it is no longer duplicated here.
 *
 * It used to be a test-only constant, which meant this guard could refuse a dead DEFAULT while
 * the runtime happily dialled a dead OVERRIDE, and production did exactly that: it pinned
 * HAL_S2_CEREBRAS_MODEL to an archived id and 404'd on every fact-check while this file was
 * green. That is the same "knowledge exists where the worker never reads it" defect described
 * in the header, one level up — so the fix is the same one: connect the knowing to the call
 * path. `src/hal/retired-models.ts` is now read by BOTH this guard and the quorum builder, so
 * adding an id bans it as a default and makes the quorum skip it in one edit.
 */

/**
 * Directories whose defaults reach a real provider call. `src/hal` is where the measured
 * failure lived; the others are named individually rather than scanning all of src/ so that
 * the historical-record files above are excluded by construction rather than by exception.
 */
const LIVE_DIRS = ['src/hal'];

/**
 * Files under a live dir that are RECORDS, not call paths.
 *
 * `checkpoint-registry.ts` maps `{provider, model} -> checkpoint` so the family-independence
 * audit can tell that two providers are serving the same WEIGHTS and must count as one vote.
 * A retired model id there is not a call — it is how the audit recognises those weights if they
 * turn up in stored history or via another host. Deleting the row to satisfy a grep would blind
 * the audit, which is a real correctness loss traded for a cosmetic one.
 *
 * Anything added here needs that kind of reason, in writing. "It was failing" is not one.
 */
const RECORD_NOT_CALL_PATH = [
  'src/hal/checkpoint-registry.ts',
  // `retired-models.ts` IS the list this guard enforces. It names every dead id as a literal by
  // construction — that is its entire content — so scanning it would make the guard fail on its
  // own source. Excluding it costs nothing: it exports no endpoint, no key and no default, and
  // the one thing a reader could do wrong there (add an id) is what the file is for.
  'src/hal/retired-models.ts',
];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      // Skip __tests__ — a test may legitimately name a dead model to assert it is gone,
      // which is exactly what this file does.
      if (entry === '__tests__') continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !RECORD_NOT_CALL_PATH.includes(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Strip comments. A retired id NAMED IN A COMMENT is fine — the comments explaining what died
 *  and when are the most useful thing in those files, and flagging them would get them deleted. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // the [^:] keeps `https://` intact
}

/**
 * Is this id used as a string literal in a code position?
 *
 * ANCHORED ON THE ID, deliberately, rather than extracting every literal and comparing. The
 * obvious version — match /'[^']+'/g and compare each — LOOKS right and silently does not work
 * on real TypeScript: an apostrophe inside a regex literal or a template string breaks quote
 * pairing, so the matcher runs away and swallows a 1000-character span as one "literal". The id
 * is then inside that blob rather than equal to it, and the guard passes over a dead model.
 *
 * That is not hypothetical. The first version of this file did exactly that, and it was only
 * caught because the failability check below was run — reintroducing a dead id left the suite
 * green. An unfailable guard is worse than no guard, since it also reports safety.
 */
function usedAsLiteral(source: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`['"\`]${escaped}['"\`]`).test(stripComments(source));
}

describe('no live HAL path defaults to a retired model', () => {
  const files = LIVE_DIRS.flatMap(tsFilesUnder);

  it('finds the HAL sources to scan (a scan over nothing would pass vacuously)', () => {
    // Without this, deleting or renaming src/hal would turn every assertion below green.
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(RETIRED_MODELS)('$vendor retired $id on $died — no default may use it', ({ id }) => {
    const offenders = files.filter((f) => usedAsLiteral(readFileSync(f, 'utf8'), id));
    expect(offenders).toEqual([]);
  });

  it('the guard can actually fail — a retired id IS detected in code position', () => {
    const sample = `const m = process.env.X ?? 'llama-3.1-8b-instant';`;
    expect(usedAsLiteral(sample, 'llama-3.1-8b-instant')).toBe(true);
  });

  it('detects it even next to a regex literal, which broke the first version of this guard', () => {
    // The exact shape that made this guard silently useless: an apostrophe-bearing regex and a
    // template string upstream of the id. Quote-pairing runs away here; anchoring does not.
    const sample = [
      `const m = String(x).match(/\\b(100|[0-9]{1,2})\\b/);`,
      'const t = `${a.slice(0, 10)}`;',
      `const model = process.env.X ?? 'llama-3.1-8b-instant';`,
    ].join('\n');
    expect(usedAsLiteral(sample, 'llama-3.1-8b-instant')).toBe(true);
  });

  it('a retired id mentioned only in a comment is NOT flagged', () => {
    // Otherwise the honest notes explaining the outage would fail the build, and whoever hit
    // that would delete the explanation rather than the dead call.
    const sample = `// WAS 'llama-3.1-8b-instant' until Groq shut it down.\nconst m = 'openai/gpt-oss-20b';`;
    expect(usedAsLiteral(sample, 'llama-3.1-8b-instant')).toBe(false);
  });
});
