import Redis from 'ioredis';
import { assertLocalDataStore } from '../selfhost/egress-guard';

let cachedClient: Redis | null = null;

/**
 * Returns a connected ioredis instance.
 * Caches the client to prevent multiple concurrent connections.
 */
export function getRedisClient(): Redis {
  if (cachedClient) {
    return cachedClient;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL environment variable is not set');
  }

  // DATA-LOCALITY BOUNDARY (ONLY_ATTESTATIONS_LEAVE): the Redis/Dragonfly caches
  // reached through this client hold cached prompt/response TEXT (semantic-cache,
  // wisdom-cache, verification-cache, provider-health, …) — content. ioredis
  // opens a raw TCP socket to REDIS_URL, which the fetch-level guard cannot see,
  // so a NON-local host is refused when the boundary is engaged. No-op when the
  // boundary is off (hosted behavior unchanged) or the host is local/private.
  assertLocalDataStore(redisUrl, 'REDIS_URL');

  // Create ioredis instance
  const options: any = {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true, // Keep commands in queue during reconnection
  };
  if (redisUrl.startsWith('rediss://')) {
    options.tls = {
      rejectUnauthorized: false
    };
  }

  cachedClient = new Redis(redisUrl, options);

  cachedClient.on('error', (err) => {
    console.error('[REDIS] Client error:', err);
  });

  return cachedClient;
}

/**
 * Resets the cached Redis client. Useful for tests.
 */
export async function closeRedisClient(): Promise<void> {
  if (cachedClient) {
    await cachedClient.quit();
    cachedClient = null;
  }
}
