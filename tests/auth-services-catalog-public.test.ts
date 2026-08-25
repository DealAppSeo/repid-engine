/**
 * The service catalog is a keyless READ, and only a read (2026-08-25).
 *
 * WHY IT WAS OPENED. A developer following the published quickstart could call
 * `verifyOutput()` and `getRepID()` against the live backend with no key — that is
 * the whole keyless promise — and then hit a 401 on `listServices()`, which is
 * step one of the discover→buy→receipt story the SDK is built around. The rows
 * behind it are already served to anyone at trustshell.dev/market, so the key was
 * gating a surface that was never private. Same reasoning as the TrustMarket
 * ratings bypass directly above it in auth.ts.
 *
 * WHY THIS TEST EXISTS AND WHAT IT IS REALLY GUARDING. The router under
 * /api/v1/services carries POST / (create a listing), PATCH /:id and DELETE /:id
 * alongside the three reads. The bypass is therefore method-gated, and the method
 * check IS the control: a `startsWith` without it opens the mutations too.
 *
 * So the load-bearing half of this file is the second describe block. It breaks
 * the moment someone widens the bypass — which is exactly the change that would
 * look harmless in review ("just simplify the path match") and would hand anyone
 * on the internet the ability to create, reprice and delete marketplace listings.
 * A test that only asserted the happy path would stay green through that.
 */
import { authMiddleware } from '../src/middleware/auth';

jest.mock('../src/db', () => ({ db: { from: () => ({}) } }));
jest.mock('../src/auth/api-keys', () => ({ validateAgentApiKey: jest.fn() }));
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn() }));

function call(method: string, path: string) {
  const req: any = { method, path, headers: {}, query: {}, body: {} };
  const res: any = {
    statusCode: 0,
    payload: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };
  const next = jest.fn();
  return { req, res, next };
}

/** Passed through to the route without a credential. */
async function passesKeyless(method: string, path: string): Promise<boolean> {
  const { req, res, next } = call(method, path);
  await authMiddleware(req, res, next);
  return next.mock.calls.length === 1 && res.statusCode === 0;
}

describe('GET /api/v1/services is reachable without a key', () => {
  it.each([
    ['the catalog listing', '/api/v1/services'],
    ['a single service', '/api/v1/services/2f1c9d84-0000-4000-8000-000000000001'],
    ['the category list', '/api/v1/services/categories'],
  ])('%s', async (_label, path) => {
    expect(await passesKeyless('GET', path)).toBe(true);
  });
});

describe('the same paths still require a key for anything that MUTATES', () => {
  // If any of these start passing, the bypass has been widened from a read to a
  // write and anyone on the internet can edit the marketplace. That is the
  // failure this file exists to catch, so these assertions must be able to fail:
  // each one is the exact request an attacker would send.
  it.each([
    ['create a listing', 'POST', '/api/v1/services'],
    ['reprice a listing', 'PATCH', '/api/v1/services/2f1c9d84-0000-4000-8000-000000000001'],
    ['delete a listing', 'DELETE', '/api/v1/services/2f1c9d84-0000-4000-8000-000000000001'],
    ['create via trailing slash', 'POST', '/api/v1/services/'],
  ])('%s is NOT keyless', async (_label, method, path) => {
    expect(await passesKeyless(method, path)).toBe(false);
  });
});

describe('the bypass does not leak onto neighbouring paths', () => {
  // `startsWith('/api/v1/services')` without the exact-match arm would also open
  // any future route whose path merely begins with those characters.
  it.each([
    ['a service-adjacent write surface', 'GET', '/api/v1/services-admin'],
    ['a private contracts route', 'GET', '/api/v1/service-contracts'],
  ])('%s is NOT keyless', async (_label, method, path) => {
    expect(await passesKeyless(method, path)).toBe(false);
  });
});
