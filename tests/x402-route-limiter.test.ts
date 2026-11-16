/**
 * The per-route limiter on POST /api/v1/x402/:uuid/trade-analysis (`x402RouteLimiter`,
 * src/routes/x402-inbound.ts), on its own. The global token bucket is switched off here, so a 429
 * can only come from the route limiter. Its own file so its store starts empty.
 * The global limiter's coverage of this route is tested in tests/x402-v2-conformance.test.ts.
 */
import request from 'supertest';
import app from '../src/index';
import { db } from '../src/db';
import { X402_ROUTE_LIMIT_PER_MIN } from '../src/routes/x402-inbound';

// jest.mock is hoisted above the imports, so src/index.ts mounts the switched-off global limiter.
jest.mock('../src/middleware/rate-limit', () => ({
  ...jest.requireActual('../src/middleware/rate-limit'),
  rateLimitMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../src/db', () => ({
  db: { from: jest.fn(), rpc: jest.fn().mockResolvedValue({ data: null, error: null }) },
}));

jest.setTimeout(120_000);

const ROUTE = '/api/v1/x402/11111111-2222-3333-4444-555555555555/trade-analysis';

beforeEach(() => {
  (db.from as jest.Mock).mockImplementation(() => {
    const chain: any = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      maybeSingle: jest.fn(async () => ({
        data: { id: 'a', agent_name: 'SOPHIA', wallet_address: '0x2222222222222222222222222222222222222222', current_repid: 1, tier: 'X' },
        error: null,
      })),
      then: (r: any) => r({ data: [], error: null }),
    };
    return chain;
  });
});

it(`refuses request ${X402_ROUTE_LIMIT_PER_MIN + 1} from one IP inside a minute, with the global limiter off`, async () => {
  const first = await request(app).post(ROUTE).send({});
  expect(first.status).toBe(402);
  expect(first.headers['x-ratelimit-bucket']).toBeUndefined(); // the global limiter really is off
  expect(Number(first.headers['ratelimit-limit'])).toBe(X402_ROUTE_LIMIT_PER_MIN);

  for (let i = 2; i <= X402_ROUTE_LIMIT_PER_MIN; i++) {
    const r = await request(app).post(ROUTE).send({});
    expect(r.status).toBe(402);
  }
  const over = await request(app).post(ROUTE).send({});
  expect(over.status).toBe(429);
  expect(over.body).toEqual({ error: 'rate_limited', bucket: 'x402-route', limit: X402_ROUTE_LIMIT_PER_MIN });
  expect(over.headers['payment-required']).toBeUndefined(); // refused before the handler ran
});
