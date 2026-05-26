import request from 'supertest';
import app from '../../src/index';
import { getRedisClient, closeRedisClient } from '../../src/clients/redis-client';
import { bucketStore } from '../../src/middleware/rate-limit';

// Mock getRedisClient
jest.mock('../../src/clients/redis-client', () => {
  const mockRedis = {
    eval: jest.fn(),
    on: jest.fn(),
  };
  return {
    getRedisClient: () => mockRedis,
    closeRedisClient: jest.fn(),
  };
});

describe('Redis-Backed Rate Limiting', () => {
  const originalBackend = process.env.RATE_LIMIT_BACKEND;
  const mockRedis = getRedisClient() as any;

  beforeAll(() => {
    process.env.RATE_LIMIT_BACKEND = 'redis';
  });

  afterAll(async () => {
    process.env.RATE_LIMIT_BACKEND = originalBackend;
    await closeRedisClient();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    bucketStore.__reset();
  });

  it('allows request and returns correct headers when Redis allows it', async () => {
    // Lua script returns [allowed (1), remaining (9), retry_after_sec (0)]
    mockRedis.eval.mockResolvedValue([1, 9, 0]);

    const res = await request(app)
      .get('/api/v1/health');

    expect(res.status).toBeLessThan(500);
    expect(res.headers['x-ratelimit-limit']).toBe('60');
    expect(res.headers['x-ratelimit-remaining']).toBe('9');
    expect(res.headers['x-ratelimit-bucket']).toBe('ip');
    expect(mockRedis.eval).toHaveBeenCalled();
  });

  it('returns 429 when Redis rate limits the request', async () => {
    // Lua script returns [allowed (0), remaining (0), retry_after_sec (5)]
    mockRedis.eval.mockResolvedValue([0, 0, 5]);

    const res = await request(app)
      .get('/api/v1/health');

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(res.body.retry_after_seconds).toBe(5);
    expect(res.headers['retry-after']).toBe('5');
  });

  it('falls back to memory rate limiter when Redis throws an error', async () => {
    // Redis throws error
    mockRedis.eval.mockRejectedValue(new Error('Redis connection lost'));

    // Memory bucket starts full (capacity 60)
    // First request should succeed and return remaining 59 from memory bucket
    const res = await request(app)
      .get('/api/v1/health');

    expect(res.status).toBeLessThan(500);
    expect(res.headers['x-ratelimit-limit']).toBe('60');
    expect(res.headers['x-ratelimit-remaining']).toBe('59'); // consumed from memory fallback
  });
});
