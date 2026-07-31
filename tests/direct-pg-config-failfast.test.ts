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

/**
 * The SECOND silent-death path (2026-07-31, found when DATABASE_URL turned out
 * to be already SET on both Railway services).
 *
 * A *missing* connection string throws at pool creation — covered above. A
 * *wrong* one does not: the Pool is created fine and the failure happens at
 * query time, landing in the retry loop's backoff sleep. That sleep used to run
 * on an `unref()`'d timer, so whenever it was the only thing on the event loop
 * Node exited 0 mid-retry — the await never resumed and the final throw never
 * ran. Schedule is [1s,4s,16s,64s,256s], so the silent window is ~5.7 minutes.
 *
 * This pins that a connection-level failure REJECTS (with the loop intact),
 * which is the property the removed unref() was destroying.
 */
describe('pgQuery — an unreachable host rejects instead of dying silently', () => {
  const ORIGINAL = process.env.DATABASE_URL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL;
  });

  test('rejects after exhausting retries (never resolves, never vanishes)', async () => {
    jest.resetModules();
    // Port 1 on loopback refuses immediately → fast, deterministic, offline-safe.
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/postgres';
    const { pgQuery } = require('../src/db/direct-pg');
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      pgQuery('SELECT 1', [], { label: 'unreachable', retries: 2, timeoutMs: 2000 })
    ).rejects.toThrow();
    err.mockRestore();
  }, 20_000);
});
