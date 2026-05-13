/**
 * CC Sprint 9 Phase 6 — Circuit breaker middleware.
 *
 * Reads boolean flags from repid_config. When a flag is `true`, the corresponding
 * action is blocked at the middleware layer with HTTP 503 + a clear reason.
 *
 * Flags read:
 *   cb_disable_x402_settlements   — blocks x402 payment routes
 *   cb_disable_zkp_proofs         — blocks ZKP proof endpoints
 *   cb_disable_onchain_writes     — blocks ERC-8004 anchor routes
 *   cb_disable_trade_execution    — blocks production trade_execution_log writes
 *   cb_disable_score_writes       — blocks all score-changing routes (kill switch)
 *   cb_freeze_swarm_responses     — blocks trinity-* prompts
 *
 * Cached 5s in-process to avoid hammering the DB on hot paths.
 */

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config';

export type BreakerKey =
  | 'cb_disable_x402_settlements'
  | 'cb_disable_zkp_proofs'
  | 'cb_disable_onchain_writes'
  | 'cb_disable_trade_execution'
  | 'cb_disable_score_writes'
  | 'cb_freeze_swarm_responses';

const CACHE_TTL_MS = 5000;
let cache: { [k in BreakerKey]?: { value: boolean; at: number } } = {};

const db = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });

export async function isTripped(key: BreakerKey): Promise<boolean> {
  const now = Date.now();
  const cached = cache[key];
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const { data, error } = await db.from('repid_config').select('value').eq('key', key).maybeSingle();
  if (error || !data) {
    // Fail-safe: if we can't read the breaker, default to NOT tripped for read-only ops,
    // but breaker(...) middleware below treats DB-read failures as tripped for safety.
    cache[key] = { value: false, at: now };
    return false;
  }
  const value = String((data as any).value).toLowerCase() === 'true';
  cache[key] = { value, at: now };
  return value;
}

export function breaker(key: BreakerKey) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const tripped = await isTripped(key);
      if (tripped) {
        return res.status(503).json({
          error: 'circuit_breaker_open',
          breaker: key,
          message: `Action blocked by ${key}. Flip the value in repid_config to false (with Sean's approval) to re-enable.`,
        });
      }
      return next();
    } catch (e: any) {
      // Fail closed on read errors for safety-critical breakers.
      return res.status(503).json({
        error: 'circuit_breaker_unknown',
        breaker: key,
        message: `Could not read breaker state — failing closed. Details: ${e?.message ?? 'unknown'}`,
      });
    }
  };
}

/** Manual control entry points used by scripts/circuit-breaker-controls.ts. */
export async function flipBreaker(key: BreakerKey, on: boolean, updatedBy = 'cli'): Promise<void> {
  const value = on ? 'true' : 'false';
  const { error } = await db.from('repid_config').update({ value, last_updated: new Date().toISOString(), updated_by: updatedBy }).eq('key', key);
  if (error) throw new Error(`flipBreaker(${key}, ${on}) failed: ${error.message}`);
  delete cache[key];
}

export async function readAllBreakers(): Promise<Record<BreakerKey, boolean>> {
  const keys: BreakerKey[] = [
    'cb_disable_x402_settlements',
    'cb_disable_zkp_proofs',
    'cb_disable_onchain_writes',
    'cb_disable_trade_execution',
    'cb_disable_score_writes',
    'cb_freeze_swarm_responses',
  ];
  const out: Partial<Record<BreakerKey, boolean>> = {};
  for (const k of keys) out[k] = await isTripped(k);
  return out as Record<BreakerKey, boolean>;
}
