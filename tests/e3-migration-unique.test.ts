/**
 * E3 — prod unique index SQL exists, with rollback_sql, and is not applied.
 * SYNTHETIC: this test reads the migration file only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SQL = readFileSync(resolve(process.cwd(), 'migrations/2026-09-15_kind_custody.sql'), 'utf8');

describe('E3 grounding unique index in migration', () => {
  it('unique is evidence_id only, with rollback_sql, and the file is not live SQL', () => {
    expect(SQL).toMatch(/primary key \(evidence_id\)/i);
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_repid_grounding_claims_evidence_id/i);
    expect(SQL).toMatch(/rollback_sql/i);
    expect(SQL).toMatch(/DROP INDEX IF EXISTS public\.uq_repid_grounding_claims_evidence_id/i);
    // Not applied: every executable line is commented.
    const live = SQL.split('\n').filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith('--');
    });
    expect(live).toEqual([]);
  });
});
