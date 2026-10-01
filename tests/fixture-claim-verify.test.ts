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
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          const id = inserts.filter((item) => item.table === 'hal_quorum_receipts').length || 1;
          const payload = { data: { id }, error: null };
          return {
            select() {
              return { async single() { return payload; } };
            },
            then(onOk: (value: { error: null }) => unknown, onErr?: (error: unknown) => unknown) {
              return Promise.resolve({ error: null }).then(onOk, onErr);
            },
          };
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
    expect(db.inserts).toHaveLength(2);
    const parent = db.inserts.find((item) => item.table === 'hal_quorum_receipts');
    const vote = db.inserts.find((item) => item.table === 'hal_quorum_validator_votes');
    expect(parent?.row).not.toHaveProperty('claim');
    expect(vote?.row).toMatchObject({
      host: 'groq',
      first_pass_verdict: 'FALSE',
      first_pass_at: '2026-09-26T12:00:00.000Z',
    });
    expect(vote?.row).not.toHaveProperty('claim');
    expect(JSON.stringify(db.inserts)).not.toContain('user_id');
  });

  it('inserts nothing when the columns are missing', async () => {
    const db = mock('missing');
    const res = await verifyFixtureClaim(db.client, claim, OPEN);
    expect(res.written).toBe(false);
    expect(res.reason).toBe('columns-missing');
    expect(db.inserts).toHaveLength(0);
  });

  it('includes the receipt id and the family verdicts, and a claim key fails', async () => {
    const db = mock('present');
    const poisoned = { ...claim, claim: 'the surgeon is the mother' };
    const res = await verifyFixtureClaim(db.client, poisoned, OPEN);
    expect(res.receipt_id).toBe('1');
    expect(res.families).toEqual([{ family: 'llama', verdict: 'FALSE' }]);
    expect(Object.prototype.hasOwnProperty.call(res, 'claim')).toBe(false);
    expect(JSON.stringify(res)).not.toContain('claim');
    expect(JSON.stringify(res)).not.toContain('surgeon');

    const missing = await verifyFixtureClaim(
      db.client,
      { ...claim, first_pass_verdict: 0, receipt_id: 0 },
      OPEN,
    );
    expect(missing.receipt_id).toBe('NOT_CHECKED');
    expect(missing.families[0]?.verdict).toBe('NOT_CHECKED');
    expect(missing.families[0]?.verdict).not.toBe(0);
    expect(missing.receipt_id).not.toBe(0);
    expect(missing).not.toHaveProperty('claim');
  });

  it('does not dial a database from the verify module', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'hal', 'fixture-claim-verify.ts'), 'utf8');
    expect(src).toContain('writeV1Receipt');
    expect(src).not.toContain('supabase');
    expect(src).not.toContain('fetch(');
    expect(src).not.toContain('.insert(');
  });
});
