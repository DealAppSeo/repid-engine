/**
 * File-contract tests for the work-statement bind migration.
 * No database — these assert the artifact that would be applied.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const FORWARD = join(__dirname, '..', 'migrations', '2026-09-04-work-statement-bind.sql');
const DOWN = join(__dirname, '..', 'migrations', 'rollback', 'DOWN_2026-09-04-work-statement-bind.sql');

function activeSql(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

describe('migrations 2026-09-04 work-statement bind — file contract', () => {
  const raw = readFileSync(FORWARD, 'utf8');
  const sql = activeSql(raw);

  it('exists and is non-trivial', () => {
    expect(existsSync(FORWARD)).toBe(true);
    expect(raw.length).toBeGreaterThan(500);
  });

  it('has a matching rollback that does not drop the pre-existing hash column', () => {
    expect(existsSync(DOWN)).toBe(true);
    const down = readFileSync(DOWN, 'utf8');
    expect(down).toContain('2026-09-04-work-statement-bind');
    expect(down).toMatch(/DROP TRIGGER IF EXISTS trg_service_contracts_work_statement/);
    expect(down).toMatch(/DROP COLUMN IF EXISTS work_statement;/);
    expect(down).not.toMatch(/DROP COLUMN IF EXISTS work_statement_hash/);
  });

  it('is wrapped in an explicit transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;\s*$/m);
    expect(sql).toMatch(/^\s*COMMIT;\s*$/m);
  });

  it('states blast radius, verification, and legacy/no-backfill', () => {
    expect(raw).toContain('BLAST RADIUS');
    expect(raw).toContain('VERIFICATION');
    expect(raw).toMatch(/MAINTENANCE WINDOW|maintenance window/);
    expect(raw).toMatch(/do not backfill/i);
    expect(raw).toMatch(/LEGACY/);
  });

  it('does not DELETE and does not mutate RepID', () => {
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/repid_score_events|agent_repid|repid_agents/);
  });

  it('computes the hash server-side and refuses a client-supplied value', () => {
    expect(sql).toMatch(/work_statement_sha256/);
    expect(sql).toMatch(/WORK_STATEMENT_HASH_NOT_CLIENT_SET/);
    expect(sql).toMatch(/digest\(/);
  });

  it('gates the fulfilled transition, not existing fulfilled rows', () => {
    expect(sql).toMatch(/WORK_STATEMENT_REQUIRED/);
    expect(sql).toMatch(/OLD\.status IS DISTINCT FROM 'fulfilled'/);
    expect(sql).toMatch(/OLD\.work_statement_hash IS NULL/);
  });

  it('freezes the statement after bind and rates only hashed criteria', () => {
    expect(sql).toMatch(/WORK_STATEMENT_IMMUTABLE/);
    expect(sql).toMatch(/CRITERION_NOT_IN_STATEMENT/);
    expect(sql).toMatch(/RATING_REQUIRED/);
    expect(sql).toMatch(/buyer_satisfaction_score := derived/);
  });

  it('logs a schema_evolution row with rollback_sql', () => {
    expect(sql).toMatch(/INSERT INTO public\.schema_evolution/);
    expect(sql).toMatch(/rollback_sql/);
  });

  it('does not GRANT the helpers to anon', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.work_statement_sha256/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.work_statement_sha256\(jsonb\) TO service_role/);
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.work_statement_sha256\(jsonb\) TO anon/);
  });
});
