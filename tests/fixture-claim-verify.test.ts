/**
 * One fixture claim through the mocked verify path.
 * Missing columns insert nothing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyFixtureClaim, type FixtureClaim } from '../src/hal/fixture-claim-verify';

function mock(columns: 'present' | 'missing') {
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  const client = {
    from(table: string) {
      return {
        select(columnsSql: string) {
          return {
            async limit(_n: number) {
              if (!columnsSql.includes('first_pass_verdict') || !columnsSql.includes('post_hal_at')) {
                return { error: { message: 'column "first_pass_verdict" does not exist' } };
              }
              if (columns === 'missing') {
                return { error: { message: 'column "first_pass_verdict" does not exist' } };
              }
              return { error: null };
            },
          };
        },
        async insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return { error: null };
        },
      };
    },
  };
  return { client, inserts };
}

const OPEN = { HAL_QUORUM_RECEIPT_ENABLED: 'true' };

describe('mocked fixture verify', () => {
  const claim = JSON.parse(
    readFileSync(path.join(__dirname, 'fixtures', 'first-pass-claim.json'), 'utf8'),
  ) as FixtureClaim;

  it('inserts host, first_pass_verdict, and first_pass_at for one fixture claim', async () => {
    const db = mock('present');
    const res = await verifyFixtureClaim(db.client, claim, OPEN);
    expect(res.written).toBe(true);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]?.table).toBe('hal_quorum_validator_votes');
    expect(db.inserts[0]?.row).toMatchObject({
      host: 'groq',
      first_pass_verdict: 'FALSE',
      first_pass_at: '2026-09-26T12:00:00.000Z',
    });
    expect(JSON.stringify(db.inserts[0]?.row)).not.toContain('user_id');
  });

  it('inserts nothing when the columns are missing', async () => {
    const db = mock('missing');
    const res = await verifyFixtureClaim(db.client, claim, OPEN);
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe('columns-missing');
    expect(db.inserts).toHaveLength(0);
  });

  it('does not dial a database from the verify module', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'hal', 'fixture-claim-verify.ts'), 'utf8');
    expect(src).toContain('writePassVote');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('.insert(');
  });
});
