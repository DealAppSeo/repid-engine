/**
 * The two holes in `tests/score-event-writer-ratchet.test.ts`, plus a
 * guard-participation assertion for the writers this lane owns.
 *
 * That test is the right idea, but its tripwire has two gaps that let a real
 * writer through:
 *
 *   HOLE 1 — IT ONLY SEES supabase-js. Its regex is
 *   `from('repid_score_events') ... .insert(`, so a writer that inserts with raw
 *   SQL through `pgQuery` is invisible to it. `src/services/peer-verify-score.ts`
 *   does exactly that (`INSERT INTO repid_score_events (...)` at line 47) and is
 *   absent from its ALLOWED list. The honest count of writers under src/ is
 *   therefore 12 files, not the 11 that test asserts.
 *
 *   HOLE 2 — IT COUNTS FILES, NOT CALL SITES. `hasRawInsert()` returns a boolean
 *   per file and the debt tripwire checks `found.size` (a Set of paths). Adding a
 *   SECOND raw insert to an already-allow-listed file changes nothing it looks
 *   at. `routes/challenge.ts` already has two; a third would land silently.
 *
 * This file closes both by counting SITES across BOTH insert dialects, and adds
 * the check the writer map actually cares about: a writer that still holds a raw
 * insert must also carry the guarded branch, so the unguarded form cannot become
 * the only form again.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SELF = 'src/scoring/score-event-writer.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every supabase-js `.from('repid_score_events') … .insert(` site in a file. */
function supabaseInsertSites(src: string): number {
  const re = /from\(\s*['"`]repid_score_events['"`]\s*\)[\s\S]{0,400}?\.\s*insert\s*\(/g;
  return (src.match(re) ?? []).length;
}

/** Every raw-SQL `INSERT INTO repid_score_events` site in a file. */
function rawSqlInsertSites(src: string): number {
  const re = /INSERT\s+INTO\s+(?:public\.)?repid_score_events/gi;
  return (src.match(re) ?? []).length;
}

interface WriterFacts {
  supabase: number;
  rawSql: number;
  total: number;
  guarded: boolean;
}

function collect(): Map<string, WriterFacts> {
  const out = new Map<string, WriterFacts>();
  for (const f of walk('src')) {
    const rel = f.replace(/\\/g, '/');
    if (rel === SELF) continue;
    const src = readFileSync(f, 'utf8');
    const supabase = supabaseInsertSites(src);
    const rawSql = rawSqlInsertSites(src);
    if (supabase + rawSql === 0) continue;
    out.set(rel, {
      supabase,
      rawSql,
      total: supabase + rawSql,
      // "Guarded" = the file routes through the single-applier helper and states
      // the applier explicitly, rather than leaving it to the DB trigger.
      guarded: /insertScoreEvent\s*\(/.test(src) && /applier:\s*'caller'/.test(src),
    });
  }
  return out;
}

/**
 * Known score-event insert SITES per file, both dialects, as of 2026-08-03.
 *
 * Direction of travel is DOWN. If a number here goes up, a writer was added:
 * use `src/scoring/score-event-writer.ts` instead — it makes you say who applies
 * the delta, which is the thing every writer on this list silently got wrong.
 */
const KNOWN_SITES: Record<string, number> = {
  // ── this lane's fence: src/routes/** + src/testing/** ────────────────────
  'src/routes/agents-external.ts': 1,
  'src/routes/agents.ts': 1,
  'src/routes/challenge.ts': 2,
  'src/routes/mirror-test.ts': 1,
  'src/testing/red-team.ts': 1,
  'src/testing/redteam-adjudication.ts': 1,
  'src/testing/t12-e2e-proof.ts': 1,
  // ── other lanes / out of fence ───────────────────────────────────────────
  'src/engine/repid-update.ts': 2,
  'src/scoring/pipeline.ts': 2,
  'src/services/repid-earning.ts': 1,
  'src/services/substance-gate-writer.ts': 1,
  // raw SQL via pgQuery — the writer the existing ratchet cannot see at all
  'src/services/peer-verify-score.ts': 1,
};

/** Writers this lane owns and has migrated to the guarded (flagged) form. */
const IN_FENCE_GUARDED = [
  'src/routes/agents-external.ts',
  'src/routes/agents.ts',
  'src/routes/challenge.ts',
  'src/routes/mirror-test.ts',
  'src/testing/red-team.ts',
  'src/testing/redteam-adjudication.ts',
  'src/testing/t12-e2e-proof.ts',
];

describe('score-event insert sites are a ratchet across BOTH insert dialects', () => {
  const found = collect();

  it('no NEW file inserts score events, in either dialect', () => {
    const unexpected = [...found.keys()].filter((f) => !(f in KNOWN_SITES)).sort();
    expect(unexpected).toEqual([]);
  });

  it('the known-sites map has no stale entries', () => {
    const stale = Object.keys(KNOWN_SITES).filter((f) => !found.has(f)).sort();
    expect(stale).toEqual([]);
  });

  it('no file GREW a call site — this is what the file-level ratchet misses', () => {
    const grew: string[] = [];
    for (const [file, facts] of found) {
      const known = KNOWN_SITES[file];
      if (known !== undefined && facts.total > known) {
        grew.push(`${file}: ${known} -> ${facts.total}`);
      }
    }
    expect(grew).toEqual([]);
  });

  it('counts the raw-SQL writer the supabase-js-only regex cannot see', () => {
    // Regression guard on the hole itself: if peer-verify-score.ts ever stops
    // being counted here, this test has silently lost its reason to exist.
    const pv = found.get('src/services/peer-verify-score.ts');
    expect(pv).toBeDefined();
    expect(pv!.rawSql).toBeGreaterThanOrEqual(1);
    expect(pv!.supabase).toBe(0);
  });

  it('reports 12 writer files under src/, not 11', () => {
    // The existing ratchet asserts `found.size <= 11` because it cannot see the
    // pgQuery writer. Pinning the true number here stops "11" being quoted again.
    expect(found.size).toBe(12);
    expect(found.size).toBe(Object.keys(KNOWN_SITES).length);
  });
});

describe('every in-fence writer carries the structural guard', () => {
  const found = collect();

  it.each(IN_FENCE_GUARDED)(
    '%s routes through insertScoreEvent with an explicit caller-applier',
    (file) => {
      const facts = found.get(file);
      expect(facts).toBeDefined();
      // THE REGRESSION THIS CATCHES: a writer that keeps (or reverts to) only the
      // raw insert. Without repid_delta_applied the DB trigger applies the delta,
      // and for every writer here that also writes current_repid that is a second
      // application of the same delta — measured at +7 drift on prod.
      expect(facts!.guarded).toBe(true);
    }
  );

  it('the guarded branch is flag-gated, not on by default', () => {
    // Enforce changes live RepID arithmetic, so it must be opt-in. If a writer
    // calls insertScoreEvent unconditionally, this lane shipped a live change it
    // was told to ship inert.
    for (const file of IN_FENCE_GUARDED) {
      const src = readFileSync(file, 'utf8');
      expect(src).toMatch(/scoreEventGuardEnforced\s*\(\s*\)/);
    }
  });
});
