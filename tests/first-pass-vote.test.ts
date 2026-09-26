/**
 * A quorum vote row stores the first pass and the post-HAL pass apart.
 * Post-HAL without a first pass is not inserted. The writer inserts only when
 * HAL_QUORUM_RECEIPT_ENABLED is the exact string true.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizePassVote, writePassVote, type PassVoteInput } from '../src/hal/first-pass-vote';

function client(columns: 'present' | 'missing' = 'present') {
  const inserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  return {
    inserts,
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
        async insert(payload: Record<string, unknown>) {
          inserts.push({ table, rows: [payload] });
          return { error: null };
        },
      };
    },
  };
}

const OPEN = { HAL_QUORUM_RECEIPT_ENABLED: 'true' };

const GOOD: PassVoteInput = {
  receipt_id: 7,
  family: 'llama',
  host: 'groq',
  first_pass_verdict: 'TRUE',
  first_pass_at: '2026-09-26T00:00:00.000Z',
  post_hal_verdict: 'FALSE',
  post_hal_at: '2026-09-26T00:01:00.000Z',
};

describe('first pass vs HAL', () => {
  it('stores family, host, and both passes, and does not store a user id', async () => {
    const db = client();
    const res = await writePassVote(db, GOOD, OPEN);
    expect(res.written).toBe(true);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]?.table).toBe('hal_quorum_validator_votes');
    const row = db.inserts[0]?.rows[0];
    expect(row).toMatchObject({
      family: 'llama',
      host: 'groq',
      first_pass_verdict: 'TRUE',
      first_pass_at: '2026-09-26T00:00:00.000Z',
      post_hal_verdict: 'FALSE',
      post_hal_at: '2026-09-26T00:01:00.000Z',
    });
    const text = JSON.stringify(row);
    expect(text).not.toContain('user_id');
    expect(text).not.toContain('prompt');
    expect(text).not.toContain('claim');
  });

  it('does not insert a post-HAL value when the first pass is missing', async () => {
    const db = client();
    const res = await writePassVote(
      db,
      {
        receipt_id: 7,
        family: 'llama',
        host: 'groq',
        post_hal_verdict: 'FALSE',
        post_hal_at: '2026-09-26T00:01:00.000Z',
      },
      OPEN,
    );
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe('post-hal-without-first-pass');
    expect(db.inserts).toHaveLength(0);
    expect(normalizePassVote({
      receipt_id: 7,
      family: 'llama',
      host: 'groq',
      post_hal_verdict: 'FALSE',
      post_hal_at: '2026-09-26T00:01:00.000Z',
    }).ok).toBe(false);
  });

  it('stores a missing first pass as null, not 0', async () => {
    const db = client();
    const res = await writePassVote(
      db,
      {
        receipt_id: 7,
        family: 'llama',
        host: 'groq',
        first_pass_verdict: 0,
      },
      OPEN,
    );
    expect(res.written).toBe(true);
    const row = db.inserts[0]?.rows[0];
    expect(row?.first_pass_verdict).toBeNull();
    expect(row?.first_pass_verdict).not.toBe(0);
    expect(row?.verdict).toBe('NOT_CHECKED');
    expect(row?.verdict).not.toBe(0);
  });

  it('does not insert when the migration columns are missing', async () => {
    const sql = readFileSync(
      path.join(__dirname, '..', 'migrations', '2026-09-26-hal-vote-first-pass.sql'),
      'utf8',
    );
    for (const col of ['host', 'first_pass_verdict', 'first_pass_at', 'post_hal_verdict', 'post_hal_at']) {
      expect(sql).toContain(col);
    }
    const db = client('missing');
    const res = await writePassVote(db, GOOD, OPEN);
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe('columns-missing');
    expect(db.inserts).toHaveLength(0);
  });

  it('stays closed unless the flag is the exact string true', async () => {
    const input = GOOD;
    for (const value of [undefined, 'TRUE', 'on', '1', '']) {
      const db = client();
      const env = value === undefined ? {} : { HAL_QUORUM_RECEIPT_ENABLED: value };
      const res = await writePassVote(db, input, env);
      expect(res.written).toBe(false);
      expect(res.skippedReason).toBe('flag-off');
      expect(db.inserts).toHaveLength(0);
    }
  });
});
