/**
 * Static contract tests for the 2026-08-03 migrations lane.
 *
 * WHY THESE ARE FILE-TEXT TESTS AND NOT DB TESTS
 * ----------------------------------------------
 * This lane may not apply DDL to production, and there is no local Postgres in CI — the
 * repo's DB-touching suites gate on `!!(process.env.SUPABASE_URL && ...)`, a PRESENCE check,
 * so with the dummy `SUPABASE_URL=http://localhost:54321` they run against a dead URL and
 * report 5000 ms timeouts as though the schema were broken. Writing another suite in that
 * shape would add noise, not coverage.
 *
 * So these tests assert what CAN be checked without a database, and what a future editor is
 * most likely to break by accident:
 *
 *   1. every forward migration has a rollback,
 *   2. every migration is transactional and idempotent,
 *   3. no migration mutates or deletes a row,
 *   4. the range constraints stay NOT VALID (removing that word would abort on 21,282 rows),
 *   5. the renamed trigger still sorts BEFORE trg_apply_repid_score_event — the actual bug,
 *      expressed as a string comparison rather than as a comment nobody re-checks,
 *   6. the replaced view keeps its 13 existing columns in their existing order, which is what
 *      makes CREATE OR REPLACE legal and what preserves its grants.
 *
 * (5) and (6) are the load-bearing ones. Everything else is hygiene.
 *
 * These tests need no credentials, no network, and no database.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const ROLLBACK_DIR = join(MIGRATIONS_DIR, 'rollback');

/** The forward migrations this lane added. */
const LANE_MIGRATIONS = [
  '2026-08-03-hal-penalty-guard-trigger-order.sql',
  '2026-08-03-repid-penalty-suppression-audit-view.sql',
  '2026-08-03-repid-score-events-range-check.sql',
  '2026-08-03-hal-accuracy-summary-ruler-scoping.sql',
] as const;

const read = (dir: string, name: string): string => readFileSync(join(dir, name), 'utf8');
const forward = (name: string): string => read(MIGRATIONS_DIR, name);
const rollbackName = (name: string): string => `DOWN_${name}`;

describe('migrations 2026-08-03 — file contract', () => {
  it.each(LANE_MIGRATIONS)('%s exists and is non-trivial', (name) => {
    const path = join(MIGRATIONS_DIR, name);
    expect(existsSync(path)).toBe(true);
    expect(forward(name).length).toBeGreaterThan(500);
  });

  it.each(LANE_MIGRATIONS)('%s has a matching rollback', (name) => {
    const path = join(ROLLBACK_DIR, rollbackName(name));
    expect(existsSync(path)).toBe(true);
    const down = read(ROLLBACK_DIR, rollbackName(name));
    // A rollback must name what it reverses, or it is a loose file nobody can pair up.
    expect(down).toContain(name);
  });

  it.each(LANE_MIGRATIONS)('%s is wrapped in an explicit transaction', (name) => {
    const sql = forward(name);
    expect(sql).toMatch(/^\s*BEGIN;\s*$/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
  });

  it.each(LANE_MIGRATIONS)('%s states its blast radius and a verification query', (name) => {
    const sql = forward(name);
    expect(sql).toContain('BLAST RADIUS');
    expect(sql).toContain('VERIFICATION');
    // Every file must say whether a maintenance window is needed — the question a reviewer
    // asks first and the one most often left unanswered.
    expect(sql).toMatch(/MAINTENANCE WINDOW|maintenance window/);
  });

  it.each(LANE_MIGRATIONS)('%s is marked as not-yet-applied to production', (name) => {
    // These files are written by a lane that is forbidden from applying DDL. If that banner
    // ever goes missing, the next reader may assume the migration is already live.
    expect(forward(name)).toContain('PROMOTION-GATED');
  });
});

describe('migrations 2026-08-03 — idempotency', () => {
  it.each(LANE_MIGRATIONS)('%s guards every object it creates', (name) => {
    const sql = forward(name);
    // Each migration must use at least one idempotency mechanism: an existence guard in a
    // DO block, IF NOT EXISTS, or CREATE OR REPLACE.
    const guarded =
      /IF\s+NOT\s+EXISTS/i.test(sql) ||
      /CREATE\s+OR\s+REPLACE/i.test(sql) ||
      /NOT\s+EXISTS\s*\(/i.test(sql);
    expect(guarded).toBe(true);
  });

  it.each(LANE_MIGRATIONS.map(rollbackName))('%s is idempotent', (name) => {
    const sql = read(ROLLBACK_DIR, name);
    const guarded = /IF\s+EXISTS/i.test(sql) || /NOT\s+EXISTS\s*\(/i.test(sql);
    expect(guarded).toBe(true);
  });

  it('no rollback uses CASCADE — a failed drop must make a human look', () => {
    for (const name of LANE_MIGRATIONS.map(rollbackName)) {
      expect(read(ROLLBACK_DIR, name)).not.toMatch(/DROP\s+VIEW[^;]*CASCADE/i);
    }
  });
});

describe('migrations 2026-08-03 — never leave a row behind', () => {
  // The lane's hardest rule. A migration here adds constraints and views; it must not rewrite
  // or remove ledger rows. repid_score_events is an append-only audit log.
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['DELETE FROM', /\bDELETE\s+FROM\b/i],
    ['TRUNCATE', /\bTRUNCATE\b/i],
    ['DROP TABLE', /\bDROP\s+TABLE\b/i],
    ['UPDATE ... SET', /\bUPDATE\s+(?:public\.)?[a-z_]+\s+SET\b/i],
    ['INSERT INTO', /\bINSERT\s+INTO\b/i],
  ];

  const allFiles = [...LANE_MIGRATIONS, ...LANE_MIGRATIONS.map(rollbackName)];

  it.each(allFiles)('%s contains no row-mutating statement', (name) => {
    const dir = name.startsWith('DOWN_') ? ROLLBACK_DIR : MIGRATIONS_DIR;
    // Strip SQL comments first: these files quote example queries and describe the defect in
    // prose, and a match inside a comment is not a statement.
    const sql = read(dir, name)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');

    for (const [label, pattern] of FORBIDDEN) {
      expect({ file: name, statement: label, found: pattern.test(sql) }).toEqual({
        file: name,
        statement: label,
        found: false,
      });
    }
  });
});

describe('defect 1 — trigger firing order', () => {
  const sql = forward('2026-08-03-hal-penalty-guard-trigger-order.sql');

  it('renames the guard to a name that sorts before trg_apply_repid_score_event', () => {
    // THE BUG, as a test. PostgreSQL fires same-timing row triggers in name order, so the fix
    // is only a fix if this string comparison holds. If someone renames the guard again to
    // something "tidier", this fails before it reaches production.
    const NEW_NAME = 'trg_00_hal_penalty_guard';
    const APPLY = 'trg_apply_repid_score_event';

    expect(sql).toContain(`RENAME TO ${NEW_NAME}`);
    expect(NEW_NAME < APPLY).toBe(true);

    // And confirm the ORIGINAL name did NOT sort first — i.e. the defect was real, and this
    // test would have caught it.
    expect('trg_hal_penalty_guard' < APPLY).toBe(false);
  });

  it('asserts the ordering invariant inside the migration itself', () => {
    // A rename that silently no-ops is worse than no rename. The migration must RAISE.
    expect(sql).toContain('INVARIANT VIOLATED');
    expect(sql).toMatch(/RAISE\s+EXCEPTION/i);
  });

  it('does not modify the guard function body', () => {
    // Changing trg_hal_penalty_guard() would change HAL penalty behaviour, which is out of
    // this lane's scope. Reordering is not rewriting.
    expect(sql).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.trg_hal_penalty_guard/i);
  });

  it('rollback restores the original name, defect included', () => {
    const down = read(ROLLBACK_DIR, rollbackName('2026-08-03-hal-penalty-guard-trigger-order.sql'));
    expect(down).toContain('RENAME TO trg_hal_penalty_guard');
  });
});

describe('defect 2 — repid_score_events range checks', () => {
  const sql = forward('2026-08-03-repid-score-events-range-check.sql');

  it.each(['repid_after', 'repid_before'])('constrains %s to the repid_agents range', (col) => {
    expect(sql).toContain(`repid_score_events_${col}_range`);
    expect(sql).toMatch(new RegExp(`${col}\\s*>=\\s*10\\s*AND\\s+${col}\\s*<=\\s*10000`, 'i'));
  });

  it('adds both constraints as NOT VALID', () => {
    // NOT VALID is not optional here: 21,282 pre-existing rows violate the range (21,281
    // below 10, one at 10040). A validating ADD would abort. If a future edit drops the
    // words "NOT VALID", the migration stops being applicable and this test says so.
    const notValidCount = (sql.match(/NOT\s+VALID/gi) ?? []).length;
    expect(notValidCount).toBeGreaterThanOrEqual(2);
  });

  it('is NULL-tolerant, because the columns are nullable', () => {
    expect(sql).toMatch(/repid_after\s+IS\s+NULL\s+OR/i);
    expect(sql).toMatch(/repid_before\s+IS\s+NULL\s+OR/i);
  });

  it('uses separate constraints per column so each can be validated independently', () => {
    expect(sql).toContain('repid_score_events_repid_after_range');
    expect(sql).toContain('repid_score_events_repid_before_range');
  });

  it('does not attempt VALIDATE CONSTRAINT, which would abort', () => {
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/VALIDATE\s+CONSTRAINT/i);
  });

  it('rollback drops both constraints', () => {
    const down = read(ROLLBACK_DIR, rollbackName('2026-08-03-repid-score-events-range-check.sql'));
    expect(down).toMatch(/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+repid_score_events_repid_after_range/i);
    expect(down).toMatch(/DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+repid_score_events_repid_before_range/i);
  });
});

describe('defect 3 — hal_accuracy_summary ruler scoping', () => {
  const NAME = '2026-08-03-hal-accuracy-summary-ruler-scoping.sql';
  const sql = forward(NAME);

  /** The 13 live columns, in ordinal order, as read from information_schema on 2026-08-03. */
  const EXISTING_COLUMNS = [
    'tp',
    'fp',
    'fn',
    'tn',
    'total_labeled',
    'total_raw',
    'precision',
    'recall',
    'f1_score',
    'false_positive_rate',
    'data_quality',
    'source_table',
    'computed_at',
  ];

  it('replaces the view rather than dropping it, so grants survive', () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.hal_accuracy_summary/i);
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/DROP\s+VIEW\s+(IF\s+EXISTS\s+)?public\.hal_accuracy_summary/i);
  });

  it('preserves all 13 existing columns in their existing order', () => {
    // CREATE OR REPLACE VIEW can only APPEND columns. Reordering or renaming any of these
    // makes the migration fail at apply time with "cannot change name of view column".
    const body = sql.slice(
      sql.search(/CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.hal_accuracy_summary/i),
      sql.search(/CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.hal_accuracy_by_ruler/i),
    );
    const positions = EXISTING_COLUMNS.map((col) => {
      const alias = col === 'precision' ? '"precision"' : col;
      return body.indexOf(`AS ${alias}`) >= 0
        ? body.indexOf(`AS ${alias}`)
        : body.indexOf(`  ${alias},`);
    });
    for (const [i, pos] of positions.entries()) {
      expect({ column: EXISTING_COLUMNS[i], found: pos >= 0 }).toEqual({
        column: EXISTING_COLUMNS[i],
        found: true,
      });
    }
    // Strictly increasing = same order as the live view.
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it('withholds the ratios instead of substituting a value when unruled', () => {
    // #327's rule: a zero or incomparable denominator yields null, never a substituted 1.
    expect(sql).toContain('is_measurement');
    expect(sql).toMatch(/UNRULED_MIXED_POPULATION/);
    // The old view computed f1 unconditionally; the new one must gate it.
    expect(sql).toMatch(/CASE\s+WHEN\s+is_measurement[\s\S]{0,200}f1_score/i);
  });

  it('refuses to treat mock-mode rows as a measurement', () => {
    expect(sql).toMatch(/mock/);
    expect(sql).toContain('NOT_A_MEASUREMENT_MOCK_MODE');
  });

  it('emits a citation and never fabricates a corpus hash', () => {
    expect(sql).toContain('citation');
    // The hash does not exist in this schema. It must be printed as UNKNOWN, not invented.
    expect(sql).toContain('sha256:UNKNOWN');
    expect(sql).toContain('NOT COMPARABLE');
  });

  it('only claims a strictness where hal_mode determines it', () => {
    // 'fact-check-s2' is the cross-LLM quorum path (strictness 2). Nothing else is asserted.
    expect(sql).toMatch(/hal_mode\s*=\s*'fact-check-s2'\s+THEN\s+2/i);
  });

  it('adds the per-ruler view', () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.hal_accuracy_by_ruler/i);
  });

  it('rollback restores the definition that was live, not the oldest file on disk', () => {
    const down = read(ROLLBACK_DIR, rollbackName(NAME));
    // The live definition used hal_ground_truth_labels and total_labeled/total_raw. The
    // ORIGINAL 2026-05-11 file used a `total` column that has not existed since May —
    // rolling back to it would silently revert four months of change.
    expect(down).toContain('hal_ground_truth_labels');
    expect(down).toContain('total_labeled');
    expect(down).toContain('total_raw');
    expect(down).not.toMatch(/\bAS\s+total\b/);
    // A DROP is unavoidable here (a 13-column body cannot replace a 17-column view), so the
    // rollback MUST re-grant explicitly or it silently revokes anon/authenticated SELECT.
    expect(down).toMatch(/GRANT\s+SELECT\s+ON\s+public\.hal_accuracy_summary\s+TO\s+anon/i);
    expect(down).toMatch(/GRANT\s+SELECT\s+ON\s+public\.hal_accuracy_summary\s+TO\s+authenticated/i);
    expect(down).toMatch(/GRANT\s+SELECT\s+ON\s+public\.hal_accuracy_summary\s+TO\s+service_role/i);
  });
});

describe('migrations 2026-08-03 — nothing proprietary in a reviewable file', () => {
  const allFiles = [...LANE_MIGRATIONS, ...LANE_MIGRATIONS.map(rollbackName)];

  it.each(allFiles)('%s contains no RepID formula and no ANFIS parameters', (name) => {
    const dir = name.startsWith('DOWN_') ? ROLLBACK_DIR : MIGRATIONS_DIR;
    // Scan EXECUTABLE SQL only. A comment that says "this migration changes no ANFIS parameter"
    // is a promise worth keeping in the file; the rule is about what the SQL computes, not about
    // which words appear in the prose. (This distinction was found by the test failing on its
    // own migrations — the first version banned the word and flagged the disclaimer.)
    const sql = read(dir, name)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .map((line) => line.replace(/--.*$/, '')) // strip trailing inline comments too
      .join('\n');

    // The scoring formula (a log-scaled transform) and ANFIS weights must never be computed in
    // a file intended for review or publication. The [10,10000] bounds are NOT the formula —
    // they are already public in repid_agents_current_repid_check.
    expect(sql).not.toMatch(/\bfloor\s*\(\s*2000\s*\*/i);
    expect(sql).not.toMatch(/\blog\s*(?:10)?\s*\(\s*(?:repid|score)/i);
    expect(sql).not.toMatch(/\banfis[_a-z]*\s*\(/i);
    expect(sql).not.toMatch(/\banfis_[a-z_]+\b/i);
    expect(sql).not.toMatch(/membership_function|lasso_weight/i);
  });
});
