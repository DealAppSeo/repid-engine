// S-CACHE connection probe — run via `railway run -- node scripts/_redis_ping.js` (injects REDIS_URL).
const Redis = require('ioredis');
(async () => {
  const url = process.env.REDIS_URL;
  if (!url) { console.log('NO_REDIS_URL'); process.exit(0); }
  console.log('REDIS_URL scheme:', url.slice(0, 8));
  const c = new Redis(url, { maxRetriesPerRequest: 3, tls: url.startsWith('rediss://') ? {} : undefined, lazyConnect: true });
  try {
    await c.connect();
    await c.set('test:scache:ping', 'pong', 'EX', 10);
    const v = await c.get('test:scache:ping');
    const pong = await c.ping();
    console.log('DRAGONFLY_TEST:', v === 'pong' && pong === 'PONG' ? 'SUCCESS' : 'FAILED', '(get=' + v + ', ping=' + pong + ')');
    await c.del('test:scache:ping');
  } catch (e) {
    console.log('DRAGONFLY_TEST: ERROR', e.message);
  } finally {
    await c.quit().catch(() => {});
  }
})();
