import { Request, Response, NextFunction } from 'express';
import { db } from '../db';

/**
 * Write-churn fix (2026-07-02): the versioning middleware previously upserted a row into
 * `api_key_versions` on EVERY request, generating ~170k writes to overwrite the same 7 rows
 * (measured from pg_stat_user_tables). The persisted value is a per-key version pin that only
 * changes when a caller sends a *different* X-RepID-Version — so we cache what we've already
 * written in-process and skip the upsert when nothing changed.
 *
 * Cache is a Map<apiKey, version> of the last version we persisted for that key in THIS process.
 * On a cache hit (same key + same version) we do zero DB work. On a miss (new key, or a key that
 * switched version) we upsert once and remember it. Cache is process-local; a fresh process
 * re-writes each active key once — bounded by the number of distinct keys, not by request volume.
 *
 * Knobs (env):
 *   VERSION_PERSIST_ENABLED=false  → disable the DB write entirely (pure in-memory version pin).
 *   VERSION_CACHE_TTL_MS=<ms>      → re-write a key at most once per TTL even if unchanged
 *                                    (default 0 = write-once-per-process, never re-write on no-change).
 *
 * [S2-3, 2026-10-16] The row is keyed by WHO is calling, never by the key itself. This used to
 * write `req.apiKey.key`, so api_key_versions held 169 live-shaped plaintext keys (r32: no second
 * form of a secret). Now: `agent:<agent_id>` for an agent-bound key, `env:<n>` for the n-th
 * REPID_API_KEYS entry, else `anonymous`. Nothing derived from the secret is stored or cached.
 * The table is not created here any more (no runtime DDL through run_sql); it already exists.
 */

const DEFAULT_VERSION = '2026-04-17';

// caller handle -> { version, writtenAt } of the last value we persisted this process.
const persistedVersions = new Map<string, { version: string; writtenAt: number }>();

const persistEnabled = process.env.VERSION_PERSIST_ENABLED !== 'false';
const cacheTtlMs = Number(process.env.VERSION_CACHE_TTL_MS ?? 0);

/** Exposed for tests — clears the in-process cache. */
export function _resetVersionCache(): void {
  persistedVersions.clear();
}

/** The non-secret handle a version pin is stored under. authMiddleware sets both fields it reads. */
export function versionPinHandle(req: Request): string {
  const agentId = (req as any).agent_id;
  if (typeof agentId === 'string' && agentId) return `agent:${agentId}`;
  const envIndex = (req as any).apiKey?.envIndex;
  if (Number.isInteger(envIndex)) return `env:${envIndex}`;
  return 'anonymous';
}

/**
 * Decide whether we need to persist (upsert) this key/version pair. Pure + testable: takes the
 * cache and clock explicitly so tests don't depend on module-level state or real time.
 */
export function shouldPersistVersion(
  cache: Map<string, { version: string; writtenAt: number }>,
  key: string,
  version: string,
  now: number,
  ttlMs: number,
): boolean {
  const prev = cache.get(key);
  if (!prev) return true;                       // never written this process
  if (prev.version !== version) return true;    // caller switched version → must re-pin
  if (ttlMs > 0 && now - prev.writtenAt >= ttlMs) return true; // TTL elapsed → refresh
  return false;                                 // unchanged within TTL → skip the write
}

export const versioningMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const providedVersion = req.headers['x-repid-version'] as string;
  const key = versionPinHandle(req);

  const resolvedVersion = providedVersion || DEFAULT_VERSION;
  (req as any).apiVersion = resolvedVersion;

  // Fast path: version already pinned for this key in-process and unchanged → no DB work at all.
  if (!persistEnabled || !shouldPersistVersion(persistedVersions, key, resolvedVersion, Date.now(), cacheTtlMs)) {
    return next();
  }

  // Best-effort persist of the version pin. Only reached on a genuine change (new key or new version).
  const { error } = await db.from('api_key_versions').upsert({
    api_key: key,
    version: resolvedVersion,
    created_at: new Date().toISOString()
  }, { onConflict: 'api_key' });
  if (error) {
    console.error(error);
  } else {
    persistedVersions.set(key, { version: resolvedVersion, writtenAt: Date.now() });
  }

  next();
};
