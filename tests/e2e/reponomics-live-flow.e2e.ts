/**
 * E2E test against the live Railway deployment.
 *
 * Hits the deployed repid-engine and walks the no-wallet visitor flow:
 *   1. POST /api/v1/builder/token-signup     →  token + 0xdead0e707 address
 *   2. POST /api/v1/stake/deposit            →  authority bump
 *   3. POST /api/v1/demo/run-round-anonymous →  round result with deltas
 *   4. GET  /api/v1/demo/two-builder/snapshot →  Builder W and M with non-zero authority
 *
 * Unit tests are mocked, so deployment-environment-specific bugs (auth
 * misconfig, DB schema drift, missing env vars on Railway, CORS) only
 * show up here.
 *
 * Each step is its own `it`. If the deployment is missing the public
 * auth bypass for an endpoint, the relevant step soft-skips with a
 * recorded reason so the suite still produces a useful diagnostic
 * report instead of failing opaquely.
 *
 * NOT included in the default test run. Invoke via:
 *
 *   npm run test:e2e
 *
 * Environment:
 *   E2E_BASE_URL   override target (default: production Railway)
 *   E2E_API_KEY    optional REPID API key for endpoints that still
 *                  require authentication on the deployed build
 */

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://repid-engine-production.up.railway.app';
const API_KEY = process.env.E2E_API_KEY ?? '';
const HTTP_TIMEOUT_MS = 30_000;
// Post-rollout mode: a tolerated skip becomes a failure. Turn this on once the
// deployment is expected to be caught up — which is the normal steady state.
const STRICT = /^(1|true|yes)$/i.test(process.env.E2E_STRICT ?? '');

/**
 * THE VERIFICATION LEDGER — why this exists.
 *
 * Returning early from an `it()` marks it PASSED. Every soft-skip below was
 * therefore reported as a green tick, and the more broken the deployment, the
 * more steps skipped, so the greener the suite got.
 *
 * Measured against stub deployments before this ledger existed:
 *   every route 404  -> 3 of 6 passed
 *   every route 401  -> 4 of 6 passed
 *   public GETs live + every business endpoint 401
 *                    -> 6 of 6 passed, exit 0, SUITE GREEN
 *
 * That last one is the documented "rollout window". A fully green run against
 * a service that never issued a token, never took a deposit, never ran a round
 * and reported zero authority. The output said the flow worked; nothing in the
 * flow had been executed.
 *
 * The soft-skip tolerance itself is deliberate and stays — a readable
 * diagnostic beats a wall of red while Railway catches up. What changes is that
 * a skip is now RECORDED and SURFACED, and a run that verified none of the core
 * flow can no longer end green. Same three-outcome rule the rest of this
 * codebase already uses (HAL's SKIPPED, the release workflow's NOT CHECKED):
 * verified, not-checked and failed are three different things, and "we did not
 * look" must never render as "it passed".
 */
type Outcome = 'VERIFIED' | 'NOT CHECKED' | 'FAILED';
const ledger: Array<{ step: string; outcome: Outcome; detail: string; core: boolean }> = [];

/** Steps that constitute the actual product flow. Reachability is not the flow. */
const CORE_STEPS = new Set(['token-signup', 'stake/deposit', 'run-round-anonymous']);

function record(step: string, outcome: Outcome, detail: string): void {
  ledger.push({ step, outcome, detail, core: CORE_STEPS.has(step) });
}

/**
 * Record a tolerated skip. In strict mode this throws, turning the tolerance
 * off in one place rather than at every call site.
 */
function skipped(step: string, detail: string): void {
  record(step, 'NOT CHECKED', detail);
  // eslint-disable-next-line no-console
  console.warn(`[e2e] NOT CHECKED — ${step}: ${detail}`);
  if (STRICT) {
    throw new Error(
      `E2E_STRICT: "${step}" was not verified (${detail}). ` +
        `Strict mode treats an unverified step as a failure.`,
    );
  }
}

interface LiveResponse<T = any> {
  status: number;
  body: T;
  err?: string;
}

async function liveFetch<T = any>(path: string, init: RequestInit = {}): Promise<LiveResponse<T>> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  // OFFER THE SESSION TOKEN STEP 1 MINTED. `ctx.token` was assigned and never read by
  // anything — the suite signed up, stored the credential, and then made every
  // subsequent call anonymously. So the deposit step could only ever 401, and its
  // 401 meant "no credential was sent", not "the credential was refused". Those are
  // different findings and only one of them is about the server.
  //
  // Offering it loosens NOTHING server-side; it makes the evidence say which case
  // this is. E2E_API_KEY still wins when set, since an operator key is the stronger
  // credential and is what a caller supplies deliberately.
  const bearer = API_KEY || ctx.token;
  if (bearer && !headers.has('authorization')) headers.set('authorization', `Bearer ${bearer}`);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { ...init, headers, signal: ctrl.signal });
    let body: any = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    return { status: res.status, body };
  } catch (e: any) {
    return { status: 0, body: null as any, err: e?.message ?? String(e) };
  } finally {
    clearTimeout(t);
  }
}

// Shared state between steps — populated by step 1, consumed by step 2.
const ctx: { token?: string; builder_address?: string; builder_id?: string; deposit_ok?: boolean } = {};

describe('e2e — reponomics live flow against Railway', () => {
  beforeAll(() => {
    // eslint-disable-next-line no-console
    console.log(`[e2e] target = ${BASE_URL}`);
  });

  it('GET /api/v1/health — service is reachable', async () => {
    const r = await liveFetch('/api/v1/health');
    // health is auth-gated on the current production build (returns 401).
    // 200 and 401 both prove the service is reachable; connection/TLS errors
    // do not. Recorded separately, because a 401 proves reachability and
    // NOTHING about health — reporting that as a passing health check is the
    // same conflation this ledger exists to stop.
    if (r.status === 0) {
      record('health', 'FAILED', `unreachable: ${r.err ?? 'connection error'}`);
    } else if (r.status === 200) {
      record('health', 'VERIFIED', 'HTTP 200, status=ok');
    } else if (r.status === 401) {
      record('health', 'NOT CHECKED', 'HTTP 401 — reachable, but health not asserted (auth-gated)');
    } else {
      record('health', 'FAILED', `unexpected HTTP ${r.status}`);
    }
    expect(r.status === 200 || r.status === 401).toBe(true);
    if (r.status === 200) {
      expect(r.body).toMatchObject({ status: 'ok' });
    }
  });

  it('POST /api/v1/builder/token-signup returns a token + 0xdead0e707 address (or skips if not deployed)', async () => {
    const r = await liveFetch('/api/v1/builder/token-signup', { method: 'POST', body: JSON.stringify({}) });
    if (r.status === 401 || r.status === 404) {
      skipped('token-signup', `HTTP ${r.status} — public endpoint not deployed yet`);
      return;
    }
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.token).toBe('string');
    expect(r.body.token.length).toBeGreaterThanOrEqual(64);
    // Either the new hex-clean marker (post-Phase-2) or the legacy T0KEN
    // marker (pre-Phase-2) — accept both during the rollout window.
    expect(r.body.builder_address).toMatch(/^0x(dead0e707|T0KEN)/);
    expect(r.body.repid_rewards_eligible).toBe(false);
    ctx.token = r.body.token;
    ctx.builder_address = r.body.builder_address;
    ctx.builder_id = r.body.builder_id;
    record('token-signup', 'VERIFIED', `token issued, address ${r.body.builder_address}`);
  });

  it('POST /api/v1/stake/deposit accepts a deposit and bumps authority (or skips if signup unavailable)', async () => {
    if (!ctx.builder_address) {
      // A CASCADE, not a deployment gap: this step is unverified because the
      // one before it did not produce an address. Worth distinguishing —
      // under a total outage this exact branch was the single green tick in
      // an otherwise red suite, passing precisely BECAUSE upstream broke.
      skipped('stake/deposit', 'cascade — step 2 produced no builder_address');
      return;
    }
    const r = await liveFetch('/api/v1/stake/deposit', {
      method: 'POST',
      body: JSON.stringify({ builder_address: ctx.builder_address, amount: '100000000' }),
    });
    if (r.status === 404) {
      skipped('stake/deposit', 'HTTP 404 — endpoint not deployed');
      return;
    }
    if (r.status === 401) {
      // THIS USED TO READ "public endpoint not deployed", AND THAT WAS WRONG IN A WAY
      // THAT COSTS SOMEONE AN HOUR. MEASURED against production 2026-08-28: the route
      // IS deployed and IS auth-bypassed at the middleware (src/middleware/auth.ts —
      // "serves BOTH signed-out demo traffic and wallet-bearing real"). The 401 comes
      // from INSIDE the handler, and it is correct behaviour, not an outage.
      //
      // What it actually reveals is a seam between two credential systems:
      //   /builder/token-signup mints 32 random bytes and stores them in
      //     builders.session_token (auth_method 'token_only'). Four routes in v1.ts
      //     resolve a builder by that column, so it is a real, used credential.
      //   /stake/deposit's session tier calls verifyFullAccountToken(), which is
      //     jwt.verify() requiring builder_id AND email — a full account.
      // An anonymous visitor has no email by construction, so the no-wallet flow this
      // suite is named after cannot clear the session tier at all. The reason string
      // now carries whichever of the two the server reported, so the diagnosis points
      // at the seam instead of at a deployment.
      const why = r.body?.error === 'invalid_session'
        ? 'the signup token WAS sent and was refused (invalid_session) — /stake/deposit ' +
          'verifies full-account JWTs only and never consults builders.session_token'
        : r.body?.error === 'no_credential'
          ? 'no credential reached the handler (no_credential) — step 2 sent nothing usable'
          : `server said ${JSON.stringify(r.body?.error ?? null)}`;
      skipped('stake/deposit', `HTTP 401 — endpoint deployed and refusing: ${why}`);
      return;
    }
    expect([200, 400]).toContain(r.status);
    if (r.status === 200) {
      expect(r.body.ok).toBe(true);
      ctx.deposit_ok = true;
      record('stake/deposit', 'VERIFIED', 'deposit accepted (HTTP 200)');
    } else {
      // 400 is a legitimate business rejection — the endpoint ran and decided.
      record('stake/deposit', 'VERIFIED', 'HTTP 400 — endpoint executed and rejected the deposit');
    }
  });

  it('POST /api/v1/demo/run-round-anonymous returns a round result with deltas (or skips)', async () => {
    const r = await liveFetch('/api/v1/demo/run-round-anonymous', {
      method: 'POST',
      body: JSON.stringify({ wait_ms: 0 }),
    });
    if (r.status === 401) {
      skipped('run-round-anonymous', 'HTTP 401 — public bypass not deployed');
      return;
    }
    if (r.status === 404) {
      skipped('run-round-anonymous', 'HTTP 404 — endpoint not deployed yet');
      return;
    }
    // A MISSING FIXTURE IS NOT A BROKEN ENDPOINT, and scoring it as one is the same
    // conflation as the reverse. MEASURED against production 2026-08-28: HTTP 400 with
    //
    //   {"ok":false,"error":"fleet agents missing","is_simulated":true,
    //    "notes":"APM or VERITAS not seeded — apply 20260427_seed_two_builder_demo.sql first"}
    //
    // The endpoint ran, looked for its two demo agents, did not find them, and said so
    // precisely — naming the exact migration. That is a well-built refusal, and this
    // suite was calling it FAILED. The step's own comment two lines below already
    // anticipated the seed being absent ("apm and veritas may be null if seed agents
    // are absent on this DB") but only on the 200 path, so the anticipated case was
    // the one case that could not be reported.
    //
    // A red E2E for an unapplied demo seed teaches people that red does not mean
    // broken, which is exactly how the green-that-means-nothing at the top of this
    // file happened, arriving from the other direction. STRICT still turns it into a
    // failure, which is what STRICT is for: this remains a CORE step, so a run that
    // never exercised it cannot claim the flow works.
    if (r.status === 400 && r.body?.error === 'fleet agents missing') {
      skipped(
        'run-round-anonymous',
        'HTTP 400 — endpoint executed and refused: demo agents APM/VERITAS are not seeded ' +
          'on this database. Remedy is named by the server: apply ' +
          'supabase/migrations/20260427_seed_two_builder_demo.sql. This is a data gap, not a defect.',
      );
      return;
    }
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.round_id).toBe('string');
    // apm and veritas may be null if seed agents are absent on this DB,
    // but if present they must carry repid_before/after/delta.
    if (r.body.apm) {
      expect(typeof r.body.apm.repid_before).toBe('number');
      expect(typeof r.body.apm.repid_after).toBe('number');
      expect(typeof r.body.apm.delta).toBe('number');
    }
    if (r.body.veritas) {
      expect(typeof r.body.veritas.delta).toBe('number');
    }
    record('run-round-anonymous', 'VERIFIED', `round ${r.body.round_id} executed`);
  });

  it('GET /api/v1/demo/two-builder/snapshot returns Builder W + M with authority', async () => {
    const r = await liveFetch('/api/v1/demo/two-builder/snapshot');
    expect(r.status).toBe(200);
    expect(r.body).toBeTruthy();
    expect(r.body.builder_w).toBeTruthy();
    expect(r.body.builder_m).toBeTruthy();
    // Authority is a stringified bigint. Empty string or "0" both indicate
    // a cold demo — we only require the field to exist and be a string.
    expect(typeof r.body.builder_w.authority).toBe('string');
    expect(typeof r.body.builder_m.authority).toBe('string');
    // If Builder W is healthy (current_repid >= 5000) the floor passes
    // and authority should be > 0.
    if (Number(r.body.builder_w.current_repid) >= 5000) {
      expect(BigInt(r.body.builder_w.authority)).toBeGreaterThan(0n);
    }
    record('two-builder/snapshot', 'VERIFIED', 'snapshot shape ok for Builder W + M');
  });

  it('GET /api/v1/metrics is publicly readable', async () => {
    const r = await liveFetch('/api/v1/metrics');
    expect(r.status).toBe(200);
    expect(typeof r.body.agents).toBe('number');
    expect(typeof r.body.vdr).toBe('number');
    record('metrics', 'VERIFIED', `agents=${r.body.agents} vdr=${r.body.vdr}`);
  });

  /**
   * THE GUARD. Runs last, and is the reason a vacuous run can no longer be
   * green: the suite must have executed at least one step of the actual
   * product flow. Reachability, a public snapshot and a metrics counter can
   * all be served by a deployment where signup, staking and rounds are
   * entirely broken — that combination previously scored 6/6.
   *
   * This does not tighten what any individual step asserts. It asserts
   * something the per-step checks structurally cannot: that the run as a
   * whole looked at anything worth looking at.
   */
  it('GUARD — the run verified at least one core flow step', () => {
    const core = ledger.filter((l) => l.core);
    const verified = core.filter((l) => l.outcome === 'VERIFIED');
    if (verified.length === 0) {
      const detail = core.map((l) => `  - ${l.step}: ${l.outcome} (${l.detail})`).join('\n');
      throw new Error(
        'E2E VERIFIED NOTHING.\n\n' +
          'Every core flow step (token-signup, stake/deposit, run-round-anonymous) was\n' +
          'skipped or failed, so this run proves only that the host answered HTTP. A\n' +
          'green tick here would mean "the deployment works" — it does not.\n\n' +
          `Core step outcomes:\n${detail}\n\n` +
          'If the deployment is mid-rollout this is expected: re-run once Railway has\n' +
          'caught up. It is a failure because it is unverified, not because it is broken.',
      );
    }
    expect(verified.length).toBeGreaterThan(0);
  });

  afterAll(() => {
    const width = Math.max(...ledger.map((l) => l.step.length), 10);
    const lines = ledger.map(
      (l) => `  ${l.step.padEnd(width)}  ${l.outcome.padEnd(11)}  ${l.detail}`,
    );
    const n = (o: Outcome) => ledger.filter((l) => l.outcome === o).length;
    // eslint-disable-next-line no-console
    console.log(
      `\n[e2e] verification ledger — target ${BASE_URL}` +
        `${STRICT ? ' (STRICT)' : ''}\n${lines.join('\n')}\n` +
        `  ${'—'.repeat(width + 30)}\n` +
        `  VERIFIED ${n('VERIFIED')}   NOT CHECKED ${n('NOT CHECKED')}   FAILED ${n('FAILED')}\n` +
        (n('NOT CHECKED') > 0 && !STRICT
          ? '  Tolerated skips above are NOT evidence of a working deployment.\n' +
            '  Re-run with E2E_STRICT=1 once the rollout has landed.\n'
          : ''),
    );
  });
});
