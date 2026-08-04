/**
 * The ratchet — raw score-event inserts may only ever DECREASE.
 *
 * `trg_apply_repid_score_event` is a live BEFORE INSERT trigger that applies every
 * delta unless the inserting code pre-sets `repid_delta_applied`. That single IF is
 * the whole double-count guard, it is per-writer, and nothing at a call site hints
 * it exists. Audited 2026-08-03: 3 of 11 writers hold it; seven both let the trigger
 * apply and write current_repid themselves.
 *
 * A big-bang refactor of eleven money-adjacent writers in one change would be a
 * worse risk than the bug. So this is a ratchet instead: the known raw inserters are
 * listed, the list is asserted to not GROW, and each migration to
 * insertScoreEvent() removes a line. Writer #12 fails this test on arrival.
 *
 * If this test fails because you added a raw insert: use
 * `src/scoring/score-event-writer.ts` instead. It makes you state who applies the
 * delta, which is the thing everyone silently got wrong.
 *
 * If it fails because you MIGRATED one: delete its line from ALLOWED. That is the
 * intended direction and the only edit that should ever shrink this list.
 *
 * ─── AMENDED 2026-08-03 (services lane) ─────────────────────────────────────
 * "Writer #12 fails this test on arrival" was not true, and writer #12 had
 * already arrived. `hasRawInsert()` matched only the supabase-js dialect
 * (`from('repid_score_events') … .insert(`), so `src/services/peer-verify-score.ts`
 * — which inserts with raw SQL through `pgQuery` — was invisible to it, absent
 * from ALLOWED, and uncounted. `<= 11` was the count of writers this test could
 * SEE, presented as the count of writers that exist.
 *
 * Two changes, both narrow:
 *   1. `hasRawInsert()` now recognises BOTH dialects, so a raw-SQL writer can
 *      never again be added without failing this test.
 *   2. `src/services/peer-verify-score.ts` is listed, and the bound is the true
 *      12. Direction of travel is still DOWN and only migrations may shrink it.
 *
 * Counted independently rather than inherited: 16 insert sites across 13 files
 * under `src/` in both dialects, of which one file is the helper itself → 15
 * sites across 12 writer files. Under `src/services/**` specifically: 3 sites in
 * 3 files (`peer-verify-score.ts:47` raw-SQL, `repid-earning.ts:178`,
 * `substance-gate-writer.ts:170`).
 *
 * NOTE this test is file-level by design and stays that way; the SITE-level and
 * per-dialect count lives in `tests/writers-raw-insert-ratchet.test.ts`.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Files still performing a raw `.from('repid_score_events').insert(`.
 *
 * Each entry is a writer that has NOT yet been migrated. Ordered by risk: the ones
 * that also write current_repid can double-apply the moment their arithmetic stops
 * agreeing with the trigger's.
 */
const ALLOWED_RAW_INSERTERS = new Set<string>([
  // ── hold the guard (set repid_delta_applied) — safe, migrate for consistency ──
  'src/scoring/pipeline.ts',
  'src/services/repid-earning.ts',
  // ── do NOT hold the guard AND write current_repid — audit targets ────────────
  'src/routes/agents-external.ts',
  'src/routes/agents.ts',
  'src/routes/challenge.ts',
  'src/services/substance-gate-writer.ts',
  // ── all three live under src/testing/ — red-team + e2e harnesses, not production
  //    request paths. Lower risk than their current_repid writes suggest, but they
  //    do write to the same live table, so they stay on the list.
  'src/testing/red-team.ts',
  'src/testing/redteam-adjudication.ts',
  'src/testing/t12-e2e-proof.ts',
  // ── event-only (never writes current_repid) — lowest risk ────────────────────
  'src/routes/mirror-test.ts',
  // ── raw SQL via pgQuery — writer #12, which the supabase-js-only regex above
  //    could not see. Never writes current_repid, so the trigger is its sole
  //    applier and it cannot double-apply on any ordering. It also cannot insert
  //    at all today (42P10 on an unresolvable ON CONFLICT, then 23514 on the
  //    event_type whitelist) — see the header of that file.
  'src/services/peer-verify-score.ts',
  // ── documented but dormant: zero events in 30 days (see REPID_TWO_PATH_DIVERGENCE)
  'src/engine/repid-update.ts',
]);

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

/**
 * Matches an unguarded insert on the table in EITHER dialect.
 *
 * The supabase-js arm tolerates whitespace and chained calls. The raw-SQL arm is
 * the one this test was missing: a writer using `pgQuery` never mentions
 * `.from(...)`, so it slipped past entirely.
 */
function hasRawInsert(source: string): boolean {
  const supabaseJs = /from\(\s*['"`]repid_score_events['"`]\s*\)[\s\S]{0,400}?\.\s*insert\s*\(/;
  const rawSql = /INSERT\s+INTO\s+(?:public\.)?repid_score_events/i;
  return supabaseJs.test(source) || rawSql.test(source);
}

describe('raw score-event inserts are a ratchet, not a habit', () => {
  const files = walk('src');
  const found = new Set<string>();

  for (const f of files) {
    const rel = f.replace(/\\/g, '/');
    if (rel === SELF) continue;
    if (hasRawInsert(readFileSync(f, 'utf8'))) found.add(rel);
  }

  it('no NEW file performs a raw insert', () => {
    const unexpected = [...found].filter((f) => !ALLOWED_RAW_INSERTERS.has(f)).sort();
    expect(unexpected).toEqual([]);
  });

  it('the allow-list has no stale entries — a migrated file must be removed from it', () => {
    // Keeps the list honest in the shrinking direction too: once a writer is
    // migrated, leaving it listed would hide the next regression in that file.
    const stale = [...ALLOWED_RAW_INSERTERS].filter((f) => !found.has(f)).sort();
    expect(stale).toEqual([]);
  });

  it('records the current debt so progress is visible', () => {
    // Not an assertion about quality — a tripwire on the number, so a silent
    // increase is impossible even if someone edits the list.
    expect(found.size).toBe(ALLOWED_RAW_INSERTERS.size);
    // 12, not 11. The old bound was the count of writers this test could see.
    expect(found.size).toBeLessThanOrEqual(12);
  });

  it('sees the raw-SQL dialect, not just supabase-js', () => {
    // Guards the hole itself. `peer-verify-score.ts` has no `.from(...)` call at
    // all, so if this file is ever absent from `found` the widened regex has
    // regressed and writer #13 could arrive by pgQuery unnoticed.
    expect(found.has('src/services/peer-verify-score.ts')).toBe(true);
  });

  it('every writer under src/services/** is accounted for', () => {
    // Counted independently, both dialects, sites not files: 3 sites / 3 files.
    const services = [...found].filter((f) => f.startsWith('src/services/')).sort();
    expect(services).toEqual([
      'src/services/peer-verify-score.ts',
      'src/services/repid-earning.ts',
      'src/services/substance-gate-writer.ts',
    ]);
  });
});
