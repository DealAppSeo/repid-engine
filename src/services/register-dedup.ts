/**
 * HYP-8 — same agent name from the same IP inside 24 h is a duplicate registration (429).
 *
 * WHAT CHANGED. The window used to live only in a per-process `Map`, so it was forgotten on every
 * restart, and every merge to `main` is a restart (six on 2026-10-04 alone). HYP-8 said the Map was
 * "dormant on multi-replica Railway"; the service runs ONE replica [MEASURED 2026-10-04,
 * `numReplicas: 1`], so the measured cause is restarts, not replicas. Either way the fix is the same:
 * a store the process does not own.
 *
 * HOW. The existing Redis (`REDIS_URL`, the S-CACHE client) via one atomic `SET key 1 PX <24 h> NX`:
 * `OK` means first sighting, `null` means it was already there. NX makes the check-and-record a
 * single step, so two concurrent identical POSTs cannot both read "absent".
 *
 * WHEN REDIS CANNOT ANSWER (unset, unreachable, refused by the ONLY_ATTESTATIONS_LEAVE boundary, or
 * slower than DEDUP_STORE_TIMEOUT_MS): the in-process Map decides, exactly as before. Registration
 * never blocks on Redis — the shared client queues commands while it reconnects, so an unguarded
 * await could hang the route. The Map is also written on every call, so a Redis blip in the middle of
 * a window still remembers what this process saw.
 *
 * WHAT IS STORED. Not the IP. The key is sha256 of `ip::lowercased name`, for 24 h. That is a hash,
 * not encryption: given the name, an IPv4 address can be recovered by brute force. It sits in the
 * same Redis that already holds cached prompt text, and expires on its own.
 */
import crypto from 'crypto';
import type Redis from 'ioredis';
import { getCache } from '../cache/dragonfly';

export const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEDUP_STORE_TIMEOUT_MS = 750;
const KEY_PREFIX = 'reg-dedup:v1:';

export type DedupStore = 'shared' | 'process';
export interface DedupResult {
  duplicate: boolean;
  /** Which store decided: `shared` = Redis answered; `process` = this process's Map (Redis could not). */
  store: DedupStore;
}

const local: Map<string, number> = new Map();

export function dedupKey(ip: string, name: string): string {
  return `${ip}::${name.toLowerCase()}`;
}

function sharedKey(ip: string, name: string): string {
  return KEY_PREFIX + crypto.createHash('sha256').update(dedupKey(ip, name)).digest('hex');
}

function checkLocal(key: string, now: number): boolean {
  // Lazy sweep once the map is large; entries older than the window are dead weight.
  if (local.size > 1000) {
    for (const [k, ts] of local) {
      if (now - ts > DEDUP_WINDOW_MS) local.delete(k);
    }
  }
  const last = local.get(key);
  return last !== undefined && now - last < DEDUP_WINDOW_MS;
}

/** `true` = first sighting, `false` = already recorded, `null` = the shared store did not answer. */
async function claimShared(client: Redis, key: string): Promise<boolean | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const reply = await Promise.race([
      client.set(key, '1', 'PX', DEDUP_WINDOW_MS, 'NX'),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), DEDUP_STORE_TIMEOUT_MS);
      }),
    ]);
    if (reply === 'OK') return true;
    if (reply === null) return false;
    return null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DedupOptions {
  /** Injected for tests; defaults to the shared S-CACHE client (null when REDIS_URL is unset). */
  cache?: () => Redis | null;
  now?: () => number;
}

export async function checkAndRecordDedup(ip: string, name: string, opts: DedupOptions = {}): Promise<DedupResult> {
  const now = (opts.now ?? Date.now)();
  const key = dedupKey(ip, name);
  const seenHere = checkLocal(key, now);

  let client: Redis | null = null;
  try {
    client = (opts.cache ?? getCache)();
  } catch {
    client = null;
  }
  const shared = client ? await claimShared(client, sharedKey(ip, name)) : null;

  if (!seenHere) local.set(key, now);
  if (shared === null) return { duplicate: seenHere, store: 'process' };
  // Either store having seen it makes it a duplicate: Redis covers restarts, the Map covers a key
  // Redis lost (eviction, flush) inside the window.
  return { duplicate: seenHere || !shared, store: 'shared' };
}

// Test-only reset hook so jest cases can start with an empty local window.
export function __resetLocalDedupForTests(): void {
  local.clear();
}
