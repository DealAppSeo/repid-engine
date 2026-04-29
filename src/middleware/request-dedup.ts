import type { Request, Response, NextFunction, RequestHandler } from 'express';

export interface RequestDedupOptions {
  windowMs?: number;
  headerName?: string;
}

interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  isJson: boolean;
  expiresAt: number;
}

interface DedupHandle extends RequestHandler {
  _cache: Map<string, CachedResponse>;
  _stopCleanup: () => void;
}

const CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_HEADER = 'idempotency-key';

export function requestDedup(opts: RequestDedupOptions = {}): DedupHandle {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const headerName = (opts.headerName ?? DEFAULT_HEADER).toLowerCase();
  const cache = new Map<string, CachedResponse>();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
  }, CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

  const handler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const headerValRaw = req.headers[headerName];
    const headerVal = Array.isArray(headerValRaw) ? headerValRaw[0] : headerValRaw;
    if (!headerVal || typeof headerVal !== 'string' || headerVal.length === 0) {
      // No idempotency key — pass through; behaves like the middleware isn't there.
      return next();
    }

    const cacheKey = `${headerVal}|${req.method}|${req.originalUrl || req.url}`;
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      for (const [hk, hv] of Object.entries(cached.headers)) res.setHeader(hk, hv);
      res.setHeader('X-Idempotent-Replay', 'true');
      res.status(cached.status);
      if (cached.isJson) {
        res.json(cached.body);
      } else {
        res.send(cached.body as string | Buffer);
      }
      return;
    }

    // Capture the first response so subsequent matching requests can replay.
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let captured = false;

    const captureAndStore = (body: unknown, isJson: boolean): void => {
      if (captured) return;
      captured = true;
      const headers: Record<string, string> = {};
      const hdrNames = res.getHeaderNames ? res.getHeaderNames() : [];
      for (const name of hdrNames) {
        const v = res.getHeader(name);
        if (typeof v === 'string') headers[name] = v;
        else if (typeof v === 'number') headers[name] = String(v);
      }
      cache.set(cacheKey, {
        status: res.statusCode,
        headers,
        body,
        isJson,
        expiresAt: Date.now() + windowMs,
      });
    };

    (res.json as unknown) = (body: unknown) => {
      captureAndStore(body, true);
      return originalJson(body);
    };
    (res.send as unknown) = (body: unknown) => {
      captureAndStore(body, false);
      return originalSend(body as string | Buffer);
    };

    next();
  };

  const handle = handler as DedupHandle;
  handle._cache = cache;
  handle._stopCleanup = () => clearInterval(cleanupTimer);
  return handle;
}
