import { writePassVote, type PassVoteInput } from '../src/hal/first-pass-vote';

const ROW: PassVoteInput = {
  receipt_id: 11,
  family: 'llama',
  host: 'groq',
  first_pass_verdict: 'TRUE',
  first_pass_at: '2026-09-27T00:00:00.000Z',
  post_hal_verdict: 'FALSE',
  post_hal_at: '2026-09-27T00:01:00.000Z',
};

describe('first-pass insert when columns are missing', () => {
  it('inserts nothing and reports columns-missing', async () => {
    let inserts = 0;
    const client = {
      from() {
        return {
          select() {
            return {
              async limit() {
                return { error: { message: 'column does not exist' } };
              },
            };
          },
          async insert() {
            inserts += 1;
            return { error: null };
          },
        };
      },
    };

    const res = await writePassVote(client, ROW, { HAL_QUORUM_RECEIPT_ENABLED: 'true' });
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe('columns-missing');
    expect(inserts).toBe(0);
  });
});
