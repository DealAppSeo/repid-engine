/**
 * Circuit breakers: boolean kill switches read from `repid_config`.
 *
 * A switch blocks only what checks it, so this header names, per switch, the code that checks
 * it. WHAT IT USED TO SAY WAS FALSE [MEASURED 2026-11-14]: it said every switch below "blocks"
 * its surface "at the middleware layer". The `breaker()` middleware is mounted nowhere, and only
 * the on-chain and x402 switches had a caller, so tripping the score, proof, trade or swarm
 * switch blocked nothing, while the trade row read "blocked" in production.
 * `tests/circuit-breaker-enforced.test.ts` fails when a key below has no enforcement point and
 * no NOT ENFORCED marker, so this list cannot drift back into a claim.
 *
 *   cb_disable_x402_settlements  ENFORCED in x402-real-settler.ts and x402-recovery-worker.ts,
 *                                which read the row directly rather than through this module.
 *   cb_disable_onchain_writes    ENFORCED in erc8004-reputation.ts and erc8004-poster.ts.
 *   cb_disable_score_writes      ENFORCED in every writer that can move a RepID score:
 *                                insertScoreEvent (refuses a non-zero delta; zero-delta audit
 *                                rows such as GENESIS still land), updateRepId, runScoreEvent,
 *                                applyValidationEvent, POST /challenge and POST /:id/score-event
 *                                (503 via breaker() below), slashRepIDForGateFail,
 *                                emitPeerVerifyScoreEvents, resolveBet, recordOutcome, the
 *                                repid-sync apply, and the src/testing harnesses.
 *                                NOT covered: scripts/ run by hand (decay, recompute), SQL run
 *                                in the editor, and DB functions called from outside this repo.
 *   cb_disable_zkp_proofs        ENFORCED in the proof drain loop, the proof refresh worker,
 *                                generateProofReal (so POST /prove-repid and /batch/prove answer
 *                                503), the zkp-audit service, and the prover dispatch inside the
 *                                score paths (the proof is skipped; the score is still written).
 *   cb_disable_trade_execution   ENFORCED at the only writers of trade_execution_log in this
 *                                repo: two mock-harness scripts that write synthetic paper rows
 *                                (scripts/mock-harness/mock-agent.ts, scenario-02). No service
 *                                under src/ writes that table, so in production this switch
 *                                guards nothing that runs from this repo. Real trading is not
 *                                here; whether another repo reads this row is NOT CHECKED.
 *   cb_freeze_swarm_responses    NOT ENFORCED by this repo. The T12 agents live in another repo
 *                                and do not read it. To halt the swarm, set
 *                                trinity_system_config.emergency_halt (services/emergency-halt.ts).
 *
 * FAILURE POSTURE. `assertBreakerClosed` and `breakerAllows` fail CLOSED: a read error or a
 * missing row refuses the action, because a write guard that cannot read its switch cannot
 * prove the write is allowed. `isTripped` fails OPEN and is for status reads only.
 *
 * LOCAL_MODE reads the operator's local store (src/db.ts). That store starts with no rows, so the
 * defaults (all closed) are seeded for any key without one; a row the operator set is left alone.
 *
 * Cached 5s in-process to avoid hammering the DB on hot paths.
 */

import { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { LOCAL_MODE } from '../config';

/** Every switch, once. tests/circuit-breaker-enforced.test.ts checks each against the header above. */
export const BREAKER_KEYS = [
  'cb_disable_x402_settlements',
  'cb_disable_zkp_proofs',
  'cb_disable_onchain_writes',
  'cb_disable_trade_execution',
  'cb_disable_score_writes',
  'cb_freeze_swarm_responses',
] as const;
export type BreakerKey = (typeof BREAKER_KEYS)[number];

const CACHE_TTL_MS = 5000;
let cache: { [k in BreakerKey]?: { value: boolean; at: number } } = {};

type BreakerRow = { data: { value: unknown } | null; error: { message: string } | null };
export type BreakerRead = (key: BreakerKey) => Promise<BreakerRow>;

/**
 * Test seam. A global, not a module variable, so it survives `jest.resetModules()`, and set by
 * tests/helpers/offline-circuit-breakers.ts without importing this module (which would load
 * config.ts in every suite). Production never sets it.
 */
const READ_OVERRIDE = Symbol.for('repid-engine.circuit-breaker.read');

let localDefaults: Promise<void> | null = null;
function seedLocalDefaults(): Promise<void> {
  return (localDefaults ??= (async () => {
    for (const key of BREAKER_KEYS) {
      const { data } = await db.from('repid_config').select('value').eq('key', key).maybeSingle();
      if (!data) await db.from('repid_config').insert({ key, value: 'false', updated_by: 'local-mode-default' });
    }
  })().catch((e) => {
    localDefaults = null; // retry on the next read rather than refusing forever
    throw e;
  }));
}

/** Never throws: a thrown read becomes an error row, so the posture below decides, not the throw. */
async function readRow(key: BreakerKey): Promise<BreakerRow> {
  try {
    const override = (globalThis as any)[READ_OVERRIDE] as BreakerRead | undefined;
    if (override) return await override(key);
    if (LOCAL_MODE) await seedLocalDefaults();
    return (await db.from('repid_config').select('value').eq('key', key).maybeSingle()) as BreakerRow;
  } catch (e: any) {
    return { data: null, error: { message: e?.message ?? String(e) } };
  }
}

/** Test seam: replace the repid_config read (null restores the DB read). Clears the cache. */
export function __setBreakerRead(read: BreakerRead | null): void {
  if (read) (globalThis as any)[READ_OVERRIDE] = read;
  else delete (globalThis as any)[READ_OVERRIDE];
  cache = {};
}

export async function isTripped(key: BreakerKey): Promise<boolean> {
  const now = Date.now();
  const cached = cache[key];
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  const { data, error } = await readRow(key);
  if (error || !data) {
    // Fail OPEN: status reads only. Write guards use assertBreakerClosed, which fails closed.
    cache[key] = { value: false, at: now };
    return false;
  }
  const value = String((data as any).value).toLowerCase() === 'true';
  cache[key] = { value, at: now };
  return value;
}

/**
 * Non-HTTP breaker guard for state-changing chokepoints. Throws on both "tripped" and
 * "unreadable" (fail CLOSED), and logs the refusal so it is never silent.
 *
 * Callers should catch, log a `skipped_write`, and propagate — see
 * `erc8004-reputation.ts` / `erc8004-poster.ts`.
 */
export async function assertBreakerClosed(key: BreakerKey): Promise<void> {
  const now = Date.now();
  const cached = cache[key];
  let value: boolean;
  if (cached && now - cached.at < CACHE_TTL_MS) {
    value = cached.value;
  } else {
    const { data, error } = await readRow(key);
    if (error || !data) {
      // Fail CLOSED: cannot confirm the breaker is open → refuse the write.
      const msg = `circuit_breaker_unreadable: ${key} — failing closed (${error?.message ?? 'no config row'})`;
      console.error(`[circuit-breaker] REFUSED ${msg}`);
      throw new Error(msg);
    }
    value = String((data as any).value).toLowerCase() === 'true';
    cache[key] = { value, at: now };
  }
  if (value) {
    const msg = `circuit_breaker_open: ${key} — action refused (fail-closed).`;
    console.warn(`[circuit-breaker] REFUSED ${msg}`);
    throw new Error(msg);
  }
}

/** assertBreakerClosed as a boolean, for call sites whose refusal is "skip", not "throw". */
export async function breakerAllows(key: BreakerKey): Promise<boolean> {
  try {
    await assertBreakerClosed(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Route guard: 503 JSON when the switch is tripped or unreadable. It used to call isTripped,
 * which fails OPEN and never throws, so its "failing closed" branch could not run.
 */
export function breaker(key: BreakerKey) {
  return async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await assertBreakerClosed(key);
    } catch (e: any) {
      const unreadable = String(e?.message ?? '').startsWith('circuit_breaker_unreadable');
      return res.status(503).json({
        error: unreadable ? 'circuit_breaker_unknown' : 'circuit_breaker_open',
        breaker: key,
        message: unreadable
          ? `Could not read breaker state — failing closed. Details: ${e?.message ?? 'unknown'}`
          : `Action blocked by ${key}. Flip the value in repid_config to false (with Sean's approval) to re-enable.`,
      });
    }
    return next();
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
  const out: Partial<Record<BreakerKey, boolean>> = {};
  for (const k of BREAKER_KEYS) out[k] = await isTripped(k);
  return out as Record<BreakerKey, boolean>;
}
