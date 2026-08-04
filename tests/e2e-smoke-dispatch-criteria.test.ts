/**
 * e2e-smoke-dispatch-criteria.test.ts
 *
 * Guards the producer fix in migrations/2026-08-04-e2e-smoke-criteria-hoist.sql.
 *
 * WHY A TEST THAT READS A .sql FILE: the defect this migration fixes was not a bug
 * in logic, it was an OMISSION — `dispatch_e2e_smoke()` simply did not list
 * `success_criteria` in its INSERT, so the column fell to the vacuous DB default
 * and every nightly task since carried 'Pass default checks.'. An omission of that
 * kind reappears silently the next time someone edits the function, and no
 * application test would notice, because no application code is involved: the
 * producer is a Postgres function invoked by cron.job 8.
 *
 * So the assertions here are deliberately about the SQL TEXT, and they are the
 * same rule the application gate applies (`isVacuousCriteria`) — one definition of
 * "states nothing", enforced on both the TypeScript producer path and the SQL one.
 *
 * This does NOT verify the migration has been APPLIED to production. It verifies
 * the artifact that would be applied is correct. Applying prod DDL is a separate,
 * gated action.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { isVacuousCriteria } from '../src/services/goal-ancestry';

const MIGRATION = join(__dirname, '..', 'migrations', '2026-08-04-e2e-smoke-criteria-hoist.sql');

/** Strip `--` comment lines so the rollback block (which is entirely commented) can't satisfy an assertion. */
function activeSql(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

describe('dispatch_e2e_smoke migration', () => {
  const raw = readFileSync(MIGRATION, 'utf8');
  const sql = activeSql(raw);

  it('lists success_criteria in the INSERT column list — the omission that caused the defect', () => {
    const insertCols = /INSERT INTO trinity_tasks\s*\(([^)]*)\)/i.exec(sql)?.[1] ?? '';
    expect(insertCols).toMatch(/success_criteria/);
    expect(insertCols).toMatch(/expected_output/);
    expect(insertCols).toMatch(/verification_method/);
    // Was already correct before this change; asserted so a future edit cannot drop it.
    expect(insertCols).toMatch(/requires_external_artifact/);
  });

  it('never writes the vacuous default as a criterion', () => {
    expect(sql).not.toMatch(/'Pass default checks\.'/);
  });

  it('the criterion it does write passes the same gate the application applies', () => {
    // Pull the success_criteria literal: the first single-quoted string after the
    // `'review', 'pending', ...` value row that is long enough to be the criterion.
    const literals = [...sql.matchAll(/'((?:[^']|''){80,})'/g)].map((m) => m[1]!);
    const criterion = literals.find((l) => /REAL integer http_status/i.test(l));

    expect(criterion).toBeDefined();
    expect(isVacuousCriteria(criterion)).toBe(false);
  });

  it('states the anti-fabrication rule AND sanctions an honest failure', () => {
    // Both halves matter. Demanding real evidence while giving an agent no accepted
    // way to say it could not obtain any is what steers it into inventing one.
    expect(sql).toMatch(/does NOT satisfy/i);
    expect(sql).toMatch(/could not reach endpoint/i);
    expect(sql).toMatch(/valid, correct outcome/i);
  });

  it('keeps the CHECKER text in the description the agent actually reads', () => {
    // The hoist must ADD a machine-readable copy, not MOVE the bar out of the
    // place the reader looks.
    expect(sql).toMatch(/CHECKER: valid ONLY IF/);
  });

  it('preserves the de-duplication guard so the nightly cannot pile up', () => {
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM trinity_tasks/);
    expect(sql).toMatch(/RETURN NULL/);
  });

  it('carries a verbatim rollback of the prior definition', () => {
    // Reversibility is claimed in the header; assert the block is actually present.
    expect(raw).toMatch(/ROLLBACK/);
    const rollbackAt = raw.indexOf('ROLLBACK');
    expect(raw.slice(rollbackAt)).toMatch(/--\s*CREATE OR REPLACE FUNCTION public\.dispatch_e2e_smoke\(\)/);
  });

  it('changes no table schema — this is a function replacement only', () => {
    expect(sql).not.toMatch(/ALTER TABLE/i);
    expect(sql).not.toMatch(/ADD COLUMN/i);
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    // And must not rewrite history: existing rows are the measurement baseline.
    expect(sql).not.toMatch(/UPDATE\s+trinity_tasks/i);
  });
});
