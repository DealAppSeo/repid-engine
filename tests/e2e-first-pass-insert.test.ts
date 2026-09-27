/**
 * Mocked insert of a first-pass vote row. A missing-column probe inserts nothing.
 */
import { writePassVote, type PassVoteInput } from '../src/hal/first-pass-vote';

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

const ROW: PassVoteInput = {
  receipt_id: 11,
  family: 'llama',
  host: 'groq',
  first_pass_verdict: 'TRUE',
  first_pass_at: '2026-09-27T00:00:00.000Z',
  post_hal_verdict: 'FALSE',
  post_hal_at: '2026-09-27T00:01:00.000Z',
};

describe('e2e first-pass insert', () => {
  it('inserts the first-pass columns through the mock', async () => {
    const db = mock('present');
    const res = await writePassVote(db.client, ROW, OPEN);
    expect(res.written).toBe(true);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]?.table).toBe('hal_quorum_validator_votes');
    expect(db.inserts[0]?.row).toMatchObject({
      host: 'groq',
      first_pass_verdict: 'TRUE',
      first_pass_at: '2026-09-27T00:00:00.000Z',
      post_hal_verdict: 'FALSE',
      post_hal_at: '2026-09-27T00:01:00.000Z',
    });
  });

  it('inserts nothing when the columns are missing', async () => {
    const db = mock('missing');
    const res = await writePassVote(db.client, ROW, OPEN);
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe('columns-missing');
    expect(db.inserts).toHaveLength(0);
  });
});
