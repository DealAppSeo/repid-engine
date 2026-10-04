/**
 * The caller's IP for an anti-abuse decision (rate limit, dedup) — from the header our edge sets,
 * not from one the caller can write.
 *
 * Railway documents exactly one client-IP header: `X-Real-IP`, "for identifying client's remote
 * IP" (docs.railway.com/networking/public-networking/specs-and-limits, read 2026-10-04). It says
 * nothing about `X-Forwarded-For`. `req.ip` under `trust proxy: 1` is the RIGHTMOST
 * `X-Forwarded-For` entry, which is the client's own address only if the edge appends to that
 * header — undocumented, so a caller who rotates the header may get a fresh bucket per request
 * (Strix, repid-engine #1192, LOW, CWE-940). The leftmost entry is worse: it is always whatever
 * the caller sent.
 *
 * So: a well-formed `X-Real-IP` wins; otherwise `req.ip` (local runs and tests, where there is no
 * edge), then the socket address. A malformed or multi-valued `X-Real-IP` is ignored rather than
 * used as a bucket key.
 *
 * Everything above rests on the edge OVERWRITING a caller-sent `X-Real-IP`, and that is MEASURED
 * [2026-10-04, production]: five requests, each carrying a different made-up `X-Real-IP`
 * (198.51.100.31-35), read `x-ratelimit-remaining` 57, 59, 56, 58, 55 from the global limiter.
 * That is two shared buckets counting down (the caller's two egress addresses), not five fresh
 * ones at 59, so a caller cannot choose its bucket with this header. Re-run those five requests
 * if the platform or the edge changes: 59 on every line means the header passes through and this
 * function is spoofable.
 */
import { isIP } from 'net';
import type { Request } from 'express';

export function trustedClientIp(req: Request): string {
  const real = req.headers['x-real-ip'];
  const v = typeof real === 'string' ? real.trim() : '';
  if (v && isIP(v)) return v;
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
