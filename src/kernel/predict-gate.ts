/**
 * predict-gate.ts — WHEN does an agent make a prediction? (the loop's Predict trigger)
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ════════════════════════════════════════════════════════════════════════════════
 * `kernel/commitment.ts` is the Predict → Commit leg: it commits a prediction BEFORE the
 * grant and records calibration (never scored). THIS module decides whether a prediction
 * should be made AT ALL, so an agent predicts only when it is worth a commitment and never
 * on every call. It encodes the scoring decision (strategy §v0.2.15): predict only when the
 * action is CONSEQUENTIAL, or on a small random SAMPLE, or when the anomaly observer (LAO)
 * has already fired.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THREE TRIGGERS, OR'd — AND LAYA NEVER VOTES
 * ════════════════════════════════════════════════════════════════════════════════
 *   consequential  the action spends, posts, writes, or otherwise LEAVES THE MACHINE. This
 *                  is a DETERMINISTIC structural read of the action's tool class — not an
 *                  opinion. It is the authoritative half of the gate.
 *   sample         a small random sample fired (the "1-in-N" canary), so calibration data
 *                  keeps accruing on ordinary actions too. Injected, so the rate never has to
 *                  be a magic number in this file and tests are deterministic.
 *   lao_fired      the anomaly observer already flagged this action; predict so the claim is
 *                  on record before anything leaves.
 *
 * Laya (`laya/classify.ts`) is consulted ONLY as a SHADOW signal — its opinion of whether
 * the action looks consequential is RECORDED for drift metrics and is NEVER a vote in the
 * decision. This is the house rule made structural: a classifier proposes, it does not
 * dispose. A test proves that a 'cheap' Laya route cannot suppress a structurally
 * consequential action, and an 'escalate' Laya route cannot by itself cause a prediction.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * NEVER A SECOND FULL ANSWER, NEVER ON THE HOT PATH
 * ════════════════════════════════════════════════════════════════════════════════
 * The commitment an agent makes when this fires is STRUCTURED — a success criterion plus a
 * confidence (`commitment.ts::PredictionClaim`) — not a re-run of the task. And this gate is
 * PURE and SYNCHRONOUS: no network, no DB, no await. It cannot sit on the hot path because it
 * does no blocking work; the Laya read it uses is the local, no-network classifier.
 */

import type { ToolClass } from './types';
import { classify, type LayaClassification, type LayaRoute } from '../laya/classify';
import type { PredictionClaim } from './commitment';

/** The structured commitment the loop records when a prediction fires — never a second answer. */
export type PredictionCommitShape = PredictionClaim;

export type PredictTrigger = 'consequential' | 'sample' | 'lao_fired';

export interface PredictAction {
  /** The kernel tool class. `spend` and `post` leave the machine and are consequential. */
  toolClass: ToolClass;
  /** Optional tool name, for the audit trail only. */
  toolName?: string;
  /**
   * For a `read` / `other` class that nonetheless WRITES to trusted state or egresses (a tool
   * that leaves the machine): set true to mark it consequential. Default false — a plain read
   * is not consequential.
   */
  leavesMachine?: boolean;
  /** The anomaly observer (LAO) already fired on this action. */
  laoFired?: boolean;
  /** Text for Laya's SHADOW classification ONLY. Never affects the decision. */
  text?: string;
}

export interface PredictGateDeps {
  /**
   * The small random sample ("1-in-N"). Injected so the rate is never a magic literal here and
   * tests are deterministic. ABSENT ⇒ the sample trigger is OFF (consequential and LAO still
   * fire) — a conservative default, not a guessed rate. `envSampler` builds the production one.
   */
  sample?: () => boolean;
  /** Laya classifier, SHADOW only. Defaults to the real local `classify`. Never votes. */
  layaClassify?: (text: string) => LayaClassification;
}

export interface ShouldPredictResult {
  /** Fire a prediction? True iff at least one trigger fired. */
  predict: boolean;
  /** The DETERMINISTIC structural verdict: does this action spend/post/write/leave the machine? */
  consequential: boolean;
  /** Every trigger that fired, in priority order. Empty ⇒ no prediction. */
  triggers: PredictTrigger[];
  /** Laya's opinion — RECORDED, never a vote. */
  shadow: {
    layaRoute: LayaRoute | null;
    /** Laya's read of "looks consequential" (escalate). null when no text was given. */
    layaSaysConsequential: boolean | null;
    /** Did Laya agree with the structural verdict? For drift metrics only; never gates anything. */
    agreesWithVerdict: boolean | null;
  };
  detail: {
    toolClass: ToolClass;
    leavesMachine: boolean;
    sampled: boolean;
    laoFired: boolean;
  };
}

/** A `spend` or `post` leaves the machine; so does anything explicitly flagged `leavesMachine`. */
export function isConsequential(action: Pick<PredictAction, 'toolClass' | 'leavesMachine'>): boolean {
  if (action.toolClass === 'spend' || action.toolClass === 'post') return true;
  return action.leavesMachine === true;
}

/**
 * Decide whether to make a prediction. PURE and SYNCHRONOUS — no I/O, so it cannot sit on the
 * hot path. The three triggers are OR'd; Laya is read only into the shadow block and never
 * changes the decision.
 */
export function shouldPredict(action: PredictAction, deps: PredictGateDeps = {}): ShouldPredictResult {
  const consequential = isConsequential(action);
  const sampled = deps.sample ? deps.sample() === true : false;
  const laoFired = action.laoFired === true;

  const triggers: PredictTrigger[] = [];
  if (consequential) triggers.push('consequential');
  if (sampled) triggers.push('sample');
  if (laoFired) triggers.push('lao_fired');

  // SHADOW — Laya's opinion is recorded, never a vote. It reads the action text with the local,
  // no-network classifier and its route is stored for drift comparison only.
  let layaRoute: LayaRoute | null = null;
  let layaSaysConsequential: boolean | null = null;
  let agreesWithVerdict: boolean | null = null;
  if (typeof action.text === 'string') {
    const classifier = deps.layaClassify ?? classify;
    try {
      layaRoute = classifier(action.text).route;
      layaSaysConsequential = layaRoute === 'escalate';
      agreesWithVerdict = layaSaysConsequential === consequential;
    } catch {
      // A shadow failure must never affect the decision — leave the shadow null.
      layaRoute = null;
      layaSaysConsequential = null;
      agreesWithVerdict = null;
    }
  }

  return {
    predict: triggers.length > 0,
    consequential,
    triggers,
    shadow: { layaRoute, layaSaysConsequential, agreesWithVerdict },
    detail: {
      toolClass: action.toolClass,
      leavesMachine: action.leavesMachine === true,
      sampled,
      laoFired,
    },
  };
}

// ── the production sampler (env-sourced rate; not required for the pure gate above) ──────────

/**
 * Build the production sampler from `REPID_PREDICT_SAMPLE_RATE` (a probability in [0,1], e.g.
 * the 1-in-20 canary). FAIL-CLOSED: if the rate is unset or incoherent in production the sampler
 * returns false (sampling OFF) rather than guessing a rate — consequential and LAO triggers are
 * unaffected. Outside production an obviously-synthetic dev placeholder lets a fresh clone and the
 * tests exercise the path. The rate is a deploy-time policy knob, so it lives in the environment,
 * not in this public file.
 */
export function envSampler(env: NodeJS.ProcessEnv = process.env, rng: () => number = Math.random): () => boolean {
  const rate = resolveSampleRate(env);
  if (rate <= 0) return () => false;
  return () => rng() < rate;
}

const DEV_SAMPLE_RATE_PLACEHOLDER = 0.05; // synthetic dev placeholder ONLY; prod sets the real rate

function resolveSampleRate(env: NodeJS.ProcessEnv): number {
  const raw = env['REPID_PREDICT_SAMPLE_RATE'];
  const isProd = (env.NODE_ENV ?? '').toLowerCase() === 'production';
  if (raw === undefined || raw.trim() === '') {
    return isProd ? 0 : DEV_SAMPLE_RATE_PLACEHOLDER; // fail closed in prod; dev placeholder otherwise
  }
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return 0; // incoherent ⇒ sampling off, never a guessed rate
  }
  return n;
}
