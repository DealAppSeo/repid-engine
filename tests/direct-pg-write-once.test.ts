/**
 * pgQuery runs a WRITE once by default (XC1, PR #1375 review).
 *
 * The timeout is a Promise.race that does not cancel the statement, so a write that "timed out"
 * may have committed. Retrying it applies it twice; a conditional UPDATE's retry then returns 0
 * rows and the caller reads its own commit as someone else's. Here the mocked pool APPLIES the
 * write and then fails the client, which is exactly that sequence.
 */
jest.mock('../src/services/operator-pager', () => ({
  pageOperator: jest.fn(),
  pagerStatus: () => ({ armed: true, push_armed: false }),
}));

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

describe('pgQuery write semantics', () => {
  let mod: typeof import('../src/db/direct-pg');
  let errSpy: jest.SpyInstance;
  const ORIGINAL_DB = process.env.DATABASE_URL;

  beforeEach(() => {
    jest.resetModules();
    queryImpl.mockReset();
    process.env.DATABASE_URL =
      'postgresql://postgres.qnnpjhlxljtqyigedwkb:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres';
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('../src/db/direct-pg');
    mod.__resetDbResilience();
  });
  afterEach(() => {
    errSpy.mockRestore();
    if (ORIGINAL_DB === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DB;
  });

  test('isWriteStatement: INSERT / UPDATE ... SET / DELETE / MERGE / a writing CTE; not SELECT or FOR UPDATE', () => {
    const { isWriteStatement } = mod;
    expect(isWriteStatement('INSERT INTO t (a) VALUES ($1)')).toBe(true);
    expect(isWriteStatement('UPDATE peer_verification_queue SET verification_status = $1 WHERE id = $2')).toBe(true);
    expect(isWriteStatement('WITH t AS (SELECT 1) UPDATE peer_verification_queue q SET x = 1 FROM t WHERE q.id = $1')).toBe(true);
    expect(isWriteStatement('DELETE FROM t WHERE id = $1')).toBe(true);
    expect(isWriteStatement('MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DO NOTHING')).toBe(true);
    expect(isWriteStatement('SELECT count(*) FROM repid_score_events WHERE contract_id = $1')).toBe(false);
    expect(isWriteStatement('SELECT * FROM t WHERE id = $1 FOR UPDATE')).toBe(false);
    expect(isWriteStatement('SELECT updated_at FROM t -- UPDATE t SET x = 1')).toBe(false);
  });

  test('a write that commits and then times out is NOT retried', async () => {
    let applied = 0;
    queryImpl.mockImplementation(async () => {
      applied++; // the statement committed...
      throw new Error('Connection terminated unexpectedly'); // ...and the client never saw the result
    });
    await expect(
      mod.pgQuery(`UPDATE peer_verification_queue SET verification_status = 'panel_resolved' WHERE id = $1 AND verification_status IN ('pending','in_review') RETURNING id`, [1], { label: 't' }),
    ).rejects.toThrow('Connection terminated unexpectedly');
    expect(queryImpl).toHaveBeenCalledTimes(1);
    expect(applied).toBe(1);
  });

  test('a read is still retried', async () => {
    queryImpl.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({ rows: [{ n: 1 }] });
    await expect(mod.pgQuery('SELECT 1 AS n', [], { label: 'r', retries: 2 })).resolves.toEqual([{ n: 1 }]);
    expect(queryImpl).toHaveBeenCalledTimes(2);
  });

  test('a write marked idempotent keeps its retries', async () => {
    queryImpl.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({ rows: [] });
    await expect(
      mod.pgQuery('INSERT INTO t (k) VALUES ($1) ON CONFLICT (k) DO NOTHING', ['a'], { label: 'i', idempotent: true, retries: 2 }),
    ).resolves.toEqual([]);
    expect(queryImpl).toHaveBeenCalledTimes(2);
  });

  test('an explicit retries on a write is the caller\'s choice and is honoured', async () => {
    queryImpl.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({ rows: [{ id: 1 }] });
    await expect(mod.pgQuery('UPDATE t SET a = 1 WHERE id = $1 RETURNING id', [1], { label: 'e', retries: 2 })).resolves.toEqual([{ id: 1 }]);
    expect(queryImpl).toHaveBeenCalledTimes(2);
  });

  test('a write timeout says the statement may have committed', async () => {
    queryImpl.mockImplementation(() => new Promise(() => undefined)); // never settles
    await expect(mod.pgQuery('UPDATE t SET a = 1 WHERE id = $1', [1], { label: 'w', timeoutMs: 20 })).rejects.toThrow(
      /may still have committed — re-read before deciding/,
    );
  });
});
