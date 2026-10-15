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

  test('only a PROVABLY read-only statement is a read: anything not SELECT/WITH-without-DML is a write', () => {
    const { isWriteStatement } = mod;
    // The old detector looked for known write shapes and called everything else a read.
    expect(isWriteStatement('TRUNCATE repid_proof_queue')).toBe(true);
    expect(isWriteStatement('SELECT * INTO backup_t FROM t')).toBe(true);
    expect(isWriteStatement('CALL settle_batch($1)')).toBe(true);
    expect(isWriteStatement('UPDATE "quoted table" SET a = 1')).toBe(true);
    expect(isWriteStatement('REFRESH MATERIALIZED VIEW v_repid_leaderboard_by_vertical')).toBe(true);
    expect(isWriteStatement('WITH x AS (DELETE FROM t RETURNING id) SELECT count(*) FROM x')).toBe(true);
    // Still reads: keywords inside string literals, row locks, a read-only CTE.
    expect(isWriteStatement("SELECT id FROM trinity_agent_logs WHERE action = 'update' OR action = 'insert into'")).toBe(false);
    expect(isWriteStatement('SELECT * FROM t WHERE id = $1 FOR SHARE')).toBe(false);
    expect(isWriteStatement('WITH a AS (SELECT 1 AS n) SELECT n FROM a')).toBe(false);
  });

  // XC1 on #1387: the classifier stripped comments BEFORE literals, so a comment opener inside a
  // string swallowed the DML after it. Each case below read as a read on dbac892d.
  test.each([
    ['-- inside a literal', "WITH x AS (SELECT 'a --') UPDATE t SET b = 1"],
    ['/* in one literal, */ in a later one', "WITH x AS (SELECT '/*' AS a), y AS (UPDATE t SET b = 1 RETURNING 1) SELECT '*/' FROM x"],
    ['a quote inside a dollar-quoted body', "SELECT $x$'$x$ AS a; UPDATE t SET b = 1 WHERE c = '1'"],
    ['a dollar-quoted DO behind a SELECT', 'SELECT 1 AS a; DO $$ BEGIN PERFORM 1; END $$'],
    ['two statements, both harmless-looking', 'SELECT 1; SELECT 2'],
    ['a second statement the keyword list never knew', 'SELECT 1; VACUUM t'],
    ['a function call that writes', 'SELECT claim_job($1)'],
    ['a set-returning function that writes', 'SELECT * FROM claim_next_job($1)'],
    ['a sequence advance', "SELECT nextval('repid_seq')"],
    ['a schema-qualified call', 'SELECT public.count_and_mark($1)'],
    ['an unterminated literal', "SELECT 'abc"],
  ])('not provably read-only → write: %s', (_why, sql) => {
    expect(mod.isWriteStatement(sql)).toBe(true);
  });

  test('literals, identifiers and casts are lexed, not guessed: these stay reads', () => {
    const reads = [
      "SELECT 'it''s -- not a comment' AS a, '/* nor this */' AS b",
      "SELECT E'\\' -- still inside' AS a",
      'SELECT $tag$ UPDATE t SET b = 1 $tag$ AS quoted_body',
      'SELECT "update" FROM t /* UPDATE t SET b = 1 */',
      'SELECT count(*)::int AS n, coalesce(max(x), 0) AS m FROM t WHERE y = ANY($1::text[]) FOR UPDATE',
      'SELECT x::numeric(10,2), CAST(y AS varchar(20)) FROM t',
      'WITH c AS (SELECT lag(h) OVER (ORDER BY id) AS p FROM t) SELECT count(*) FILTER (WHERE p IS NULL) FROM c',
    ];
    for (const sql of reads) expect([sql, mod.isWriteStatement(sql)]).toEqual([sql, false]);
  });

  test('a SELECT that calls a non-allowlisted function runs once', async () => {
    queryImpl.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({ rows: [] });
    await expect(mod.pgQuery('SELECT claim_job($1)', ['a'], { label: 'claim' })).rejects.toThrow('blip');
    expect(queryImpl).toHaveBeenCalledTimes(1);
  });

  test('a statement the old detector missed (TRUNCATE) now runs once', async () => {
    queryImpl.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({ rows: [] });
    await expect(mod.pgQuery('TRUNCATE t', [], { label: 'tr' })).rejects.toThrow('blip');
    expect(queryImpl).toHaveBeenCalledTimes(1);
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

  test('retries > 1 on a write without idempotent: true throws before touching the database', async () => {
    // The escape hatch XC1 found: run-repid-decay.ts inserted repid_vesting_events with
    // retries: 2 and no ON CONFLICT, so a commit-then-timeout logged one decay twice.
    queryImpl.mockResolvedValue({ rows: [] });
    await expect(
      mod.pgQuery('INSERT INTO repid_vesting_events (agent_id) VALUES ($1)', ['a'], { label: 'decay-log', retries: 2 }),
    ).rejects.toThrow(/retries=2 on a statement that is not provably read-only/);
    expect(queryImpl).not.toHaveBeenCalled();
    // retries: 1 on a write is still fine, and so is retries on a read.
    await expect(mod.pgQuery('UPDATE t SET a = 1 WHERE id = $1', [1], { label: 'e', retries: 1 })).resolves.toEqual([]);
    await expect(mod.pgQuery('SELECT 1', [], { label: 'r', retries: 3 })).resolves.toEqual([]);
  });

  test('a write timeout says the statement may have committed', async () => {
    queryImpl.mockImplementation(() => new Promise(() => undefined)); // never settles
    await expect(mod.pgQuery('UPDATE t SET a = 1 WHERE id = $1', [1], { label: 'w', timeoutMs: 20 })).rejects.toThrow(
      /may still have committed — re-read before deciding/,
    );
  });
});
