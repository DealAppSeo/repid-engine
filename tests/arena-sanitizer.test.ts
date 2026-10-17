/**
 * A game key is a P-256 JWK whose x and y are base64url, so '--' can appear in a perfectly good key.
 * The app-wide SQL-keyword sanitizer (src/index.ts) 400s any POST body holding '--', which would
 * refuse about 1 grant in 50 at random. Through the REAL app: an arena body with '--' must get past
 * the sanitizer (whatever the route then answers), and another route's body still does not.
 */
jest.mock('../src/db', () => {
  const chain: any = {
    select: () => chain, eq: () => chain, ilike: () => chain, is: () => chain, order: () => chain,
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: null, error: null }),
  };
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});

import request from 'supertest';
import app from '../src/index';

const jwkWithDashes = { kty: 'EC', crv: 'P-256', x: 'ab--' + 'c'.repeat(39), y: 'd'.repeat(43) };

describe('the SQL-keyword sanitizer does not refuse game keys', () => {
  beforeAll(() => { process.env.ARENA_ENABLED = 'true'; });
  afterAll(() => { delete process.env.ARENA_ENABLED; });

  it('an arena body containing -- reaches the arena', async () => {
    const r = await request(app).post('/api/v1/arena/challenges').send({ game_key: jwkWithDashes });
    expect(r.body.error).not.toBe('Validation failed');
  });

  it('the sanitizer still guards other routes', async () => {
    const r = await request(app).post('/api/v1/agents/some-agent/keys-not-a-route').send({ note: 'a -- b' });
    expect(r.body.error).toBe('Validation failed');
  });
});
