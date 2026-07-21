/**
 * anfis-poa-feed.ts — the ANFIS reward-model FEED (reward-model-as-router, SHADOW-ONLY).
 *
 * WHAT THIS IS
 * ------------
 * The missing loop-closer for ANFIS routing. Today the ANFIS router is shadow: it *recommends*
 * a provider/tier per request (src/services/anfis-router.ts → anfis-shadow-persist.ts) and a
 * separate cron re-tunes PROVIDER weights from raw call health (src/services/anfis-retune.ts,
 * `llm_call_log` success/latency). But NEITHER path learns from whether the answer was actually
 * RIGHT. This module turns Proof-of-Action (POA) OUTCOMES — the ground-truth signal RepID already
 * computes (correct? confident? what RepID delta did it earn?) — into a per-(model, taskType)
 * TRUST WEIGHT. That weight is the reward-model-as-router: "for THIS task type, how much should we
 * trust THIS model, given how its past answers actually turned out."
 *
 * THE REWARD (proper scoring rule)
 * --------------------------------
 * A model asserts an answer with `confidence` p∈[0,1] and it is later judged `correct` (y∈{0,1}).
 * The reward is the Brier reward  r = 1 − (p − y)²  — one minus the Brier score, which is a STRICTLY
 * PROPER scoring rule: a model maximizes its expected reward ONLY by reporting its true probability
 * of being correct. Consequences that fall straight out of properness:
 *   - correct + high confidence  (p→1, y=1) → r→1  (weight moves UP)
 *   - confident + WRONG          (p→1, y=0) → r→0  (weight moves DOWN, hard)
 *   - hedged/low-confidence            → r near 0.75 either way (small move — it didn't overclaim)
 * The realized RepID delta is folded in as a bounded confirming nudge (tanh-squashed) so real
 * RepID outcomes tilt trust too, but it CANNOT overturn the correctness signal for the extreme
 * cases (a confident-wrong answer with a positive delta still scores below the neutral start).
 *
 * The per-(model,taskType) weight is an EXPONENTIAL MOVING AVERAGE of that reward:
 *   w' = (1 − α)·w + α·r          (α = EMA responsiveness, default 0.2)
 * so recent outcomes dominate, old ones decay — the router's trust tracks current behavior.
 *
 * SHADOW-ONLY / SAFETY (why this is safe to run now)
 * --------------------------------------------------
 * - It only WRITES to a NEW additive table `anfis_trust_weights`. NOTHING in the live routing path
 *   READS that table, so producing these weights changes ZERO routing, RepID, HAL, or on-chain
 *   behavior. It is pure telemetry/learning in the shadow.
 * - Every row carries `routed_live = false` (advisory-purity marker, same discipline as
 *   anfis_decisioning_suggestions). Flipping to live is a SEPARATE, Sean-gated change — see the
 *   "PROMOTION TO LIVE" block at the bottom of this file for the exact one-line seam.
 * - Persistence is env-reversible (`ANFIS_POA_FEED_PERSIST=false` → compute-only dry run) and the
 *   write is TOLERANT: it never throws to the caller and never blocks the RepID event that fed it.
 * - No scoring formula / ANFIS params / secrets are written to the row.
 *
 * SCHEMA: migrations/2026-07-21-anfis-trust-weights.sql (FILE ONLY — not applied; prod DDL is Sean-gated).
 */

// Lazy DB handle so unit tests can inject a fake client without touching config/network.
import type { SupabaseClient } from '@supabase/supabase-js';

export const ANFIS_TRUST_WEIGHTS_TABLE = 'anfis_trust_weights';

/** Neutral prior for a never-before-seen (model, taskType): "no evidence yet, trust at the midpoint." */
export const DEFAULT_TRUST_WEIGHT = 0.5;
/** EMA responsiveness. 0.2 ≈ last ~5 outcomes dominate. Reversible via ANFIS_POA_EMA_ALPHA. */
export const DEFAULT_EMA_ALPHA = 0.2;
/** How hard the realized RepID delta may nudge the reward (bounded; correctness stays dominant). */
export const REPID_NUDGE = 0.15;
/** RepID delta scale for the tanh squash (≈ one FIXED_DELTAS-sized event saturates the nudge). */
export const REPID_DELTA_SCALE = 25;

/** The POA outcome fed to the reward model. Mirrors what src/engine/repid-update.ts already knows. */
export interface PoaOutcome {
  /** Agent that produced the action (for attribution/audit; not part of the weight key). */
  agent: string;
  /** Model that generated the answer — half of the trust-weight key. */
  model: string;
  /** Model family (llama/gemini/…) — carried for family-level rollups, from the family registry. */
  family?: string;
  /** Task type (fact-check / prediction / challenge / …) — the other half of the trust-weight key. */
  taskType: string;
  /** The model's self-reported probability of being correct, p∈[0,1] (percentages >1 are /100). */
  confidence: number;
  /** Ground-truth judgment of the action. */
  correct: boolean;
  /** Realized RepID delta the action earned (confirming nudge; may be 0/undefined). */
  repidDelta?: number;
  /** Role the model played (e.g. 'proposer' | 'verifier' | 'judge') — audit only. */
  role?: string;
}

export interface PoaIngestResult {
  model: string;
  taskType: string;
  family: string | null;
  reward: number;
  weightBefore: number;
  weightAfter: number;
  sampleCount: number;
  /** true when the new weight was upserted to anfis_trust_weights; false on dry-run/skip/error. */
  persisted: boolean;
}

export interface PoaIngestOptions {
  /** EMA responsiveness override. Default DEFAULT_EMA_ALPHA / env ANFIS_POA_EMA_ALPHA. */
  alpha?: number;
  /** Force dry-run (compute, return, write nothing). Default: follow ANFIS_POA_FEED_PERSIST env (ON). */
  persist?: boolean;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/** Normalize a confidence input to a probability in [0,1] (accepts 0..1 or 0..100 percentages). */
export function normalizeConfidence(confidence: number): number {
  const c = Number(confidence);
  if (Number.isNaN(c)) return 0.5;
  return clamp01(c > 1 ? c / 100 : c);
}

/**
 * Brier reward: r = 1 − (p − y)², strictly proper. p = confidence, y = correct?1:0.
 * Max (1) at correct+certain; min (0) at confident+wrong.
 */
export function properScoreReward(confidence: number, correct: boolean): number {
  const p = normalizeConfidence(confidence);
  const y = correct ? 1 : 0;
  const brier = (p - y) ** 2;
  return clamp01(1 - brier);
}

/** Bounded confirming nudge from the realized RepID delta: REPID_NUDGE · tanh(delta / scale) ∈ (−N, N). */
export function repidDeltaNudge(repidDelta: number | undefined): number {
  if (!repidDelta || Number.isNaN(repidDelta)) return 0;
  return REPID_NUDGE * Math.tanh(repidDelta / REPID_DELTA_SCALE);
}

/** Full reward for one outcome: proper score + bounded RepID-delta nudge, clamped to [0,1]. */
export function computeReward(o: Pick<PoaOutcome, 'confidence' | 'correct' | 'repidDelta'>): number {
  return clamp01(properScoreReward(o.confidence, o.correct) + repidDeltaNudge(o.repidDelta));
}

/** EMA update: w' = (1−α)·w + α·r. */
export function emaUpdate(prev: number, reward: number, alpha: number): number {
  const a = Math.max(0, Math.min(1, alpha));
  return (1 - a) * prev + a * reward;
}

function poaPersistEnabled(): boolean {
  return process.env.ANFIS_POA_FEED_PERSIST !== 'false';
}

function resolveAlpha(opts?: PoaIngestOptions): number {
  if (opts?.alpha != null) return opts.alpha;
  const env = Number(process.env.ANFIS_POA_EMA_ALPHA);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_EMA_ALPHA;
}

/** Lazy db handle — avoids importing config at module load so pure-math tests need no env/network. */
function getDb(): SupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../db').db as SupabaseClient;
}

/** Read the current trust weight + counters for (model, taskType). Returns null when unseen or on error. */
async function readTrustWeight(
  sb: SupabaseClient,
  model: string,
  taskType: string,
): Promise<{ trust_weight: number; sample_count: number; cumulative_reward: number } | null> {
  try {
    const { data, error } = await (sb as any)
      .from(ANFIS_TRUST_WEIGHTS_TABLE)
      .select('trust_weight, sample_count, cumulative_reward')
      .eq('model', model)
      .eq('task_type', taskType)
      .maybeSingle();
    if (error || !data) return null;
    return {
      trust_weight: Number(data.trust_weight),
      sample_count: Number(data.sample_count) || 0,
      cumulative_reward: Number(data.cumulative_reward) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Ingest one POA outcome → update the per-(model, taskType) trust weight (EMA of the proper-scoring
 * reward) and (unless dry-run) upsert it to anfis_trust_weights. SHADOW-ONLY: nothing live reads the
 * weight, so this never changes routing/RepID/HAL. Tolerant — never throws to the caller.
 *
 * @param outcome the POA outcome (agent/model/family/taskType/confidence/correct/repidDelta/role)
 * @param sb      supabase client (defaults to the shared db; injectable for tests)
 * @param opts    alpha / persist overrides
 */
export async function ingestPoaOutcome(
  outcome: PoaOutcome,
  sb?: SupabaseClient,
  opts?: PoaIngestOptions,
): Promise<PoaIngestResult> {
  const client = sb ?? getDb();
  const alpha = resolveAlpha(opts);
  const persist = opts?.persist === false ? false : opts?.persist === true ? true : poaPersistEnabled();

  const reward = computeReward(outcome);

  const prior = await readTrustWeight(client, outcome.model, outcome.taskType);
  const weightBefore = prior?.trust_weight ?? DEFAULT_TRUST_WEIGHT;
  const priorSamples = prior?.sample_count ?? 0;
  const priorCumReward = prior?.cumulative_reward ?? 0;

  const weightAfter = emaUpdate(weightBefore, reward, alpha);
  const sampleCount = priorSamples + 1;
  const family = outcome.family ?? null;

  const result: PoaIngestResult = {
    model: outcome.model,
    taskType: outcome.taskType,
    family,
    reward: +reward.toFixed(5),
    weightBefore: +weightBefore.toFixed(5),
    weightAfter: +weightAfter.toFixed(5),
    sampleCount,
    persisted: false,
  };

  if (!persist) return result;

  const now = new Date().toISOString();
  const row = {
    model: outcome.model,
    task_type: outcome.taskType,
    family,
    trust_weight: +weightAfter.toFixed(5),
    ema_alpha: +alpha.toFixed(4),
    sample_count: sampleCount,
    last_reward: +reward.toFixed(5),
    last_confidence: +normalizeConfidence(outcome.confidence).toFixed(5),
    last_correct: outcome.correct,
    last_repid_delta: outcome.repidDelta ?? null,
    cumulative_reward: +(priorCumReward + reward).toFixed(6),
    last_agent: outcome.agent,
    last_role: outcome.role ?? null,
    // Advisory-purity marker: this weight has NOT routed any live traffic. The promotion flip (a
    // separate Sean-gated migration) is what would ever set this true.
    routed_live: false,
    updated_at: now,
    notes: { source: 'ingestPoaOutcome', shadow: true },
  };

  try {
    const { error } = await (client as any)
      .from(ANFIS_TRUST_WEIGHTS_TABLE)
      .upsert(row, { onConflict: 'model,task_type' });
    if (error) {
      console.error('[anfis-poa-feed] upsert error:', error.message);
      return result;
    }
    result.persisted = true;
  } catch (e: any) {
    console.error('[anfis-poa-feed] upsert threw:', e?.message ?? e);
  }
  return result;
}

/** Convenience: ingest a batch of outcomes sequentially (read-modify-write per key stays consistent). */
export async function ingestPoaOutcomes(
  outcomes: PoaOutcome[],
  sb?: SupabaseClient,
  opts?: PoaIngestOptions,
): Promise<PoaIngestResult[]> {
  const out: PoaIngestResult[] = [];
  for (const o of outcomes) out.push(await ingestPoaOutcome(o, sb, opts));
  return out;
}

/*
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PROMOTION TO LIVE (Sean-gated; NOT done here)
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * This feed is shadow because NOTHING reads anfis_trust_weights in the routing path. To flip it
 * from shadow to live, a future PR would:
 *   1. Apply migrations/2026-07-21-anfis-trust-weights.sql to prod (Sean co-sign — prod DDL is gated).
 *   2. Add a reader — e.g. `getTrustWeight(model, taskType)` here — and consult it inside the
 *      provider/tier selection in src/services/anfis-router.ts (anfisRecommendProvider) and/or the
 *      static picker in src/providers/router.ts: tie-break or re-rank candidate (model, taskType)
 *      pairs by trust_weight instead of using only the static cost order.
 *   3. Gate that read behind a new env flag (e.g. ANFIS_POA_ROUTING=true, default OFF) so the flip
 *      is loud + one-line reversible, and drop `routed_live=false` for rows that actually route.
 * Until all three land, this module only LEARNS; it never STEERS.
 */
