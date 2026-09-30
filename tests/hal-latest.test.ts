import express from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { halLatestCard } from '../src/routes/hal-latest';

const state: { row: Record<string, unknown> | null; error: { message: string } | null } = {
  row: null,
  error: null,
};

jest.mock('../src/db', () => ({
  db: {
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () => ({
            maybeSingle: async () => ({ data: state.row, error: state.error }),
          }),
        }),
      }),
    }),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const halLatestRouter = require('../src/routes/hal-latest').default;

const app = express();
app.use('/api/v1', halLatestRouter);

describe('GET /api/v1/receipt/hal-latest', () => {
  it('returns the last vote fields', async () => {
    state.error = null;
    state.row = {
      family: 'llama',
      host: 'groq',
      provider: 'groq',
      verdict: 'FALSE',
      created_at: '2026-09-29T00:00:00.000Z',
    };
    const res = await request(app).get('/api/v1/receipt/hal-latest');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      family: 'llama',
      host: 'groq',
      verdict: 'FALSE',
      created_at: '2026-09-29T00:00:00.000Z',
    });
    expect(Object.keys(res.body).sort()).toEqual(['created_at', 'family', 'host', 'verdict']);
    expect(JSON.stringify(res.body)).not.toContain('user_id');
    expect(JSON.stringify(res.body)).not.toContain('claim');
  });

  it('404s when no vote exists', async () => {
    state.error = null;
    state.row = null;
    const res = await request(app).get('/api/v1/receipt/hal-latest');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('404s when the read fails', async () => {
    state.row = null;
    state.error = { message: 'relation missing' };
    const res = await request(app).get('/api/v1/receipt/hal-latest');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('relation');
  });

  it('uses provider as host when host is empty', () => {
    const card = halLatestCard({
      family: 'llama',
      host: '',
      provider: 'groq',
      verdict: 'TRUE',
      created_at: '2026-09-29T00:00:00.000Z',
    });
    expect(card).toEqual({
      family: 'llama',
      host: 'groq',
      verdict: 'TRUE',
      created_at: '2026-09-29T00:00:00.000Z',
    });
  });

  it('is mounted before the parameterised receipt route and selects no prose', () => {
    const index = readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const latest = index.indexOf('halLatestRouter');
    const receipt = index.indexOf('receiptPublicRouter');
    expect(latest).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(latest);
    const route = readFileSync(path.join(__dirname, '..', 'src', 'routes', 'hal-latest.ts'), 'utf8');
    const select = route.slice(route.indexOf('.select('), route.indexOf('.order('));
    expect(select).not.toContain('user_id');
    expect(select).not.toContain('claim');
  });
});