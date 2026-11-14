/**
 * LOCAL_MODE: the kill switches read the operator's local store, and a fresh store reads closed.
 *
 * The score, proof and trade guards fail CLOSED on a missing repid_config row. A self-host's local
 * store starts with no rows at all, so without the defaults seeded by circuit-breaker.ts every score
 * write on a fresh self-host would be refused. This runs the REAL read against a real in-memory
 * store, not the offline stand-in the other unit tests use, because the stand-in would pass this
 * whether or not the seed exists.
 */

const saved = { mode: process.env.LOCAL_MODE, path: process.env.LOCAL_STORE_PATH };
let cb: typeof import('../src/middleware/circuit-breaker');

beforeAll(() => {
  process.env.LOCAL_MODE = 'true';
  process.env.LOCAL_STORE_PATH = ':memory:';
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.resetModules();
  cb = require('../src/middleware/circuit-breaker');
  cb.__setBreakerRead(null); // the real read, through src/db.ts, which is the local store here
});

afterAll(() => {
  if (saved.mode === undefined) delete process.env.LOCAL_MODE;
  else process.env.LOCAL_MODE = saved.mode;
  if (saved.path === undefined) delete process.env.LOCAL_STORE_PATH;
  else process.env.LOCAL_STORE_PATH = saved.path;
  jest.restoreAllMocks();
});

it('a fresh local store reads every switch closed, so a score write is allowed', async () => {
  await expect(cb.assertBreakerClosed('cb_disable_score_writes')).resolves.toBeUndefined();
  expect(Object.values(await cb.readAllBreakers())).toEqual([false, false, false, false, false, false]);
});

it('a switch tripped in the local store refuses, and resuming it allows again', async () => {
  await cb.flipBreaker('cb_disable_score_writes', true, 'test');
  await expect(cb.assertBreakerClosed('cb_disable_score_writes')).rejects.toThrow(/circuit_breaker_open/);
  await cb.flipBreaker('cb_disable_score_writes', false, 'test');
  await expect(cb.assertBreakerClosed('cb_disable_score_writes')).resolves.toBeUndefined();
});
