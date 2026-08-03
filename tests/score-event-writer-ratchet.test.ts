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

/** Matches an insert on the table, tolerating whitespace and chained calls. */
function hasRawInsert(source: string): boolean {
  const re = /from\(\s*['"]repid_score_events['"]\s*\)[\s\S]{0,200}?\.insert\(/;
  return re.test(source);
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
    expect(found.size).toBeLessThanOrEqual(11);
  });
});
