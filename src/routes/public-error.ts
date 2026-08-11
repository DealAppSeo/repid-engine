import type { Response } from 'express';

/**
 * public-error.ts — one place that decides what an unauthenticated caller is told.
 *
 * WHY THIS EXISTS. Every public router had grown its own
 *
 *     return res.status(500).json({ error: 'x_failed', detail: e?.message ?? String(e) });
 *
 * which hands upstream error text to anyone with curl. That text is not ours to give away:
 * a Postgres failure returns strings like
 *
 *     invalid input syntax for type uuid: "trinity-does-not-exist"
 *
 * — naming an internal column type and echoing the caller's probe back at them. Useful to an
 * operator, useful to someone mapping the schema, useless to a legitimate client. Proven
 * reachable on /api/v1/repid/:id/history with nothing but a GET and an arbitrary string.
 *
 * WHY SHARED RATHER THAN COPIED, and this is the load-bearing part. The bug that led here was
 * a resolution helper that three routes had COPIED instead of imported; the fix landed in the
 * original and never reached the copies, and each copy stayed internally consistent enough
 * that nobody noticed. Re-solving that by pasting an error helper into eight files would
 * reproduce the same failure with a different function. One implementation, many importers.
 *
 * NOTHING IS HIDDEN FROM US. The real message is logged server-side with the route that
 * produced it, so operators lose nothing. It is hidden only from strangers.
 */

/** Redact anything that looks like a credential before it reaches a log line. */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '<jwt:redacted>'],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, '<sk:redacted>'],
  [/\bhdg_[A-Za-z0-9_-]{8,}/g, '<hdg:redacted>'],
  [/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer <redacted>'],
];

/**
 * Format an error for the SERVER LOG. Bounded, single-line, and with credential shapes
 * removed — an upstream error can quote the request that caused it, and logs get shipped.
 */
export function forLog(e: unknown, max = 500): string {
  let msg = e instanceof Error ? e.message : String(e);
  for (const [re, sub] of SECRET_SHAPES) msg = msg.replace(re, sub);
  msg = msg.replace(/[\r\n]+/g, ' ');
  return msg.length > max ? `${msg.slice(0, max)}… [+${msg.length - max}]` : msg;
}

/**
 * Answer an unauthenticated caller with a stable code and nothing else, logging the real
 * cause server-side.
 *
 * @param res     express response
 * @param status  HTTP status
 * @param code    stable machine-readable code, e.g. 'costs_failed' — part of the API contract
 * @param e       the underlying error; logged, never serialised to the client
 * @param where   route identifier for the log line, e.g. 'GET /api/v1/costs'
 */
export function publicError(res: Response, status: number, code: string, e: unknown, where: string): Response {
  console.error(`[public] ${where} -> ${status} ${code}: ${forLog(e)}`);
  return res.status(status).json({ error: code });
}
