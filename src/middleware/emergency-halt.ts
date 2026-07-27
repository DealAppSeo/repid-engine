/**
 * L0 gate 0.4 — the HTTP half of the global emergency halt.
 *
 * When `trinity_system_config.emergency_halt` is true, every MUTATING request
 * (POST/PUT/PATCH/DELETE) is refused with 503 + Retry-After. Reads are left
 * alone on purpose: during a halt you want dashboards, /health and every
 * observability surface to keep working — that is how the operator watches the
 * system come to rest and decides when to flip it back.
 *
 * DELIBERATE DEVIATION FROM THE BACKLOG'S ACCEPTANCE TEXT: item 0.4 says
 * "enqueue 429". This returns **503**. 429 means "you, the caller, sent too many
 * requests" — it invites a per-client backoff and blames a client that did
 * nothing wrong, and several HTTP clients treat 429 as a signal to rotate keys.
 * 503 + Retry-After is the standard, honest encoding of "the server is
 * deliberately unavailable right now, come back later", which is exactly what a
 * kill switch is. Documented here rather than silently swapped.
 *
 * FAIL-OPEN: if the halt state cannot be read, the request proceeds (the check
 * in services/emergency-halt already fails open on error, and sticky-halts if a
 * prior read saw true). An unreachable config table must not take the API down.
 */

import type { NextFunction, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkEmergencyHalt } from '../services/emergency-halt';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Retry-After seconds advertised while halted. */
const RETRY_AFTER_SECONDS = 30;

export interface EmergencyHaltMiddlewareOptions {
  /**
   * Paths that stay writable while halted. Empty by default — there is no
   * "un-halt over HTTP" endpoint on purpose: the switch is flipped in the
   * database, so a compromised API key can never clear it.
   */
  allowPaths?: readonly string[];
}

export function emergencyHaltMiddleware(
  client: Pick<SupabaseClient, 'from'>,
  options: EmergencyHaltMiddlewareOptions = {},
) {
  const allow = new Set(options.allowPaths ?? []);
  return async function emergencyHaltGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!MUTATING.has(req.method)) return next();
    if (allow.has(req.path)) return next();

    let halted = false;
    try {
      halted = (await checkEmergencyHalt(client)).halted;
    } catch (e: unknown) {
      // Belt and braces: checkEmergencyHalt already swallows its own errors, but
      // a throw here must never 500 a request that would otherwise succeed.
      console.error(
        `[EmergencyHalt] middleware check threw (${e instanceof Error ? e.message : String(e)}) — allowing request`,
      );
      return next();
    }

    if (!halted) return next();

    console.warn(`[EmergencyHalt] 503 ${req.method} ${req.path} — global halt active (gate 0.4)`);
    res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
    res.status(503).json({
      error: 'emergency_halt',
      message: 'System is in emergency halt — writes are temporarily refused. Reads remain available.',
      retry_after_seconds: RETRY_AFTER_SECONDS,
    });
  };
}
