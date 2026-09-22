/**
 * When the direct-Postgres path dies, SOMETHING must say so.
 *
 * WHAT THIS PINS, and it is not hypothetical [MEASURED 2026-09-22]. Every pgQuery
 * caller in this project — the proof drain, the feedback loop, the EAS anchor
 * worker — had been failing `password authentication failed for user "postgres"`
 * for over two days. The proof queue reached 40,312 pending and was still growing.
 * And every surface a human looks at said fine:
 *
 *   Railway            all four services SUCCESS
 *   GET /health        200, `supabaseConnected: true` (it tests supabase-js, a
 *                      DIFFERENT path, and never touches Postgres directly)
 *   ops_alerts         not one row — `pageOperator` was wired only to the
 *                      canonical-WRITE-rejected branch, so a connection that never
 *                      opens paged nobody
 *
 * Two gaps, two fixes, and this file asserts both: the breaker now PAGES on its
 * opening edge, and `directPgHealth()` gives /health a real answer with three
 * outcomes instead of a field about a different connection.
 *
 * THE LOAD-BEARING TEST is 'not_checked is never reported as connected'. A reporter
 * that defaults to healthy before anything has been tried rebuilds the exact defect
 * one layer down — a true-looking field about a thing nobody measured.
 */

const pageOperatorMock = jest.fn();
jest.mock('../src/services/operator-pager', () => ({
  pageOperator: (...args: unknown[]) => pageOperatorMock(...args),
  pagerStatus: () => ({ armed: true, push_armed: false }),
}));

/**
 * `pg` is mocked so the failure is the REAL shape — a rejected query — rather than a
 * missing config, which `direct-pg-config-failfast.test.ts` already covers and which
 * takes a different, non-retryable branch.
 */
const queryImpl = jest.fn();
jest.mock('pg', () => ({
  Pool: class {
    query(...args: unknown[]) {
      return queryImpl(...args);
    }
    on() { /* pool error handler */ }
    end() { return Promise.resolve(); }
  },
}));

const AUTH_ERROR = 'password authentication failed for user "postgres"';

describe('direct-pg outage alarm', () => {
  const ORIGINAL_DB = process.env.DATABASE_URL;
  let mod: typeof import('../src/db/direct-pg');
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    pageOperatorMock.mockClear();
    queryImpl.mockReset();
    process.env.DATABASE_URL =
      'postgresql://postgres.qnnpjhlxljtqyigedwkb:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('../src/db/direct-pg');
    mod.__resetDirectPgHealthForTests();
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errSpy.mockRestore();
    if (ORIGINAL_DB === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DB;
  });

  /** One failing call, retries:1 so no backoff is burned. */
  const failOnce = async () => {
    queryImpl.mockRejectedValueOnce(new Error(AUTH_ERROR));
    await expect(mod.pgQuery('SELECT 1', [], { retries: 1, label: 'probe' })).rejects.toThrow();
  };

  describe('three outcomes, never two', () => {
    it('THE LOAD-BEARING ONE: before any query it is not_checked, and never connected', () => {
      const h = mod.directPgHealth();
      expect(h.state).toBe('not_checked');
      expect(h.state).not.toBe('connected');
      expect(h.lastSuccessAt).toBeNull();
      expect(h.circuitOpen).toBe(false);
    });

    it('a successful query reports connected, with the time it succeeded', async () => {
      queryImpl.mockResolvedValueOnce({ rows: [{ ok: 1 }] });
      await mod.pgQuery('SELECT 1', [], { retries: 1 });
      const h = mod.directPgHealth();
      expect(h.state).toBe('connected');
      expect(h.lastSuccessAt).not.toBeNull();
      expect(h.lastError).toBeNull();
      expect(h.consecutiveFailures).toBe(0);
    });

    it('a failed query reports failing, carrying the error a human can act on', async () => {
      await failOnce();
      const h = mod.directPgHealth();
      expect(h.state).toBe('failing');
      expect(h.lastError).toContain('password authentication failed');
    });

    it('a success after failures clears the state back to connected', async () => {
      await failOnce();
      expect(mod.directPgHealth().state).toBe('failing');
      queryImpl.mockResolvedValueOnce({ rows: [] });
      await mod.pgQuery('SELECT 1', [], { retries: 1 });
      expect(mod.directPgHealth().state).toBe('connected');
      expect(mod.directPgHealth().lastError).toBeNull();
    });

    it('issues NO query of its own — /health polls it on every request', async () => {
      queryImpl.mockResolvedValueOnce({ rows: [] });
      await mod.pgQuery('SELECT 1', [], { retries: 1 });
      const before = queryImpl.mock.calls.length;
      mod.directPgHealth();
      mod.directPgHealth();
      expect(queryImpl.mock.calls.length).toBe(before);
    });

    it('never puts the credential in what it reports', async () => {
      await failOnce();
      const rendered = JSON.stringify(mod.directPgHealth());
      expect(rendered).not.toContain('pw@');
      expect(rendered).not.toContain('qnnpjhlxljtqyigedwkb:');
    });
  });

  /**
   * WIRING, ASSERTED AT THE SOURCE, AND THE REASON IT IS NOT A ROUTE TEST.
   *
   * Driving `GET /health` through supertest boots the whole app: it queries Supabase,
   * dials the HashKey RPC and reads `validation_queue`. In a sandbox with no reachable
   * upstream that exceeds jest's timeout, and where it DOES pass, its verdict tracks
   * network conditions rather than the wiring. This repo has paid for that before —
   * `jest.config.js` records two unit tests "making live Supabase calls on a fail-open
   * path, so their verdict tracked network conditions rather than the logic they
   * claimed to test".
   *
   * The property here is structural: the field is on the payload and it is a SEPARATE
   * reading from `supabaseConnected`. A file read answers that exactly, in 2ms,
   * offline, and cannot pass for the wrong reason.
   *
   * It also documents a trap. There are THREE health surfaces and they are not
   * interchangeable: `/health` (src/routes/health.ts — the real one, what production
   * serves), `/api/v1/health` (src/routes/v1.ts:52 — a three-field literal touching
   * nothing), and `/api/health/*` (health-extended.ts). `tests/health.test.ts` asserts
   * against the SECOND, so it checks that a hardcoded object is still hardcoded.
   */
  describe('/health wiring', () => {
    const healthSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'routes', 'health.ts'),
      'utf8',
    );

    it('the real /health route imports the direct-pg reader', () => {
      expect(healthSrc).toMatch(/import \{[^}]*directPgHealth[^}]*\} from '\.\.\/db\/direct-pg'/);
    });

    it('and puts it on the response payload', () => {
      expect(healthSrc).toMatch(/direct_postgres:\s*directPgHealth\(\)/);
    });

    it('as a SEPARATE field from supabaseConnected, not derived from it', () => {
      // Deriving one from the other is the refactor that would rebuild the outage:
      // the two are readings of different connections and must be able to disagree.
      expect(healthSrc).toMatch(/\bsupabaseConnected,/);
      expect(healthSrc).not.toMatch(/direct_postgres:\s*supabaseConnected/);
    });
  });

  describe('the page', () => {
    it('does NOT fire on a single failure — one bad call is not an outage', async () => {
      await failOnce();
      expect(pageOperatorMock).not.toHaveBeenCalled();
    });

    it('fires when the breaker opens, naming direct-pg as its own source', async () => {
      for (let i = 0; i < 5; i++) await failOnce();
      expect(mod.directPgHealth().circuitOpen).toBe(true);
      expect(pageOperatorMock).toHaveBeenCalledTimes(1);
      const [source, reason, detail] = pageOperatorMock.mock.calls[0] as [string, string, Record<string, unknown>];
      expect(source).toBe('direct-pg');
      expect(reason).toMatch(/direct Postgres path is down/i);
      expect(String(detail['last_error'])).toContain('password authentication failed');
    });

    it('pages ONCE on the opening edge, not on every failure after it', async () => {
      for (let i = 0; i < 5; i++) await failOnce();
      expect(pageOperatorMock).toHaveBeenCalledTimes(1);
      // Further calls short-circuit on the open breaker; none of them may page again.
      await expect(mod.pgQuery('SELECT 1', [], { retries: 1 })).rejects.toThrow(/circuit open/i);
      await expect(mod.pgQuery('SELECT 1', [], { retries: 1 })).rejects.toThrow(/circuit open/i);
      expect(pageOperatorMock).toHaveBeenCalledTimes(1);
    });

    it('the reason is STABLE — no query label, so a project-wide outage dedupes to one page', async () => {
      for (let i = 0; i < 5; i++) await failOnce();
      const [, reason] = pageOperatorMock.mock.calls[0] as [string, string];
      // 'probe' is the label every call above passed. If it reached the reason, the
      // pager's per-reason cooldown would be defeated and each caller would page
      // separately — exactly when the operator can least afford the noise.
      expect(reason).not.toContain('probe');
      expect(reason).not.toMatch(/SELECT/i);
    });

    it('names the shared path, not one consumer — every pgQuery caller breaks together', async () => {
      for (let i = 0; i < 5; i++) await failOnce();
      const [source, reason] = pageOperatorMock.mock.calls[0] as [string, string];
      expect(source).not.toBe('proof-drain');
      expect(reason).toMatch(/proof drain|feedback loop|EAS anchor/i);
    });
  });
});
