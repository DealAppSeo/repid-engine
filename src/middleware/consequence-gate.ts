/**
 * CONSEQUENCE GATE — SHADOW MODE, LOCAL-ONLY (CC, 2026-06-24).
 * Express middleware that runs the §3 consequence classifier *alongside* the live request and
 * records what it WOULD do — it enforces NOTHING. Mirrors the established shadow-gate pattern in
 * `repid-active-gate.ts` (compute now, gate the bite later) but with one hard divergence:
 *
 *   ⛔ SHADOW OUTPUT IS LOCAL-ONLY. It NEVER writes to Supabase (prod table `repid_gate_shadow_log`
 *      or any other). Writing to prod is a HARD STOP for this sprint. The default sink appends JSONL
 *      to a local file; tests inject an in-memory sink. There is no Supabase code path in this file.
 *
 * Enforcement (`enforce` mode) is intentionally NOT implemented here — it is Tier-2 (Sean-gated)
 * and waits on calibration evidence. The middleware always calls next(); it cannot block a request.
 */

import { Request, Response, NextFunction } from 'express';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  Action,
  Classification,
  ClassifierConfig,
  DEFAULT_CONFIG,
  LlmSuggestHook,
  classifyAction,
} from '../services/consequence-classifier';

export type GateMode = 'shadow' | 'off';

/** Read the gate mode from env. Defaults to `shadow`. `enforce` is deliberately unsupported here. */
export function gateMode(): GateMode {
  const m = (process.env.CONSEQUENCE_GATE_MODE ?? 'shadow').toLowerCase();
  return m === 'off' ? 'off' : 'shadow';
}

/** One shadow-log record. Carries the classification + minimal request context for later review. */
export interface ShadowRecord {
  /** ISO timestamp set by the sink writer. */
  ts: string;
  mode: GateMode;
  method: string;
  route: string;
  /** The infra-bound action the gate derived from the request (or null if it could not derive one). */
  action: Action | null;
  /** Classification result. Null only when no action could be derived. */
  classification: Classification | null;
  /** What enforcement WOULD have done — advisory string, since shadow enforces nothing. */
  wouldRoute: 'act' | 'adversarial-gate' | 'HITL' | 'no-action';
}

/**
 * A sink consumes shadow records. The default sink appends JSONL to a LOCAL file. Tests pass an
 * in-memory sink. A sink MUST NOT throw — a logging failure can never affect the live request.
 */
export type ShadowSink = (record: ShadowRecord) => void | Promise<void>;

/** Resolve the local shadow-log path. Env override, else repo-local `.shadow-logs/consequence-gate.jsonl`. */
export function defaultShadowLogPath(): string {
  const override = process.env.CONSEQUENCE_GATE_SHADOW_PATH;
  if (override && override.trim()) return override.trim();
  // Repo-local, gitignored sink — keeps shadow output on local disk, never in a DB.
  return path.join(process.cwd(), '.shadow-logs', 'consequence-gate.jsonl');
}

/**
 * Build the default LOCAL-ONLY file sink. Appends one JSON object per line. Best-effort: creates the
 * directory if missing and swallows all errors (never throws). NO network, NO database.
 */
export function fileShadowSink(filePath: string = defaultShadowLogPath()): ShadowSink {
  return async (record: ShadowRecord): Promise<void> => {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
    } catch {
      /* never throw from the shadow logger */
    }
  };
}

/** Map a tier to the advisory route string (matches spec §3 "Default route" column). */
export function wouldRouteFor(c: Classification | null): ShadowRecord['wouldRoute'] {
  if (!c) return 'no-action';
  switch (c.tier) {
    case 'T0': return 'act';
    case 'T1': return 'adversarial-gate';
    case 'T2': return 'HITL';
    default: return 'HITL';
  }
}

/**
 * Derive an infra-bound `Action` from a request. Application-specific; the safe default returns
 * `null` (nothing classified, nothing logged) rather than fabricating an action. Callers wire a
 * real deriver per route group. Returning a poorly-derived action is worse than none — §2 binding.
 */
export type ActionDeriver = (req: Request) => Action | null;
export const noDerive: ActionDeriver = () => null;

export interface ConsequenceGateOptions {
  deriveAction?: ActionDeriver;
  config?: ClassifierConfig;
  llmSuggest?: LlmSuggestHook;
  sink?: ShadowSink;
}

/**
 * Build the shadow-mode consequence-gate middleware. In `shadow` (default) it classifies the
 * derived action, records what it WOULD route, and always continues. In `off` it is a pass-through.
 * It can NEVER block — there is no enforce branch.
 */
export function consequenceGate(opts: ConsequenceGateOptions = {}) {
  const deriveAction = opts.deriveAction ?? noDerive;
  const config = opts.config ?? DEFAULT_CONFIG;
  const sink = opts.sink ?? fileShadowSink();

  return function consequenceGateMiddleware(req: Request, res: Response, next: NextFunction): void {
    const mode = gateMode();
    if (mode === 'off') {
      next();
      return;
    }

    // SHADOW: classify + log, enforce nothing. Wrapped so nothing here can break the request.
    try {
      const action = deriveAction(req);
      const classification = action
        ? classifyAction(action, { config, llmSuggest: opts.llmSuggest })
        : null;
      const record: ShadowRecord = {
        ts: new Date().toISOString(),
        mode,
        method: req.method,
        route: (req as any).route?.path ?? req.path ?? req.url,
        action,
        classification,
        wouldRoute: wouldRouteFor(classification),
      };
      // Fire-and-forget; a rejected promise must not surface. Sinks already swallow, but guard anyway.
      Promise.resolve(sink(record)).catch(() => { /* never throw from shadow gate */ });
    } catch {
      /* shadow classification must never affect the live path */
    }

    next();
  };
}

/**
 * Convenience: classify an action and produce a shadow record WITHOUT any Express context. Useful
 * for offline shadow runs over a captured action log. Pure + synchronous classification.
 */
export function shadowClassify(
  action: Action | null,
  opts: { config?: ClassifierConfig; llmSuggest?: LlmSuggestHook; method?: string; route?: string } = {},
): ShadowRecord {
  const classification = action
    ? classifyAction(action, { config: opts.config, llmSuggest: opts.llmSuggest })
    : null;
  return {
    ts: new Date().toISOString(),
    mode: 'shadow',
    method: opts.method ?? 'N/A',
    route: opts.route ?? 'N/A',
    action,
    classification,
    wouldRoute: wouldRouteFor(classification),
  };
}
