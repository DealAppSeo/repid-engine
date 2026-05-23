/**
 * POST /api/v1/hal/evaluate route tests (supertest, mocked halService).
 */
jest.mock('../../src/hal/service', () => ({
  halService: {
    evaluate: jest.fn(async (req: any) => (global as any).__svc ?? { hal_score: 0.1, decision: 'clean', mode: 'fact-check', strictness: req.strictness ?? 2, product: 'default', signals: {}, latency_ms: 5 }),
  },
}));

import express from 'express';
import request from 'supertest';
import halEvaluateRouter from '../../src/routes/hal-evaluate';
import { halService } from '../../src/hal/service';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/hal', halEvaluateRouter);
  return a;
}

beforeEach(() => {
  (halService.evaluate as jest.Mock).mockClear();
  (global as any).__svc = null;
});

describe('POST /api/v1/hal/evaluate', () => {
  test('valid text → 200 + evaluation', async () => {
    const res = await request(app()).post('/api/v1/hal/evaluate').send({ text: 'The capital of France is Paris.' });
    expect(res.status).toBe(200);
    expect(res.body.decision).toBe('clean');
    expect(res.body.mode).toBe('fact-check');
    expect(halService.evaluate as jest.Mock).toHaveBeenCalledTimes(1);
  });

  test('missing text → 400', async () => {
    const res = await request(app()).post('/api/v1/hal/evaluate').send({ context: { product: 'trustshell' } });
    expect(res.status).toBe(400);
    expect(halService.evaluate as jest.Mock).not.toHaveBeenCalled();
  });

  test('empty text → 400', async () => {
    const res = await request(app()).post('/api/v1/hal/evaluate').send({ text: '   ' });
    expect(res.status).toBe(400);
  });

  test('over-long text → 400', async () => {
    const res = await request(app()).post('/api/v1/hal/evaluate').send({ text: 'x'.repeat(8001) });
    expect(res.status).toBe(400);
  });

  test('strictness passed through (2)', async () => {
    await request(app()).post('/api/v1/hal/evaluate').send({ text: 'x', strictness: 2 });
    expect((halService.evaluate as jest.Mock).mock.calls[0][0].strictness).toBe(2);
  });

  test('service throw → 500', async () => {
    (halService.evaluate as jest.Mock).mockImplementationOnce(async () => { throw new Error('boom'); });
    const res = await request(app()).post('/api/v1/hal/evaluate').send({ text: 'x' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('hal_evaluation_failed');
  });
});
