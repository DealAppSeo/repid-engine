/**
 * direct-pg: a missing DATABASE_URL must fail FAST and LOUD (2026-07-31).
 *
 * ROOT CAUSE THIS PINS: resolveConnectionString() throws when DATABASE_URL /
 * SUPABASE_DB_URL is unset. That throw was caught by pgQuery's retry loop,
 * which slept on an `unref()`'d timer. With no pool ever created there are no
 * handles left holding the event loop, so Node empties it and the PROCESS
 * EXITS 0 MID-RETRY — no error, no log, exit code 0.
 *
 * Live impact (verified 2026-07-31): the proof-drain worker showed "Online"
 * on Railway while 40,546 jobs sat pending since 2026-06-16 and the prover was
 * healthy. A local harness reproduced it exactly: last output was the line
 * before the first pgQuery, then a clean exit 0.
 *
 * The contract: a config error REJECTS (so callers see it), it rejects fast
 * (no backoff schedule burned), and it logs loudly.
 */
describe('pgQuery — missing DATABASE_URL fails fast and loud', () => {
  const ORIGINAL_DB = process.env.DATABASE_URL;
  const ORIGINAL_SB = process.env.SUPABASE_DB_URL;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.DATABASE_URL;
    delete process.env.SUPABASE_DB_URL;
  });

  afterEach(() => {
    if (ORIGINAL_DB === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DB;
    if (ORIGINAL_SB === undefined) delete process.env.SUPABASE_DB_URL;
    else process.env.SUPABASE_DB_URL = ORIGINAL_SB;
  });

  test('REJECTS (never hangs or silently resolves) when the connection string is absent', async () => {
    const { pgQuery } = require('../src/db/direct-pg');
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(pgQuery('SELECT 1', [], { label: 'cfg-test' })).rejects.toThrow(
      /DATABASE_URL .*is not set|SUPABASE_DB_URL/i
    );
    err.mockRestore();
  });

  test('rejects FAST — no backoff schedule burned on a non-retryable config error', async () => {
    const { pgQuery } = require('../src/db/direct-pg');
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const started = Date.now();
    await expect(
      pgQuery('SELECT 1', [], { label: 'cfg-fast', retries: 5 })
    ).rejects.toThrow();
    // The old path slept through the backoff schedule (seconds) before dying.
    expect(Date.now() - started).toBeLessThan(1000);
    err.mockRestore();
  });

  test('logs loudly — the failure can never be invisible in worker logs', async () => {
    const { pgQuery } = require('../src/db/direct-pg');
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(pgQuery('SELECT 1', [], { label: 'cfg-loud' })).rejects.toThrow();
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls.map(c => c.join(' ')).join(' '))).toMatch(/FATAL CONFIG ERROR/);
    err.mockRestore();
  });
});
