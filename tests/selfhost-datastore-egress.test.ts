/**
 * selfhost-datastore-egress — closes the two NON-fetch content-egress paths that
 * the fetch-level boundary (#382) cannot see, because they open RAW TCP sockets
 * (pg / ioredis), not fetch:
 *
 *   (1) DIRECT-PG   — DATABASE_URL (every row is content)
 *   (2) REDIS/CACHE — REDIS_URL   (semantic/wisdom/verification caches hold
 *                                   cached prompt/response TEXT = content)
 *
 * Under ONLY_ATTESTATIONS_LEAVE, a NON-local store host is REFUSED at the
 * connection-creation site (getPgPool / getRedisClient) with an
 * EgressBoundaryError, so the node stays provably data-local even if
 * DATABASE_URL / REDIS_URL is misconfigured to a remote host. A LOCAL host —
 * or the boundary being OFF — is a no-op (hosted behavior byte-identical).
 *
 * Offline-safe: pg Pool construction is lazy (no socket until a query), and the
 * remote REFUSE cases throw BEFORE any `new Redis` / `new Pool`, so no real
 * network is ever touched. The one LOCAL redis construction is disconnected
 * immediately.
 */
import {
  assertLocalDataStore,
  EgressBoundaryError,
} from '../src/selfhost/egress-guard';

const REMOTE_PG = 'postgresql://u:p@db.remote-pooler.example.com:6543/postgres';
const LOCAL_PG = 'postgresql://u:p@127.0.0.1:6543/postgres';
const REMOTE_REDIS = 'rediss://user:pw@cache.dragonfly-cloud.example.com:6379';
const LOCAL_REDIS = 'redis://127.0.0.1:6379';

// ── env save/restore so nothing leaks between suites ──────────────────────────
const SAVED: Record<string, string | undefined> = {};
const KEYS = ['ONLY_ATTESTATIONS_LEAVE', 'DATABASE_URL', 'SUPABASE_DB_URL', 'REDIS_URL'];
function saveEnv() {
  for (const k of KEYS) SAVED[k] = process.env[k];
}
function restoreEnv() {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k]!;
  }
}
function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}

// ══════════════════════════════════════════════════════════════════════════════
// UNIT — the shared assertion the two sites call.
// ══════════════════════════════════════════════════════════════════════════════
describe('assertLocalDataStore — the shared connection-egress gate', () => {
  test('boundary ON + remote host → THROWS EgressBoundaryError', () => {
    expect(() => assertLocalDataStore(REMOTE_PG, 'DATABASE_URL', true)).toThrow(EgressBoundaryError);
    expect(() => assertLocalDataStore(REMOTE_REDIS, 'REDIS_URL', true)).toThrow(EgressBoundaryError);
  });

  test('boundary ON + local/private host → no-op', () => {
    expect(() => assertLocalDataStore(LOCAL_PG, 'DATABASE_URL', true)).not.toThrow();
    expect(() => assertLocalDataStore(LOCAL_REDIS, 'REDIS_URL', true)).not.toThrow();
    expect(() => assertLocalDataStore('redis://10.0.0.5:6379', 'REDIS_URL', true)).not.toThrow();
    expect(() => assertLocalDataStore('postgresql://u:p@host.docker.internal:5432/db', 'DATABASE_URL', true)).not.toThrow();
  });

  test('boundary OFF + remote host → no-op (hosted behavior byte-identical)', () => {
    expect(() => assertLocalDataStore(REMOTE_PG, 'DATABASE_URL', false)).not.toThrow();
    expect(() => assertLocalDataStore(REMOTE_REDIS, 'REDIS_URL', false)).not.toThrow();
  });

  test('an unparseable connection string is treated as remote (fail-closed) under the boundary', () => {
    expect(() => assertLocalDataStore('not a url', 'DATABASE_URL', true)).toThrow(EgressBoundaryError);
  });

  test('the thrown error carries a datastore decision naming the blocked host + store', () => {
    try {
      assertLocalDataStore(REMOTE_REDIS, 'REDIS_URL', true);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EgressBoundaryError);
      const err = e as EgressBoundaryError;
      expect(err.decision.kind).toBe('datastore');
      expect(err.decision.allowed).toBe(false);
      expect(err.decision.host).toBe('cache.dragonfly-cloud.example.com');
      expect(err.message).toMatch(/REDIS_URL/);
    }
  });

  test('reads ONLY_ATTESTATIONS_LEAVE from env when boundaryOn is not passed', () => {
    saveEnv();
    try {
      process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
      expect(() => assertLocalDataStore(REMOTE_PG, 'DATABASE_URL')).toThrow(EgressBoundaryError);
      process.env.ONLY_ATTESTATIONS_LEAVE = 'false';
      expect(() => assertLocalDataStore(REMOTE_PG, 'DATABASE_URL')).not.toThrow();
    } finally {
      restoreEnv();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DATABASE_URL is classified by the host `pg` will DIAL, not by new URL().hostname.
// pg runs pg-connection-string's parse() on the connection string, and parse() lets a
// `?host=` query parameter override the URL authority (last one wins). Before this fix
// the guard saw 127.0.0.1 while pg connected to evil.example.
// ══════════════════════════════════════════════════════════════════════════════
describe('assertLocalDataStore(DATABASE_URL) classifies the host pg dials', () => {
  const HOST_OVERRIDE = 'postgresql://u:p@127.0.0.1:5432/db?host=evil.example';

  test('pg itself dials the ?host= value (why the guard must parse like pg)', () => {
    const { Client } = require('pg');
    expect(new Client({ connectionString: HOST_OVERRIDE }).host).toBe('evil.example');
  });

  test('the guard parses with the same pg-connection-string module pg loads', () => {
    const pgDir = require('path').dirname(require.resolve('pg'));
    expect(require.resolve('pg-connection-string')).toBe(require.resolve('pg-connection-string', { paths: [pgDir] }));
  });

  test.each([
    HOST_OVERRIDE,
    'postgresql://u:p@localhost/db?host=10.0.0.1.nip.io',
    'postgresql://u:p@127.0.0.1:5432/db?host=127.0.0.1&host=evil.example', // last ?host= wins
    'postgresql://u:p@/db?host=evil.example',
    // No host at all: pg falls back to PGHOST / 'localhost' at connect time, which is not provable here.
    'postgresql:///db',
    // pg dials a '/'-prefixed host as a socket path; '//x/…' and '/\x\…' are Windows UNC paths,
    // i.e. a named pipe on machine x (loopback-checked: '//localhost/pipe/p' reaches \\.\pipe\p).
    'postgresql://u:p@127.0.0.1:5432/db?host=//evil.example/pipe',
    'postgresql://u:p@127.0.0.1:5432/db?host=/%5Cevil.example%5Cpipe',
  ])('REFUSES %s', (cs) => {
    expect(() => assertLocalDataStore(cs, 'DATABASE_URL', true)).toThrow(EgressBoundaryError);
  });

  test.each([
    'postgresql://u:p@127.0.0.1:5432/db',
    'postgresql://u:p@[::1]:5432/db',
    'postgresql://u:p@127.0.0.1:5432/db?host=127.0.0.1',
    'postgresql://u:p@db.remote.example:5432/db?host=127.0.0.1', // pg dials 127.0.0.1, so local
    'postgresql://u:p@127.0.0.1:5432/db?host=/var/run/postgresql', // Unix socket: a file on this box
  ])('stays local: %s', (cs) => {
    expect(() => assertLocalDataStore(cs, 'DATABASE_URL', true)).not.toThrow();
  });

  test('the refusal names the host pg would have dialled', () => {
    try {
      assertLocalDataStore(HOST_OVERRIDE, 'DATABASE_URL', true);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EgressBoundaryError);
      expect((e as EgressBoundaryError).decision.host).toBe('evil.example');
    }
  });

  test('boundary OFF: the override is not inspected (hosted behavior unchanged)', () => {
    expect(() => assertLocalDataStore(HOST_OVERRIDE, 'DATABASE_URL', false)).not.toThrow();
  });

  test('REDIS_URL re-check: ioredis keeps the URL host over ?host=, and so does the guard', () => {
    const Redis = require('ioredis');
    const url = 'redis://127.0.0.1:6379?host=evil.example';
    const client = new Redis(url, { lazyConnect: true });
    try {
      expect(client.options.host).toBe('127.0.0.1');
    } finally {
      client.disconnect();
    }
    expect(() => assertLocalDataStore(url, 'REDIS_URL', true)).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (1) DIRECT-PG — getPgPool refuses a remote DATABASE_URL under the boundary.
// ══════════════════════════════════════════════════════════════════════════════
describe('direct-pg getPgPool: DATABASE_URL egress boundary', () => {
  beforeEach(() => saveEnv());
  afterEach(async () => {
    // Best-effort: close any pool the local/off cases created, then reset env + module.
    try {
      const { closePgPool } = require('../src/db/direct-pg');
      await closePgPool();
    } catch { /* ignore */ }
    restoreEnv();
  });

  test('REFUSES a remote pooler host under ONLY_ATTESTATIONS_LEAVE', () => {
    jest.resetModules();
    clearEnv();
    process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
    process.env.DATABASE_URL = REMOTE_PG;
    const { getPgPool } = require('../src/db/direct-pg');
    const { EgressBoundaryError: EBE } = require('../src/selfhost/egress-guard');
    expect(() => getPgPool()).toThrow(EBE);
  });

  test('REFUSES a local-looking DATABASE_URL whose ?host= points pg elsewhere', () => {
    jest.resetModules();
    clearEnv();
    process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
    process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:5432/db?host=evil.example';
    const { getPgPool } = require('../src/db/direct-pg');
    const { EgressBoundaryError: EBE } = require('../src/selfhost/egress-guard');
    expect(() => getPgPool()).toThrow(EBE);
  });

  test('PERMITS a local host under the boundary (Pool constructed, no socket)', () => {
    jest.resetModules();
    clearEnv();
    process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
    process.env.DATABASE_URL = LOCAL_PG;
    const { getPgPool } = require('../src/db/direct-pg');
    expect(() => getPgPool()).not.toThrow();
  });

  test('boundary OFF: a remote host is PERMITTED (hosted behavior unchanged)', () => {
    jest.resetModules();
    clearEnv();
    // ONLY_ATTESTATIONS_LEAVE unset.
    process.env.DATABASE_URL = REMOTE_PG;
    const { getPgPool } = require('../src/db/direct-pg');
    // pg Pool is lazy — construction opens no socket, so this is offline-safe and
    // proves the guard is inert when the boundary is off.
    expect(() => getPgPool()).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// (2) REDIS — getRedisClient refuses a remote REDIS_URL under the boundary.
// ══════════════════════════════════════════════════════════════════════════════
describe('redis-client getRedisClient: REDIS_URL egress boundary', () => {
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    saveEnv();
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    try {
      const { closeRedisClient } = require('../src/clients/redis-client');
      await closeRedisClient();
    } catch { /* ignore */ }
    errSpy.mockRestore();
    restoreEnv();
  });

  test('REFUSES a remote cache host under ONLY_ATTESTATIONS_LEAVE (throws before any socket)', () => {
    jest.resetModules();
    clearEnv();
    process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
    process.env.REDIS_URL = REMOTE_REDIS;
    const { getRedisClient } = require('../src/clients/redis-client');
    const { EgressBoundaryError: EBE } = require('../src/selfhost/egress-guard');
    expect(() => getRedisClient()).toThrow(EBE);
  });

  test('PERMITS a local host under the boundary (client constructed, then disconnected)', () => {
    jest.resetModules();
    clearEnv();
    process.env.ONLY_ATTESTATIONS_LEAVE = 'true';
    process.env.REDIS_URL = LOCAL_REDIS;
    const { getRedisClient } = require('../src/clients/redis-client');
    let client: any;
    expect(() => { client = getRedisClient(); }).not.toThrow();
    // Stop the eager reconnection loop so no handle lingers (nothing is listening
    // on 127.0.0.1:6379 in CI — we only assert the guard let it through).
    try { client?.disconnect(); } catch { /* ignore */ }
  });
});
