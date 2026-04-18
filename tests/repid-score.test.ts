import request from 'supertest';
import app from '../src/index';

describe('RepID Score Endpoint', () => {
  it('should return 404 for invalid agent (with no auth)', async () => {
    const res = await request(app).get('/api/v1/repid/not-found-id');
    expect(res.status).toBe(404); // passes because auth is bypassed
  });
});
