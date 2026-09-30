import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('hal quorum anon insert migration', () => {
  const sql = readFileSync(
    path.join(__dirname, '..', 'migrations', '2026-09-30-hal-quorum-anon-no-insert.sql'),
    'utf8',
  );

  it('revokes anon INSERT on both tables and does not grant it', () => {
    expect(sql).toContain('REVOKE INSERT ON TABLE public.hal_quorum_receipts FROM anon;');
    expect(sql).toContain('REVOKE INSERT ON TABLE public.hal_quorum_validator_votes FROM anon;');
    expect(sql).not.toMatch(/GRANT\s+INSERT[\s\S]*\banon\b/i);
    expect(sql).not.toMatch(/GRANT\s+ALL[\s\S]*\banon\b/i);
  });
});
