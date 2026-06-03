import Redis from 'ioredis';

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
