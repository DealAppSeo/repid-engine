/**
 * WHAT ACTUALLY STOPS A KEYLESS BUILDER FROM EARNING REPID — and it is not what the code says.
 *
 * `POST /api/v1/builder/token-signup` is on the auth bypass list: anyone can create a
 * `token_only` builder with no credential. `anonymous-signup.ts` explains why that is safe as:
 *
 *     earns_repid_rewards = false   (cannot accrue RepID; mint ERC-7231 to upgrade)
 *
 * THAT FLAG ENFORCES NOTHING. Measured 2026-08-29: `earns_repid_rewards` is read in exactly one
 * place in the whole codebase — `builder-dashboard.ts`, which echoes it into a response body. No
 * scoring path, no gate, no branch. `repid-update.ts` never reads a builder row at all.
 *
 * The containment is real but structural, and lives somewhere else entirely:
 *
 *   RepID accrues to AGENTS (`repid_agents`), not to builders.
 *   The only way to get an agent is `POST /api/v1/builder/create-agent`.
 *   That route is behind `requireFullAccount`, which verifies a SIGNED login token.
 *   Only the OTP path mints one. A `token_only` builder holds a random `session_token`,
 *   which is not a signed token and cannot be made into one.
 *
 * `createBuilderAgent` itself checks only that the builder EXISTS — not its auth_method, not its
 * email, not that flag. So the route guard is the entire control. That is why it is pinned here
 * rather than left as a comment: a comment that names the wrong mechanism invites someone to
 * remove the right one, or to add a second creation path believing the flag still covers them.
 */
import express from 'express';
import request from 'supertest';


// --- source-derived route lists ------------------------------------------------------------
// Read from the file rather than restated here, so this suite tracks the router instead of a
// snapshot of it.
import { readFileSync } from 'fs';
import { join } from 'path';

const routerSrc = readFileSync(join(__dirname, '../src/routes/full-account.ts'), 'utf8');

/** EVERY POST route on this router, guarded or not. */
function allPostPaths(): string[] {
  return [...routerSrc.matchAll(/router\.post\(\s*'([^']+)'/g)].map((m) => `/api/v1${m[1]}`);
}

/** Those carrying `requireFullAccount`. */
function guardedPaths(): string[] {
  return [...routerSrc.matchAll(/router\.post\(\s*'([^']+)'\s*,\s*requireFullAccount/g)].map(
    (m) => `/api/v1${m[1]}`,
  );
}

/**
 * Routes on this router that are deliberately NOT behind `requireFullAccount`.
 *
 * Adding a path here is the explicit act of declaring it public. That is the point: the test
 * below asserts over ALL routes minus this list, so a new route is guarded-by-default and
 * anything else has to be written down by a human who thought about it.
 */
const DELIBERATELY_UNGUARDED = new Set([
  '/api/v1/builder/full-signup', // retired -> 410
  '/api/v1/builder/login',       // retired -> 410
]);

/** Every POST route that answers with the retirement body. */
function retiredPaths(): string[] {
  return [...routerSrc.matchAll(/router\.post\(\s*'([^']+)'[^)]*?\)\s*=>\s*\{[\s\S]{0,200}?PASSWORD_PATH_RETIRED/g)].map(
    (m) => `/api/v1${m[1]}`,
  );
}

function agentGateSource(): string {
  return readFileSync(join(__dirname, '../src/routes/agent-gate.ts'), 'utf8');
}

const tables: Record<string, any> = {};
function makeQuery() {
  const q: any = {
    select: () => q, eq: () => q, ilike: () => q, is: () => q, in: () => q, order: () => q,
    limit: () => q,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => Promise.resolve({ data: null, error: null }),
    insert: () => q, update: () => q,
    then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
  };
  return q;
}
jest.mock('../src/db', () => ({ db: { from: () => makeQuery() } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../src/routes/full-account').default;
const app = express();
app.use(express.json());
app.use('/api/v1', router);

describe('the keyless builder cannot reach agent creation', () => {
  it('no credential at all is refused', async () => {
    const res = await request(app)
      .post('/api/v1/builder/create-agent')
      .send({ agent_name: 'x' });
    expect(res.status).toBe(401);
    expect(String(res.body.error)).toMatch(/login_token/i);
  });

  it('A RAW SESSION TOKEN IS REFUSED — this is the case that matters', async () => {
    // Exactly what POST /builder/token-signup hands out: 32 random bytes, hex. It is a real
    // credential for its own rung and it must not be mistaken for a login token.
    const sessionTokenShaped = 'a'.repeat(64);
    const res = await request(app)
      .post('/api/v1/builder/create-agent')
      .set('Authorization', `Bearer ${sessionTokenShaped}`)
      .send({ agent_name: 'x' });
    expect(res.status).toBe(401);
    expect(String(res.body.error)).toMatch(/invalid login_token/i);
  });

  it('an unsigned JWT-shaped token is refused too — shape is not signature', async () => {
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      '{"builder_id":"b1","email":"a@b.c"}',
    ).toString('base64url')}.`;
    const res = await request(app)
      .post('/api/v1/builder/create-agent')
      .set('Authorization', `Bearer ${unsigned}`)
      .send({ agent_name: 'x' });
    expect(res.status).toBe(401);
  });

  it('EVERY route is guarded unless it is written down as deliberately public', async () => {
    // INVERTED ON PURPOSE, and the first draft of this test had it the wrong way round.
    //
    // Asserting over `guardedPaths()` — the routes that HAVE the guard — is self-narrowing: strip
    // `requireFullAccount` off a route and it simply leaves the list, so the suite goes green over
    // a hole it was written to catch. Verified by doing exactly that: the direct cases below went
    // red, and the derived one did not.
    //
    // Over ALL routes minus an explicit allowlist, both failures are caught: removing a guard
    // leaves the route in the set and it 200s, and a NEW route is covered the moment it is added.
    for (const path of allPostPaths()) {
      if (DELIBERATELY_UNGUARDED.has(path)) continue;
      const res = await request(app).post(path).send({});
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });

  it('the derivation found routes at all — a silent zero would make the test above vacuous', () => {
    expect(allPostPaths().length).toBeGreaterThan(5);
    expect(guardedPaths().length).toBeGreaterThan(3);
  });

  it('the allowlist has no stale entries — every named path still exists on the router', () => {
    // An allowlist naming a deleted route is a hole waiting for that name to be reused.
    for (const p of DELIBERATELY_UNGUARDED) expect(allPostPaths()).toContain(p);
  });
});

describe('the retired password paths stay retired', () => {
  it('every retired path answers 410 and names a REAL OTP endpoint', async () => {
    const paths = retiredPaths();
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      const res = await request(app).post(p).send({ email: 'a@b.c', password: 'x' });
      expect({ p, status: res.status }).toEqual({ p, status: 410 });
      expect(res.body.error).toBe('password_signup_retired');
      // The named replacement must EXIST. An earlier version of this retirement pointed at
      // `request-code`/`verify-code`, which were never real endpoints — a 410 that sends you
      // to a 404 is worse than no message.
      for (const named of String(res.body.use_instead).match(/\/api\/v1\/[\w/-]+/g) ?? []) {
        expect(agentGateSource()).toContain(named.replace('/api/v1', ''));
      }
    }
  });
});
