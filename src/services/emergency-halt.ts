/**
 * L0 gate 0.4 — GLOBAL EMERGENCY HALT (the kill switch).
 *
 * WHY: breakers 2.0/2.1 are per-class producer levers driven by env vars, which
 * means flipping them requires a Railway variable change on every service that
 * runs a producer. That is the wrong shape for an emergency: the one lever that
 * must work when everything else is misbehaving cannot depend on 25 redeploys.
 * SPRINT_BACKLOG item 0.4 therefore puts the global halt in the DATABASE — one
 * boolean, one flip, read by every process on its next tick, no deploy. It is
 * listed as gating "all autonomy gates" because ramping any autonomous producer
 * without a single-action stop is the thing you cannot walk back.
 *
 * RELATIONSHIP TO THE EXISTING CIRCUIT BREAKERS (checked before building this —
 * they are NOT the same thing and this does not replace them):
 * `src/middleware/circuit-breaker.ts` reads `cb_*` keys from `repid_config` and
 * blocks ONE capability at a time (x402 settlement, ZKP endpoints, on-chain
 * writes, score writes, swarm prompts), applied by wrapping specific routes. It
 * is HTTP-only — no worker tick loop consults it, so a breaker cannot stop a
 * poller. This gate is the orthogonal axis: ONE switch, EVERY mutating surface,
 * INCLUDING the tick loops. They compose (either can block a request), and
 * neither reads the other's storage.
 * OPEN QUESTION, deliberately not resolved here: two config tables now hold
 * operator levers (`repid_config` for cb_*, `trinity_system_config` for this).
 * Consolidating them is a separate change with its own blast radius; SPRINT
 * BACKLOG 0.4 names this table, so this follows the backlog and flags the
 * duplication rather than quietly starting a third convention.
 *
 * WHAT: `trinity_system_config.emergency_halt` (singleton row id=1). When true:
 *   - worker tick loops PARK (return immediately, claim nothing, spawn nothing);
 *   - mutating HTTP requests get 503 + Retry-After (see middleware/emergency-halt);
 *   - already-running in-flight work is NOT killed — this parks the loops, it is
 *     not a process kill. Rollback is flipping the same boolean back to false.
 *
 * DEFAULT BEHAVIOUR IS UNCHANGED. The column defaults to false, so with nothing
 * flipped this module reads false and every caller behaves exactly as before.
 *
 * MODE: EMERGENCY_HALT_MODE = enforce (DEFAULT) | shadow | off
 *   enforce — flag true actually parks callers. This is the default ON PURPOSE:
 *             a kill switch that ALSO needs an env var set is not a kill switch,
 *             it is two levers, and the second one needs a deploy.
 *   shadow  — read + log what WOULD park, change nothing (for calibrating a new
 *             call site before it can affect production).
 *   off     — skip the check entirely, no DB read (escape hatch if this module
 *             itself ever misbehaves).
 * Only `off` and `shadow` weaken the switch (case-insensitive, surrounding
 * whitespace ignored — matching parseHaltClasses in producer-halt.ts, because a
 * Railway field with a trailing space is a typo in the operator's fingers, not
 * in their intent). Anything else — `of`, `false`, `0`, `disabled`, garbage —
 * resolves to `enforce` and warns once. You cannot accidentally disable the kill
 * switch by misspelling it; disabling it requires spelling it correctly, which
 * is a deliberate act.
 *
 * FAILURE SEMANTICS (the part that matters):
 *   - A read error can never START a halt. A flaky DB must not park the fleet.
 *   - A read error can never LIFT one either. Once a successful read has seen
 *     true, subsequent failures keep the halt in place ("sticky"); only a
 *     successful read of false resumes. An operator who pulls the switch during
 *     an incident must not have it silently released by the incident.
 *   - A MISSING COLUMN is treated as "not halted" and logged once, so this code
 *     is safe to deploy before (or without) the DDL, and safe if the column is
 *     ever rolled back.
 *
 * LEVERS: EMERGENCY_HALT_MODE (above) · EMERGENCY_HALT_CACHE_MS (default 5000).
 *
 * OPERATOR RUNBOOK — no CLI on purpose; one statement each way, runnable from
 * the Supabase SQL editor with nothing installed:
 *
 *   -- PULL THE SWITCH
 *   UPDATE trinity_system_config
 *      SET emergency_halt = true,
 *          emergency_halt_reason = '<why>',
 *          emergency_halt_at = now(),
 *          emergency_halt_by = '<who>'
 *    WHERE id = 1;
 *
 *   -- RESUME
 *   UPDATE trinity_system_config
 *      SET emergency_halt = false, emergency_halt_at = now(), emergency_halt_by = '<who>'
 *    WHERE id = 1;
 *
 * Takes effect within EMERGENCY_HALT_CACHE_MS (~5s) plus one poll interval on
 * the workers. The reason/at/by columns are audit-only — no code branches on
 * them, so a dashboard toggle that leaves them null still halts correctly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type EmergencyHaltMode = 'off' | 'shadow' | 'enforce';

/** Where the returned flag value came from — surfaced so callers can log honestly. */
export type HaltSource =
  | 'db' // fresh successful read
  | 'cache' // recent successful read, within TTL
  | 'disabled' // EMERGENCY_HALT_MODE=off, no read attempted
  | 'column_absent' // DDL not applied (or rolled back) — treated as not halted
  | 'error_open' // read failed, no prior true → fail open
  | 'error_sticky'; // read failed, prior successful read was true → stay halted

export interface HaltDecision {
  /** the DB flag as understood by this check (false whenever it could not be read). */
  flag: boolean;
  /** flag AND mode==='enforce' — the ONLY field a caller should branch on to park. */
  halted: boolean;
  mode: EmergencyHaltMode;
  source: HaltSource;
  /** human-readable detail for the log line; never contains credentials. */
  reason: string;
}

const DEFAULT_CACHE_MS = 5000;

/** Postgres/PostgREST codes meaning "that column isn't there". */
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204']);

let cachedFlag: boolean | null = null;
let cachedAt = 0;
/** Last value from a SUCCESSFUL read; drives the sticky-halt rule. */
let lastKnownGood: boolean | null = null;
let warnedBadMode = false;
let warnedMissingColumn = false;
/** Last `halted` value we logged, so steady state doesn't spam every tick. */
let lastLoggedHalted: boolean | null = null;
let sinceLastHaltLog = 0;

/** While halted, re-log every Nth check so a parked fleet stays visibly parked. */
const HALT_LOG_EVERY = 20;

/**
 * Resolve EMERGENCY_HALT_MODE. Exported for tests; takes the raw string so it
 * never touches process.env itself.
 *
 * Fail-CLOSED by design: unknown input resolves to `enforce` (the switch keeps
 * working), which is the opposite of this repo's other mode parsers — those
 * guard features that could do damage if switched on, this one guards the lever
 * that stops damage. Warns once on an unrecognized non-empty value so an
 * operator who meant to disable it learns that they did not.
 */
export function resolveHaltMode(raw: string | null | undefined): EmergencyHaltMode {
  if (raw === undefined || raw === null || raw === '') return 'enforce';
  const v = raw.trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'shadow') return 'shadow';
  if (v === 'enforce') return 'enforce';
  if (!warnedBadMode) {
    warnedBadMode = true;
    console.warn(
      `[EmergencyHalt] unrecognized EMERGENCY_HALT_MODE="${raw}" — resolving to "enforce". ` +
        'Only the exact values "off" and "shadow" weaken the kill switch.',
    );
  }
  return 'enforce';
}

function resolveCacheMs(raw: string | null | undefined): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CACHE_MS;
  return n;
}

/**
 * Is this column value a pulled switch?
 *
 * The column is `boolean`, so in practice this is `=== true`. The string form is
 * accepted deliberately: the asymmetry here runs the other way from every other
 * flag in this repo. A flag that wrongly reads as ON turns a feature on that
 * shouldn't be; THIS flag wrongly reading as OFF means an operator pulled the
 * emergency switch during an incident and nothing happened. So if the column is
 * ever migrated to text, or read through a client that stringifies, "true" still
 * halts. Nothing else does — `1`, `yes`, `TRUE!` and null are all not-halted, so
 * a stray value cannot park the fleet by accident.
 */
export function isHaltTruthy(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

/** True when the supabase error object says the column does not exist. */
function isMissingColumn(err: { code?: string | null; message?: string | null } | null): boolean {
  if (!err) return false;
  if (err.code && MISSING_COLUMN_CODES.has(err.code)) return true;
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('emergency_halt') && msg.includes('does not exist');
}

/**
 * Read the global halt state. Cheap: at most one DB read per
 * EMERGENCY_HALT_CACHE_MS (default 5s) per process, so a 30-second poll loop
 * costs one extra query per tick and a burst of HTTP writes costs one total.
 *
 * `now` is injectable so cache-expiry behaviour is testable without sleeping.
 */
export async function checkEmergencyHalt(
  client: Pick<SupabaseClient, 'from'>,
  opts: { mode?: EmergencyHaltMode; cacheMs?: number; now?: number } = {},
): Promise<HaltDecision> {
  const mode = opts.mode ?? resolveHaltMode(process.env.EMERGENCY_HALT_MODE);
  if (mode === 'off') {
    return {
      flag: false,
      halted: false,
      mode,
      source: 'disabled',
      reason: 'EMERGENCY_HALT_MODE=off — check skipped, no DB read',
    };
  }

  const cacheMs = opts.cacheMs ?? resolveCacheMs(process.env.EMERGENCY_HALT_CACHE_MS);
  const now = opts.now ?? Date.now();

  if (cachedFlag !== null && now - cachedAt < cacheMs) {
    return decide(cachedFlag, mode, 'cache', `cached ${now - cachedAt}ms ago`);
  }

  try {
    const { data, error } = await client
      .from('trinity_system_config')
      .select('emergency_halt')
      .eq('id', 1)
      .maybeSingle();

    if (error) {
      if (isMissingColumn(error)) {
        if (!warnedMissingColumn) {
          warnedMissingColumn = true;
          console.warn(
            '[EmergencyHalt] trinity_system_config.emergency_halt does not exist — ' +
              'treating as NOT halted. The kill switch is INERT until the column is added.',
          );
        }
        return decide(false, mode, 'column_absent', 'column missing; switch inert');
      }
      return failRead(mode, error.message ?? 'unknown error');
    }

    // No config row at all is the same shape of problem as a missing column:
    // nobody has flipped anything, so not halted — but say so.
    const flag = isHaltTruthy(data?.emergency_halt);
    cachedFlag = flag;
    cachedAt = now;
    lastKnownGood = flag;
    return decide(flag, mode, 'db', data ? 'read from trinity_system_config id=1' : 'no config row (id=1 absent)');
  } catch (e: unknown) {
    return failRead(mode, e instanceof Error ? e.message : String(e));
  }
}

/**
 * Read failed. Never start a halt on an error; never lift one either.
 * Deliberately does NOT refresh the cache — a failed read must not extend the
 * life of a stale value past its TTL.
 */
function failRead(mode: EmergencyHaltMode, message: string): HaltDecision {
  if (lastKnownGood === true) {
    console.error(
      `[EmergencyHalt] read FAILED (${message}) — last successful read was HALTED, ` +
        'staying halted (sticky). Only a successful read of false resumes.',
    );
    return decide(true, mode, 'error_sticky', `read failed: ${message}; sticky from last known halt`);
  }
  console.error(`[EmergencyHalt] read FAILED (${message}) — failing OPEN (not halted).`);
  return decide(false, mode, 'error_open', `read failed: ${message}; failing open`);
}

function decide(flag: boolean, mode: EmergencyHaltMode, source: HaltSource, reason: string): HaltDecision {
  const halted = flag && mode === 'enforce';
  logTransition(flag, halted, mode, source);
  return { flag, halted, mode, source, reason };
}

/**
 * Log on state CHANGE, plus a bounded reminder while halted. A kill switch that
 * logs nothing is indistinguishable from a broken one; a kill switch that logs
 * every 5 seconds buries the incident it was pulled for.
 */
function logTransition(flag: boolean, halted: boolean, mode: EmergencyHaltMode, source: HaltSource): void {
  const active = flag; // shadow mode still narrates, it just doesn't park
  if (lastLoggedHalted === null || lastLoggedHalted !== active) {
    lastLoggedHalted = active;
    sinceLastHaltLog = 0;
    if (active) {
      // The consequence clause must match the mode. Saying "workers park" while
      // also saying "NOT parking" is the kind of log line that costs an operator
      // ten minutes in an incident.
      console.warn(
        halted
          ? '[EmergencyHalt] *** GLOBAL HALT ACTIVE *** ' +
              `mode=${mode} source=${source}. Workers park, mutating HTTP returns 503; reads stay up. ` +
              'Rollback: UPDATE trinity_system_config SET emergency_halt=false WHERE id=1.'
          : '[EmergencyHalt] *** GLOBAL HALT FLAGGED, NOT ENFORCED *** ' +
              `mode=${mode} source=${source}. The switch is pulled but this process is in ${mode} mode, ` +
              'so NOTHING is being parked or refused. Set EMERGENCY_HALT_MODE=enforce (the default) to make it bite.',
      );
    } else {
      console.log(`[EmergencyHalt] halt cleared — resuming normal operation (mode=${mode} source=${source})`);
    }
    return;
  }
  if (active && ++sinceLastHaltLog >= HALT_LOG_EVERY) {
    sinceLastHaltLog = 0;
    console.warn(`[EmergencyHalt] still halted (mode=${mode} source=${source}) — flip emergency_halt=false to resume`);
  }
}

/**
 * Convenience for tick loops: returns true when the caller should park, and
 * emits the caller-specific log line. Keeps the three-line guard identical at
 * every call site so a new worker cannot get it subtly wrong.
 */
export async function shouldParkForHalt(client: Pick<SupabaseClient, 'from'>, workerName: string): Promise<boolean> {
  const halt = await checkEmergencyHalt(client);
  if (halt.flag) {
    console.warn(
      `[${workerName}] emergency_halt is SET — ${halt.halted ? 'PARKING this tick' : 'WOULD park (shadow mode)'} ` +
        `(source=${halt.source}) (gate 0.4)`,
    );
  }
  return halt.halted;
}

/** Test-only: clear module state between cases. */
export function __resetEmergencyHaltState(): void {
  cachedFlag = null;
  cachedAt = 0;
  lastKnownGood = null;
  warnedBadMode = false;
  warnedMissingColumn = false;
  lastLoggedHalted = null;
  sinceLastHaltLog = 0;
}
