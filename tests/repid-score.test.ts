import request from 'supertest';
import app from '../src/index';

jest.mock('../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null })
  }
}));

describe('RepID Score Endpoint', () => {
  it('should return 404 for invalid agent (with no auth)', async () => {
    const res = await request(app).get('/api/v1/repid/not-found-id');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ score: 'NOT_CHECKED', tier: 'NOT_CHECKED' });
    expect(res.body.score).not.toBe(0);
  });
});
