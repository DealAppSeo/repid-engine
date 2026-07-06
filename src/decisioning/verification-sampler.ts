/**
 * UNIFORM-RANDOM VERIFICATION FLOOR (§7 anti-bias) — labels-not-biased-toward-suspicion.
 * OUTPUT_PATH: src/decisioning/verification-sampler.ts
 * SPEC: PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md §7.
 *
 * WHY: the training LABEL is quality-only = quorum verdict PLUS a uniform-random verification floor
 * (~5%) so labels aren't biased toward suspicion-triggered calls (§7). If we only labeled calls that
 * HAL/confidence flagged, the learned model would inherit HAL's blind spots. This module selects a
 * uniform-random slice of COMPLETED calls into a label queue — the selection is a function of the call
 * id + a config seed ONLY, never of any suspicion/confidence/HAL signal.
 *
 * TRULY UNIFORM (the anti-bias guarantee): inclusion(call) = hash(seed, call_id) / 2^32 < rate.
 *   - It reads ONLY the call_id (opaque uuid) and the config seed. It has NO access to and takes NO
 *     input from confidence, HAL verdict, cost, latency, provider, or any suspicion signal (R4 no theater
 *     — a "uniform" sampler that peeked at confidence would be a lie). The type signature enforces this:
 *     `shouldSample` accepts a bare id string, nothing else.
 *   - Because a uuid v4 is effectively random, hashing it yields a uniform [0,1) independent of every
 *     call property, so the expected inclusion rate == `rate` regardless of traffic composition.
 * SEEDABLE (test determinism): same (seed, id) -> same decision. A fixed seed reproduces the exact
 *   sampled set (needed for the rate self-test and for auditability). FNV-1a 32-bit, same hash family as
 *   disjointness.ts seeded rotation.
 * CONFIG-DRIVEN (not hardcoded): rate + seed come from SamplerConfig, defaulted from repid_config-style
 *   env keys, NEVER a literal at the call site. Default rate 0.05 (the §7 "~5%").
 *
 * COMPLETED CALL [V Supabase qnnpjhlxljtqyigedwkb 2026-07-05]: llm_call_log.status is one of
 *   {'success','failed','rate_limited'} (322,062 rows: 163,708 failed / 157,025 success / 2,480 rate_limited).
 *   "Completed" = a TERMINAL status (any of the three) — a call that ran to completion. The floor samples
 *   over ALL completed calls, NOT only successes: excluding failures would re-introduce an outcome bias
 *   (we want failures labeled too). Outcome filtering is the CALLER's choice via `isCompleted`, defaulting
 *   to "has a terminal status".
 *
 * ADVISORY PURITY (R3): pure functions only. No DB writes, no routing. The label-queue table is a
 * migration FILE (migrations/2026-07-05-label-queue.sql); selecting a call marks it for later labeling,
 * it does NOT change any live behavior. PROMOTION-GATED.
 */

/** Terminal statuses of llm_call_log [V 2026-07-05]. A call with one of these has COMPLETED. */
export const TERMINAL_STATUSES = Object.freeze(['success', 'failed', 'rate_limited'] as const);
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/** Minimal shape of a completed call the sampler needs. Deliberately excludes any suspicion signal. */
export interface CompletedCall {
  /** llm_call_log.id (uuid PK) — the ONLY field the inclusion decision reads. */
  id: string;
  /** llm_call_log.status — used ONLY to gate "is this call completed", never to bias inclusion. */
  status?: string | null;
}

export interface SamplerConfig {
  /** verification floor rate in [0,1]. Default 0.05 (§7 "~5%"). Config-driven, never hardcoded at call site. */
  rate: number;
  /** deterministic seed — a fixed seed reproduces the exact sampled set (test + audit). */
  seed: string;
}

/** Env keys the floor is driven by (repid_config-style). Read via configFromEnv(); NOT literals. */
export const SAMPLER_ENV = Object.freeze({
  RATE: 'DECISIONING_VERIFY_FLOOR_RATE',
  SEED: 'DECISIONING_VERIFY_FLOOR_SEED',
});

export const DEFAULT_SAMPLER_RATE = 0.05;
export const DEFAULT_SAMPLER_SEED = 'verify-floor-v1';

/**
 * Build a SamplerConfig from env (config-driven default). Invalid/missing rate falls back to the §7
 * default 0.05 with a loud warning (no silent bad-rate). Rate is clamped to [0,1].
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SamplerConfig {
  const raw = env[SAMPLER_ENV.RATE];
  let rate = DEFAULT_SAMPLER_RATE;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
      rate = parsed;
    } else {
      console.warn(
        `[verification-sampler] ${SAMPLER_ENV.RATE}="${raw}" is not a valid rate in [0,1]; ` +
          `falling back to default ${DEFAULT_SAMPLER_RATE}.`,
      );
    }
  }
  const seed = env[SAMPLER_ENV.SEED] || DEFAULT_SAMPLER_SEED;
  return { rate, seed };
}

/** FNV-1a 32-bit — same hash family as disjointness.ts seeded rotation (deterministic, no RNG). */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const UINT32 = 0x100000000; // 2^32

/**
 * Uniform inclusion score in [0,1) for a call id under a seed. This is a pure hash of (seed, id) — it
 * CANNOT read any suspicion/confidence signal (there is nowhere in this signature to pass one). Because
 * a uuid is effectively random, the score is uniform on [0,1) and independent of every call property.
 */
export function inclusionScore(id: string, seed: string): number {
  return fnv1a32(`${seed}:${id}`) / UINT32;
}

/**
 * Decide whether a single call is in the verification floor. Deterministic given (seed, id).
 * @returns true iff inclusionScore < rate (so the expected fraction sampled == rate).
 */
export function shouldSample(id: string, cfg: SamplerConfig): boolean {
  if (cfg.rate <= 0) return false;
  if (cfg.rate >= 1) return true;
  return inclusionScore(id, cfg.seed) < cfg.rate;
}

/** Default "is completed" predicate: the call has a terminal status. Caller may override. */
export function isCompletedDefault(call: CompletedCall): boolean {
  return typeof call.status === 'string' && (TERMINAL_STATUSES as readonly string[]).includes(call.status);
}

export interface SampleResult {
  /** ids selected into the verification floor (uniform-random slice). */
  sampledIds: string[];
  /** how many completed calls were considered (denominator). */
  consideredCount: number;
  /** how many were skipped as not-completed (excluded before sampling). */
  skippedNotCompleted: number;
  /** observed inclusion fraction = sampledIds.length / consideredCount (0 if none considered). */
  observedRate: number;
  cfg: SamplerConfig;
}

/**
 * Select the uniform-random verification floor over a batch of COMPLETED calls.
 * NOT coupled to suspicion/confidence: the only per-call inputs are `id` (for the hash) and `status`
 * (for the completed gate). Deterministic given (cfg.seed, ids).
 *
 * @param calls candidate calls (a page of llm_call_log rows)
 * @param cfg   {rate, seed} — config-driven
 * @param isCompleted optional override of the completed predicate (default: terminal status)
 */
export function selectVerificationFloor(
  calls: CompletedCall[],
  cfg: SamplerConfig,
  isCompleted: (c: CompletedCall) => boolean = isCompletedDefault,
): SampleResult {
  const sampledIds: string[] = [];
  let considered = 0;
  let skipped = 0;
  for (const c of calls) {
    if (!isCompleted(c)) {
      skipped++;
      continue;
    }
    considered++;
    if (shouldSample(c.id, cfg)) sampledIds.push(c.id);
  }
  const observedRate = considered > 0 ? sampledIds.length / considered : 0;
  return { sampledIds, consideredCount: considered, skippedNotCompleted: skipped, observedRate, cfg };
}
