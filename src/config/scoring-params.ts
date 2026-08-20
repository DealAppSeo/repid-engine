/**
 * scoring-params.ts — the tuned RepID constants, sourced from the environment.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ════════════════════════════════════════════════════════════════════════════════
 * Four files carried a header saying the tuned constants must not be exposed in a
 * public repo, and then declared those constants three lines below it:
 *
 *   layers/decay.ts             LAMBDA, K, DECAY_FLOOR, REDEMPTION_MODIFIER, …
 *   layers/challenge-scoring.ts WIN_BASE, LOSS_BASE, VIOLATION_MULTIPLIER, …
 *   layers/ecosystem-need.ts    PHI_INV, PHI_COMP, WEIGHT_FLOOR, WEIGHT_CAP, …
 *   layers/prediction-scoring.ts BASE_REWARD, TAU_DAYS, …
 *
 * `repid-engine` is PUBLIC. The rule and the code disagreed, and the code was the
 * part that was wrong — so the code is what changes. The values now come from the
 * environment; the repository keeps the SHAPE of the model and none of the tuning.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * FAIL LOUD, NEVER SILENTLY MIS-SCORE
 * ════════════════════════════════════════════════════════════════════════════════
 * In production a missing parameter THROWS at boot, naming the variable. It does
 * not fall back.
 *
 * That is deliberate and it is the whole safety argument. A fallback would mean a
 * deploy with unset variables scores every agent against different numbers than
 * the operator believes are in force — silently, and permanently, into an
 * append-only ledger that other systems treat as evidence. A service that refuses
 * to start is a five-minute fix; a ledger scored on phantom parameters is not
 * recoverable. This matches `config.ts`, which already throws on a missing
 * Supabase key rather than guessing.
 *
 * Outside production, clearly-labelled DEV placeholders are used so tests and a
 * fresh clone still run. They are NOT the tuned values and must never be treated
 * as a reference for them.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE VALUES ALREADY PUBLISHED ARE BURNED — TREAT THEM AS SUCH
 * ════════════════════════════════════════════════════════════════════════════════
 * This stops FUTURE tuning being public. It does not un-publish what already was:
 * the previous values are in the git history of a public repository and cannot be
 * recalled, exactly as a committed credential cannot. Removing a value from HEAD
 * is not the same as making it private.
 *
 * So the parameters set in the environment should be RE-TUNED, not a copy of what
 * was in the file. Anything reused verbatim is still public.
 */

/** Every tuned parameter, with the env var that supplies it. */
export interface ScoringParams {
  // --- decay -----------------------------------------------------------------
  decayLambda: number;
  decayK: number;
  decayFloor: number;
  decayCap: number;
  redemptionWindowDays: number;
  redemptionProsocialThreshold: number;
  redemptionModifier: number;
  // --- challenge -------------------------------------------------------------
  challengeWinBase: number;
  challengeLossBase: number;
  challengeViolationMultiplier: number;
  challengePeacemakerBonus: number;
  challengeSelfMonitorBonus: number;
  challengeAdherenceBonus: number;
  challengeMaxSingleReward: number;
  // --- ecosystem need --------------------------------------------------------
  needPhiInv: number;
  needPhiComp: number;
  needEpsilon: number;
  needWeightFloor: number;
  needWeightCap: number;
  // --- prediction ------------------------------------------------------------
  predictionBaseReward: number;
  predictionTauDays: number;
}

/**
 * Bounds, not values. These are structural invariants of the model — a decay
 * floor above 1.0 or a negative window is incoherent regardless of tuning — so
 * they stay in the repo and are enforced against whatever the environment supplies.
 * A fat-fingered env var is caught at boot rather than discovered in the ledger.
 */
const BOUNDS: Record<keyof ScoringParams, { min: number; max: number }> = {
  decayLambda: { min: 0, max: 1 },
  decayK: { min: 0, max: 10 },
  decayFloor: { min: 0, max: 1 },
  decayCap: { min: 0, max: 1 },
  redemptionWindowDays: { min: 1, max: 3650 },
  redemptionProsocialThreshold: { min: 1, max: 1000 },
  redemptionModifier: { min: 0, max: 1 },
  challengeWinBase: { min: 0, max: 10000 },
  challengeLossBase: { min: -10000, max: 0 },
  challengeViolationMultiplier: { min: 1, max: 100 },
  challengePeacemakerBonus: { min: 0, max: 10000 },
  challengeSelfMonitorBonus: { min: 0, max: 10000 },
  challengeAdherenceBonus: { min: 0, max: 10000 },
  challengeMaxSingleReward: { min: 0, max: 10000 },
  needPhiInv: { min: 0, max: 10 },
  needPhiComp: { min: 0, max: 10 },
  needEpsilon: { min: 0, max: 1 },
  needWeightFloor: { min: 0, max: 100 },
  needWeightCap: { min: 0, max: 100 },
  predictionBaseReward: { min: 0, max: 10000 },
  predictionTauDays: { min: 1, max: 3650 },
};

/** env var name for each parameter. */
const ENV: Record<keyof ScoringParams, string> = {
  decayLambda: 'REPID_DECAY_LAMBDA',
  decayK: 'REPID_DECAY_K',
  decayFloor: 'REPID_DECAY_FLOOR',
  decayCap: 'REPID_DECAY_CAP',
  redemptionWindowDays: 'REPID_REDEMPTION_WINDOW_DAYS',
  redemptionProsocialThreshold: 'REPID_REDEMPTION_PROSOCIAL_THRESHOLD',
  redemptionModifier: 'REPID_REDEMPTION_MODIFIER',
  challengeWinBase: 'REPID_CHALLENGE_WIN_BASE',
  challengeLossBase: 'REPID_CHALLENGE_LOSS_BASE',
  challengeViolationMultiplier: 'REPID_CHALLENGE_VIOLATION_MULTIPLIER',
  challengePeacemakerBonus: 'REPID_CHALLENGE_PEACEMAKER_BONUS',
  challengeSelfMonitorBonus: 'REPID_CHALLENGE_SELF_MONITOR_BONUS',
  challengeAdherenceBonus: 'REPID_CHALLENGE_ADHERENCE_BONUS',
  challengeMaxSingleReward: 'REPID_CHALLENGE_MAX_SINGLE_REWARD',
  needPhiInv: 'REPID_NEED_PHI_INV',
  needPhiComp: 'REPID_NEED_PHI_COMP',
  needEpsilon: 'REPID_NEED_EPSILON',
  needWeightFloor: 'REPID_NEED_WEIGHT_FLOOR',
  needWeightCap: 'REPID_NEED_WEIGHT_CAP',
  predictionBaseReward: 'REPID_PREDICTION_BASE_REWARD',
  predictionTauDays: 'REPID_PREDICTION_TAU_DAYS',
};

/**
 * DEV PLACEHOLDERS — deliberately NOT the tuned values.
 *
 * Round, obviously-synthetic numbers so that nobody can mistake this block for
 * the model's calibration, and so a test that accidentally depends on production
 * tuning fails loudly instead of passing for the wrong reason.
 *
 * Used ONLY outside NODE_ENV=production.
 */
const DEV_PLACEHOLDERS: ScoringParams = {
  decayLambda: 0.1, decayK: 0.1, decayFloor: 0.5, decayCap: 1.0,
  redemptionWindowDays: 30, redemptionProsocialThreshold: 5, redemptionModifier: 0.5,
  challengeWinBase: 10, challengeLossBase: -10, challengeViolationMultiplier: 2,
  challengePeacemakerBonus: 10, challengeSelfMonitorBonus: 10,
  challengeAdherenceBonus: 10, challengeMaxSingleReward: 100,
  needPhiInv: 0.5, needPhiComp: 0.5, needEpsilon: 0.01,
  needWeightFloor: 0.5, needWeightCap: 2.0,
  predictionBaseReward: 10, predictionTauDays: 30,
};

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? '').toLowerCase() === 'production';
}

function readOne(
  key: keyof ScoringParams,
  env: NodeJS.ProcessEnv,
  missing: string[],
): number {
  const raw = env[ENV[key]];
  if (raw === undefined || raw.trim() === '') {
    if (isProduction(env)) {
      missing.push(ENV[key]);
      return NaN;
    }
    return DEV_PLACEHOLDERS[key];
  }

  const n = Number(raw.trim());
  const b = BOUNDS[key];
  if (!Number.isFinite(n) || n < b.min || n > b.max) {
    // An out-of-range value is refused in EVERY environment. A typo that silently
    // becomes a live scoring parameter is the failure this module exists to stop.
    throw new Error(
      `[scoring-params] ${ENV[key]}='${raw}' is not a finite number within ` +
      `[${b.min}, ${b.max}]. Refusing to score against an incoherent parameter.`,
    );
  }
  return n;
}

/**
 * Resolve every parameter. Pure over the env object it is handed, so the
 * production-throws behaviour is testable without setting NODE_ENV globally.
 */
export function loadScoringParams(env: NodeJS.ProcessEnv = process.env): ScoringParams {
  const missing: string[] = [];
  const keys = Object.keys(ENV) as Array<keyof ScoringParams>;
  const out = {} as ScoringParams;
  for (const k of keys) out[k] = readOne(k, env, missing);

  if (missing.length > 0) {
    throw new Error(
      `[scoring-params] REFUSING TO START: ${missing.length} RepID scoring parameter(s) ` +
      `are unset in production — ${missing.join(', ')}. These are deliberately not ` +
      `committed (the repository is public); set them on the repid-engine service. ` +
      `Starting without them would score every agent against parameters nobody chose, ` +
      `into an append-only ledger.`,
    );
  }

  // Structural coherence the individual bounds cannot express.
  if (out.decayFloor > out.decayCap) {
    throw new Error(
      `[scoring-params] REPID_DECAY_FLOOR (${out.decayFloor}) exceeds REPID_DECAY_CAP ` +
      `(${out.decayCap}) — decay would be inverted.`,
    );
  }
  if (out.needWeightFloor > out.needWeightCap) {
    throw new Error(
      `[scoring-params] REPID_NEED_WEIGHT_FLOOR (${out.needWeightFloor}) exceeds ` +
      `REPID_NEED_WEIGHT_CAP (${out.needWeightCap}).`,
    );
  }

  return out;
}

/** Every env var this module requires in production — for the deploy checklist. */
export const REQUIRED_SCORING_ENV: string[] = Object.values(ENV).sort();

let cached: ScoringParams | null = null;

/**
 * Resolved once per process. Cached because these are deploy-time configuration,
 * not per-request input, and re-reading per scoring event would let a mid-run env
 * change split one agent's history across two rulers.
 */
export function scoringParams(): ScoringParams {
  if (cached === null) {
    cached = loadScoringParams();
    if (!isProduction()) {
      console.warn(
        '[scoring-params] NON-PRODUCTION: using DEV PLACEHOLDER scoring parameters. ' +
        'These are NOT the tuned values and any score produced here is not comparable ' +
        'to production.',
      );
    }
  }
  return cached;
}

/** Test seam only. */
export function __resetScoringParamsCache(): void {
  cached = null;
}
