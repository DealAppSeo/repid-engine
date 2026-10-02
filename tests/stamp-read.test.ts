import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';

const calls: string[] = [];
const state: {
  row: Record<string, unknown> | null;
  error: { message: string } | null;
  throwRead: boolean;
} = {
  row: null,
  error: null,
  throwRead: false,
};

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      calls.push(`from:${table}`);
      const select = (cols: string) => {
        calls.push(`select:${cols}`);
        return {
          order: () => ({
            limit: () => ({
              maybeSingle: async () => {
                if (state.throwRead) throw new Error('read failed');
                return { data: state.row, error: state.error };
              },
            }),
          }),
        };
      };
      return {
        select,
        insert: () => {
          calls.push('insert');
          return { data: null, error: null };
        },
      };
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const stampReadRouter = require('../src/routes/stamp-read').default;

const app = express();
app.use('/api/v1/hal', stampReadRouter);

const MISS = { family: 'NOT_CHECKED', host: 'NOT_CHECKED', verdict: 'NOT_CHECKED' };

describe('GET /api/v1/hal/stamp', () => {
  it('reads a caught row, a pass row, and a failed read', async () => {
    state.throwRead = false;
    state.error = null;
    state.row = {
      family: 'llama',
      host: 'groq',
      verdict: 'caught',
      claim: 'The surgeon is the boy mother.',
      user_id: 'u1',
      score: 0,
    };
    const caught = await request(app).get('/api/v1/hal/stamp');
    expect(caught.status).toBe(200);
    expect(caught.body).toEqual({ family: 'llama', host: 'groq', verdict: 'caught' });
    expect(Object.keys(caught.body)).toEqual(['family', 'host', 'verdict']);
    expect(JSON.stringify(caught.body)).not.toContain('user_id');
    expect(JSON.stringify(caught.body)).not.toContain('surgeon');
    expect(JSON.stringify(caught.body)).not.toContain('0');

    state.row = { family: 'qwen', host: 'cerebras', verdict: 'pass', claim: 'One dollar is gone.', user_id: 'u2' };
    const passed = await request(app).get('/api/v1/hal/stamp');
    expect(passed.status).toBe(200);
    expect(passed.body).toEqual({ family: 'qwen', host: 'cerebras', verdict: 'pass' });
    expect(JSON.stringify(passed.body)).not.toContain('dollar');
    expect(JSON.stringify(passed.body)).not.toContain('user_id');

    state.row = { family: 'llama', host: 'groq', verdict: 'pass', claim: 'hidden', user_id: 'u3' };
    state.error = { message: 'relation missing' };
    const failed = await request(app).get('/api/v1/hal/stamp');
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual(MISS);
    expect(failed.body.verdict).not.toBe(0);
    expect(JSON.stringify(failed.body)).not.toContain('relation');
    expect(JSON.stringify(failed.body)).not.toContain('hidden');
    expect(JSON.stringify(failed.body)).not.toContain('user_id');

    state.error = null;
    state.row = null;
    state.throwRead = true;
    const thrown = await request(app).get('/api/v1/hal/stamp');
    expect(thrown.body).toEqual(MISS);
    expect(thrown.body.verdict).not.toBe(0);
  });

  it('prints first-pass and post-check for the ten fixture claims', async () => {
    const fixture = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'scripts', 'fixtures', 'hal-traps.json'), 'utf8'),
    ) as { claims: { trap: string; claim: string; first_pass_verdict: unknown; post_hal_verdict: unknown }[] };
    expect(fixture.claims).toHaveLength(10);

    async function throughRoute(claimText: string, verdict: unknown): Promise<string> {
      state.throwRead = false;
      state.error = null;
      state.row = { family: 'llama', host: 'groq', verdict, claim: claimText, user_id: 'u1' };
      const res = await request(app).get('/api/v1/hal/stamp');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['family', 'host', 'verdict']);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('user_id');
      expect(body).not.toContain(claimText);
      return String(res.body.verdict);
    }

    const lines = ['trap\tfirst-pass\tpost-check'];
    for (const claim of fixture.claims) {
      const firstPass = await throughRoute(claim.claim, claim.first_pass_verdict);
      const postCheck = await throughRoute(claim.claim, claim.post_hal_verdict);
      lines.push(`${claim.trap}\t${firstPass}\t${postCheck}`);
    }
    const table = `${lines.join('\n')}\n`;
    expect(table).toBe(
      [
        'trap\tfirst-pass\tpost-check',
        'surgeon\tpass\tcaught',
        'missing-dollar\tpass\tpass',
        'tuesday-boy\tpass\tcaught',
        'monty\tpass\tpass',
        'average-speed\tpass\tcaught',
        'disease\tpass\tpass',
        'ropes\tpass\tcaught',
        'two-envelope\tpass\tpass',
        'birthday\tpass\tpass',
        'ravens\tpass\tpass',
        '',
      ].join('\n'),
    );
    expect(table).not.toContain('\t0');

    const missFirst = await throughRoute('a missed claim', 0);
    const missPost = await throughRoute('a missed claim', '0');
    expect(`${missFirst}\t${missPost}`).toBe('NOT_CHECKED\tNOT_CHECKED');
    expect(missFirst).not.toBe(0);
    expect(missPost).not.toBe('0');
  });
});
