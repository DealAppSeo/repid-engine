import express from 'express';
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
});
