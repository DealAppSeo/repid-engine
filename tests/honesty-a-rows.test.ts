import express from 'express';
import request from 'supertest';

const state: { mode: 'rows' | 'missing-column' } = { mode: 'rows' };

jest.mock('../src/db', () => ({
  db: {
    from: () => ({
      select: () => ({
        gte: () => ({
          limit: async () => {
            if (state.mode === 'missing-column') {
              return { data: null, error: { message: 'column first_pass_verdict does not exist' } };
            }
            return {
              data: [
                {
                  family: 'llama',
                  provider: 'groq',
                  host: 'groq',
                  verdict: 'TRUE',
                  first_pass_verdict: 'FALSE',
                  post_hal_verdict: 'TRUE',
                },
              ],
              error: null,
            };
          },
        }),
      }),
    }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const honestyARouter = require('../src/routes/honesty-a').default;

const app = express();
app.use('/api/v1/hal', honestyARouter);

describe('GET /api/v1/hal/honesty-a rows', () => {
  it('includes first_pass counts when rows exist', async () => {
    state.mode = 'rows';
    const res = await request(app).get('/api/v1/hal/honesty-a');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('counted');
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].first_pass).toEqual({ TRUE: 0, FALSE: 1, NOT_CHECKED: 0 });
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('user_id');
    expect(json).not.toContain('email');
    expect(json).not.toContain('"claim"');
  });

  it('a missing column is NOT_CHECKED, never 0', async () => {
    state.mode = 'missing-column';
    const res = await request(app).get('/api/v1/hal/honesty-a');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('NOT_CHECKED');
    expect(res.body.rows).toBeNull();
    expect(res.body.first_pass).toBe('NOT_CHECKED');
    expect(res.body.first_pass).not.toBe(0);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain('user_id');
    expect(json).not.toContain('email');
  });
});
