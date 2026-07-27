/**
 * L0 gate 0.4 — the HTTP half of the global emergency halt.
 *
 * When `trinity_system_config.emergency_halt` is true, every MUTATING request
 * (POST/PUT/PATCH/DELETE) is refused with 503 + Retry-After. Reads are left
 * alone on purpose: during a halt you want dashboards, /health and every
 * observability surface to keep working — that is how the operator watches the
 * system come to rest and decides when to flip it back.
 *
 * THIS MIDDLEWARE DOES NOT QUERY THE DATABASE. It is a synchronous peek at state
 * kept warm by `startEmergencyHaltRefresher` (one query per ~5s for the whole
 * process, regardless of traffic). The first version awaited a read per request
 * and CI found both consequences: a hung read stalled the request, and the extra
 * query consumed a sequenced mock a route test depended on. Adding a DB
 * round-trip to every write in the system is too much to pay for a boolean.
 * Cost of the trade: a flip takes effect within one refresh interval rather than
 * instantly — the same behaviour the existing cb_* breakers already have.
 *
 * DELIBERATE DEVIATION FROM THE BACKLOG'S ACCEPTANCE TEXT: item 0.4 says
 * "enqueue 429". This returns **503**. 429 means "you, the caller, sent too many
 * requests" — it invites a per-client backoff, blames a client that did nothing
 * wrong, and several HTTP clients treat it as a signal to rotate keys. 503 +
 * Retry-After is the standard, honest encoding of "the server is deliberately
 * unavailable right now, come back later", which is exactly what a kill switch
 * is. Documented here rather than silently swapped.
 *
 * FAIL-OPEN: if the state has never been read (refresher not started, or its
 * first read has not returned), requests proceed — and that is said out loud
 * once, rather than the guard silently protecting nothing.
 */

import type { NextFunction, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { peekHaltState, startEmergencyHaltRefresher } from '../services/emergency-halt';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Retry-After seconds advertised while halted. */
const RETRY_AFTER_SECONDS = 30;

let warnedUninitialized = false;

export interface EmergencyHaltMiddlewareOptions {
  /**
   * Paths that stay writable while halted. Empty by default — there is no
   * "un-halt over HTTP" endpoint on purpose: the switch is flipped in the
   * database, so a compromised API key can never clear it.
   */
  allowPaths?: readonly string[];
  /**
   * Start the background refresher when the middleware is created. Defaults to
   * true so a single `app.use(emergencyHaltMiddleware(db))` is sufficient and a
   * future entrypoint cannot accidentally mount a guard with nothing feeding it.
   */
  autoStartRefresher?: boolean;
}

export function emergencyHaltMiddleware(
  client: Pick<SupabaseClient, 'from'>,
  options: EmergencyHaltMiddlewareOptions = {},
) {
  const allow = new Set(options.allowPaths ?? []);
  if (options.autoStartRefresher !== false) startEmergencyHaltRefresher(client);

  return function emergencyHaltGuard(req: Request, res: Response, next: NextFunction): void {
    if (!MUTATING.has(req.method)) return next();
    if (allow.has(req.path)) return next();

    const state = peekHaltState();
    if (!state.initialized) {
      if (!warnedUninitialized) {
        warnedUninitialized = true;
        console.warn(
          '[EmergencyHalt] guard reached before any successful state read — allowing writes. ' +
            'The kill switch is NOT protecting this surface yet (refresher not started, or first read pending).',
        );
      }
      return next();
    }

    if (!state.halted) return next();

    console.warn(`[EmergencyHalt] 503 ${req.method} ${req.path} — global halt active (gate 0.4)`);
    res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
    res.status(503).json({
      error: 'emergency_halt',
      message: 'System is in emergency halt — writes are temporarily refused. Reads remain available.',
      retry_after_seconds: RETRY_AFTER_SECONDS,
    });
  };
}

/** Test-only: reset the once-per-process warning. */
export function __resetEmergencyHaltMiddlewareState(): void {
  warnedUninitialized = false;
}
