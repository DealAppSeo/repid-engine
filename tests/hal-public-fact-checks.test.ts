/**
 * hal_public_fact_checks — the source-tagged PUBLIC fact-check counter (CC 2026-07-20).
 *
 * Covers:
 *   1. POST /api/v1/hal/evaluate writes ONE fire-and-forget row into hal_public_fact_checks after a
 *      successful fresh evaluation (source/verdict/hal_score/prompt_hash), defaulting source→'api'
 *      and coercing an unknown source→'api', and honoring an explicit valid source.
 *   2. The counter write NEVER blocks or fails the response (fire-and-forget; error swallowed).
 *   3. GET /api/v1/hal/fact-check-count returns { total, by_source, last_updated } and fails LOUD
 *      (500) on a query error.
 *
 * db is mocked via a call-time global handle (no jest hoist/TDZ). halService + hal-cache are mocked
 * so no LLM/redis is touched. No auth middleware is mounted, matching the pre-auth public mount.
 */
jest.mock('../src/db', () => ({
  get db() {
    return (global as any).__hpfcDb;
  },
}));

jest.mock('../src/hal/service', () => ({
  halService: {
    evaluate: (...args: any[]) => (global as any).__hpfcEvaluate(...args),
  },
}));

jest.mock('../src/cache/hal-cache', () => ({
  getCachedHalResult: async () => (global as any).__hpfcCached ?? null,
  cacheHalResult: async () => undefined,
}));

import request from 'supertest';
import express from 'express';
import { createHash } from 'crypto';
import halEvaluateRouter from '../src/routes/hal-evaluate';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/hal', halEvaluateRouter);
  return app;
}

/**
 * Mock db supporting both code paths:
 *  - insert: db.from(t).insert(payload).then(onF, onR)  → records payload, resolves {error}
 *  - count : db.from(t).select('*', {count,head}).eq('source', s) → resolves {count, error}
 */
function makeDb(opts: {
  countBySource?: Record<string, number>;
  countError?: { message: string } | null;
  insertError?: { message: string } | null;
} = {}) {
  const inserts: any[] = [];
  const countBySource = opts.countBySource ?? {};
  const countError = opts.countError ?? null;
  const insertError = opts.insertError ?? null;

  const builder: any = {
    insert: (payload: any) => {
      inserts.push(payload);
      return Promise.resolve({ data: null, error: insertError });
    },
    select: () => builder,
    eq: (_col: string, val: string) =>
      Promise.resolve({ count: countError ? null : (countBySource[val] ?? 0), error: countError }),
  };
  return {
    _inserts: () => inserts,
    from: () => builder,
  };
}

const CLEAN_RESULT = { hal_score: 0.12, decision: 'clean', mode: 'fact-check', strictness: 2, product: 'default', signals: {}, latency_ms: 5 };

beforeEach(() => {
  (global as any).__hpfcCached = null;
  (global as any).__hpfcEvaluate = jest.fn(async () => CLEAN_RESULT);
});

describe('POST /api/v1/hal/evaluate → hal_public_fact_checks counter', () => {
  test('records one row with source=api (default) and sha256 prompt_hash after a fresh evaluation', async () => {
    const db = makeDb();
    (global as any).__hpfcDb = db;
    const text = 'The capital of France is Paris.';

    const res = await request(makeApp()).post('/api/v1/hal/evaluate').send({ text });

    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('clean');
    // Fire-and-forget insert is issued synchronously in the handler, so it is already captured.
    const rows = db._inserts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'api',
      verdict: 'clean',
      hal_score: 0.12,
      prompt_hash: createHash('sha256').update(text).digest('hex'),
    });
  });

  test('honors an explicit valid source', async () => {
    const db = makeDb();
    (global as any).__hpfcDb = db;
    const res = await request(makeApp()).post('/api/v1/hal/evaluate').send({ text: 'hello world', source: 'aidebate' });
    expect(res.status).toBe(200);
    expect(db._inserts()[0].source).toBe('aidebate');
  });

  test('coerces an unknown source to api (never fails the CHECK constraint)', async () => {
    const db = makeDb();
    (global as any).__hpfcDb = db;
    const res = await request(makeApp()).post('/api/v1/hal/evaluate').send({ text: 'hello world', source: 'evil-drop-table' });
    expect(res.status).toBe(200);
    expect(db._inserts()[0].source).toBe('api');
  });

  test('does NOT re-count a cached (already-recorded) evaluation', async () => {
    const db = makeDb();
    (global as any).__hpfcDb = db;
    (global as any).__hpfcCached = CLEAN_RESULT; // cache hit short-circuits before the counter write
    const res = await request(makeApp()).post('/api/v1/hal/evaluate').send({ text: 'cached please' });
    expect(res.status).toBe(200);
    expect(db._inserts()).toHaveLength(0);
  });

  test('a counter-write error never fails the response (fire-and-forget)', async () => {
    const db = makeDb({ insertError: { message: 'insert boom' } });
    (global as any).__hpfcDb = db;
    const res = await request(makeApp()).post('/api/v1/hal/evaluate').send({ text: 'still works' });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('clean');
  });

  test('rejects empty text with 400 and writes nothing', async () => {
    const db = makeDb();
    (global as any).__hpfcDb = db;
    const res = await request(makeApp()).post('/api/v1/hal/evaluate').send({ text: '   ' });
    expect(res.status).toBe(400);
    expect(db._inserts()).toHaveLength(0);
  });
});

describe('GET /api/v1/hal/fact-check-count', () => {
  test('returns total + by_source (all four keys) + last_updated', async () => {
    (global as any).__hpfcDb = makeDb({ countBySource: { api: 3, eval: 2, aidebate: 1, trustchat: 0 } });
    const res = await request(makeApp()).get('/api/v1/hal/fact-check-count');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(6);
    expect(res.body.by_source).toEqual({ api: 3, eval: 2, aidebate: 1, trustchat: 0 });
    expect(typeof res.body.last_updated).toBe('string');
  });

  test('fails loud with 500 on a query error (not a silent zero)', async () => {
    (global as any).__hpfcDb = makeDb({ countError: { message: 'count boom' } });
    const res = await request(makeApp()).get('/api/v1/hal/fact-check-count');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('fact_check_count_failed');
  });
});
