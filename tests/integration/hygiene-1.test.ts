import request from 'supertest';
import app from '../../src/index';

describe('HYGIENE-1 — log noise suppression', () => {
  it('malformed JSON returns 400 (not crash)', async () => {
    const res = await request(app)
      .post('/api/v1/repid/verify')
      .set('Content-Type', 'application/json')
      .send('{this is not valid json');
    
    // The structured error handler should catch this and return 400
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid JSON in request body/i);
  });
});

describe('HYGIENE-1 — HAL benchmark gate', () => {
    it('RUN_HAL_BENCHMARK_ON_STARTUP is false by default', () => {
        expect(process.env.RUN_HAL_BENCHMARK_ON_STARTUP).toBeUndefined();
    });
});
