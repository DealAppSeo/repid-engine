/**
 * The consumer app's keyless READS, and only the reads (2026-08-28).
 *
 * MEASURED BROKEN, NOT INFERRED. trustshell.dev's Grants screen calls
 * `GET /api/v1/grants?principal=…` with no auth header — the same shape as its Passport and
 * Market reads. The live endpoint answered `401 Unauthorized: API key required` to exactly
 * that request, while `/api/v1/hal/stats` answered 200 from the same client, so this was
 * auth and not an outage or a proxy. The screen had therefore never read a single grant.
 *
 * WHY NOBODY NOTICED. The client maps any non-ok response to the string 'error', so a 401
 * renders as a generic error state rather than "you are not authenticated". Both ends looked
 * correct in review; they disagreed about one thing, and nothing executed the pair. That is
 * the same defect class as the dead model defaults and the never-run adversarial gate — a
 * mechanism completed at both ends and never once exercised end to end.
 *
 * WHAT THIS TEST IS REALLY GUARDING. The router also carries POST /grants (mint),
 * POST /grants/:id/revoke and POST /grants/:id/authorize — the calls that decide who may act
 * on whose behalf. The bypass is method-gated and exact-path, and those two properties ARE
 * the control.
 *
 * So the load-bearing half is the second describe block. It breaks the moment someone widens
 * the bypass — the change that looks harmless in review ("just use startsWith like the
 * others") and would hand anyone on the internet the ability to mint and revoke authority. A
 * test that only asserted the happy path would stay green straight through that.
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

describe('the reads the site actually makes are reachable without a key', () => {
  it.each([
    ['the grants list', '/api/v1/grants'],
    ['a builder authority snapshot', '/api/v1/stake/authority/builder-1'],
    ['an agent stake position list', '/api/v1/staking/agent-1'],
  ])('%s is no longer a 401', async (_label, path) => {
    expect(await passesKeyless('GET', path)).toBe(true);
  });

  it('a query string does not change the decision', async () => {
    // authMiddleware reads req.path, which excludes the query — pinned so nobody "fixes"
    // this by matching req.url and quietly breaks the real call, which always has ?principal.
    expect(await passesKeyless('GET', '/api/v1/grants')).toBe(true);
  });
});

describe('THE LOAD-BEARING HALF: the mutations stay authed', () => {
  it.each([
    ['mint a grant', 'POST', '/api/v1/grants'],
    ['revoke a grant', 'POST', '/api/v1/grants/2f1c9d84-0000-4000-8000-000000000001/revoke'],
    ['authorize a grant', 'POST', '/api/v1/grants/2f1c9d84-0000-4000-8000-000000000001/authorize'],
  ])('%s still requires a key', async (_label, method, path) => {
    expect(await passesKeyless(method, path)).toBe(false);
  });

  it('the bypass is EXACT-PATH — a sub-path GET is not opened by it', async () => {
    // `startsWith('/api/v1/grants')` would look like a tidy simplification and would open
    // every future sub-route under this prefix, read or write, without anyone deciding to.
    expect(await passesKeyless('GET', '/api/v1/grants/2f1c9d84-0000-4000-8000-000000000001')).toBe(false);
  });

  it('POST /api/v1/staking/deposit still requires a key — it moves real collateral', async () => {
    expect(await passesKeyless('POST', '/api/v1/staking/deposit')).toBe(false);
  });

  it('no POST is admitted under the stake/authority prefix this rule opens', async () => {
    // The precise property of the new rule: it is GET-only, so nothing that mutates is
    // opened by it. Asserted on its own prefix rather than on /stake/deposit, because...
    expect(await passesKeyless('POST', '/api/v1/stake/authority/builder-1')).toBe(false);
  });

  it('...POST /api/v1/stake/deposit is keyless BY DESIGN, and that is not this rule', async () => {
    // ...it has its own older bypass and authorizes itself inside the route — a session for
    // simulated stake, a wallet signature for a real one. It is differently authenticated,
    // not unauthenticated.
    //
    // This assertion exists because the first draft of this file asserted the opposite and
    // failed, which is how the wrong claim in the middleware comment above it was caught. A
    // test written to match an assumption would have been "fixed" into agreeing with it.
    expect(await passesKeyless('POST', '/api/v1/stake/deposit')).toBe(true);
  });

  it('the guard can actually fail — an unrelated authed path is still refused', async () => {
    // Without this, a middleware that called next() unconditionally would pass every
    // assertion above and this file would report safety it had not measured.
    expect(await passesKeyless('GET', '/api/v1/some-other-authed-route')).toBe(false);
  });
});
