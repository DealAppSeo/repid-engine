/**
 * context-frame.ts — the durable state of a task, addressable, outliving any model's context window.
 *
 * TERMINOLOGY: "Context Frame" is borrowed from the OmegaClaw/OmegaHive design papers
 * (Goertzel, *Seeding RSI Toward ASI*, 2026-08-07); see docs/RSI-ADOPTION-PLAN.md §3.3.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY WE NEEDED A NAME FOR THIS AND DID NOT HAVE ONE
 * ════════════════════════════════════════════════════════════════════════════════
 * We have durable task state in several places already — `trinity_tasks`, the append-only
 * `repid_score_events` audit trail, `src/memory/proof-carrying-memory.ts`,
 * `src/decisioning/routing-record.ts`. What we did not have was the FRAME: one addressable
 * object holding goals, hypotheses, evidence, budgets, provenance, completion criteria, and
 * — the field none of those carry — a PREDICTION made before the fact.
 *
 * Completion criteria matter here beyond the paper's reasons. NORTH-STAR records nine
 * competing "what do I do next" surfaces across the stack, and `trinity_tasks` is canonical
 * precisely because the others had no completion semantics: a surface that cannot say when an
 * item is DONE accumulates items forever and is abandoned rather than finished.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE COMMITMENT, AND THE ONE INVARIANT THAT MAKES IT WORTH ANYTHING
 * ════════════════════════════════════════════════════════════════════════════════
 * A commitment is a prediction SEALED BEFORE the action it predicts. Sealed afterwards it is
 * not a prediction, it is a description — and a description is exactly what a miscalibrated
 * agent would produce if given the chance. So the ordering is not a nicety, it is the entire
 * content of the mechanism, and `commitmentOrderFault` below is the check that enforces it.
 *
 * That check exists NOW, in Phase 1, although nothing writes a commitment until Phase 3. It is
 * here so the Phase 3 promotion gate is checkable rather than assertable: LESSONS §6 asks for a
 * test that goes red when you break the property, and the property is an ordering, so the test
 * is "reverse the order and watch it fail".
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT COMMITMENTS ARE **NOT** ALLOWED TO FEED
 * ════════════════════════════════════════════════════════════════════════════════
 * DECIDED 2026-08-17 (Sean; see DECISIONS.md and docs/RSI-ADOPTION-PLAN.md §3.1):
 * calibration derived from commitments is a **SEPARATE PORTABLE SCORE**. It is never an input
 * to RepID.
 *
 * The reason is not architectural taste. RepID numbers are published, on-chain in places, and
 * carried in badges and attestations; folding a new term into the score would silently change
 * the meaning of every number already issued under the old one, with no way for a holder to
 * tell which definition produced theirs. A separate score leaves every existing RepID meaning
 * exactly what it meant.
 *
 * This module therefore defines the commitment and stops. It deliberately does NOT define a
 * calibration record, a Brier term, or any type that could be mistaken for a scoring input —
 * an unwired mechanism converts a known gap into false coverage (LESSONS §3), and the gap here
 * is a Phase 3 gap that should stay visible.
 *
 * PURITY: no I/O, no env reads, no DB, no clock. Timestamps are ISO-8601 strings supplied by
 * callers; every function here is a function of its arguments.
 */

/** ISO-8601 instant. Kept as a string so a frame round-trips through JSON unchanged. */
export type Iso8601 = string;

/** Parse an ISO instant to epoch ms, or null when unparseable. Never throws. */
function instant(iso: Iso8601): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * A prediction, sealed before the action it predicts.
 *
 * `hash` is the commitment proper — the digest of the predicted outcome, computed and stored at
 * seal time so the prediction cannot be edited afterwards. This module does not compute it
 * (that needs a hash function and therefore an opinion about which one); it carries it and
 * checks the ordering around it. Phase 4 proves statements over sets of these.
 */
export interface Commitment {
  /** Digest of the predicted outcome, fixed at seal time. */
  readonly hash: string;
  /** When the prediction was sealed. MUST precede the action. */
  readonly sealedAt: Iso8601;
  /** Human-readable prediction. Present for audit; the hash is what binds. */
  readonly predictedOutcome: string;
  /** Self-reported confidence in [0,1]. This is the number calibration will eventually grade. */
  readonly selfConfidence: number;
  /** Optional predicted resource use, for the cost/latency axes of the evaluation ecology. */
  readonly predictedCostUsd?: number;
  readonly predictedLatencyMs?: number;
}

/** A problem with a commitment. */
export interface CommitmentFault {
  code: 'SEALED_AFTER_ACTION' | 'SEALED_AT_ACTION' | 'UNPARSEABLE_TIME' | 'CONFIDENCE_OUT_OF_RANGE' | 'EMPTY_HASH';
  message: string;
}

/**
 * The ordering check: a commitment must be sealed STRICTLY BEFORE the action starts.
 *
 * Equal timestamps are refused, not allowed. A commitment stamped at the same instant as the
 * action it predicts is indistinguishable from one written by the same code path that performed
 * the action, which is the failure this check exists to catch. Refusing the ambiguous case costs
 * a caller one clock tick; permitting it costs the mechanism its meaning.
 *
 * Returns null when the commitment is well-formed and correctly ordered.
 */
export function commitmentOrderFault(
  commitment: Commitment,
  actionStartedAt: Iso8601,
): CommitmentFault | null {
  if (commitment.hash.trim() === '') {
    return { code: 'EMPTY_HASH', message: 'commitment has no hash; nothing is bound' };
  }
  if (!(commitment.selfConfidence >= 0 && commitment.selfConfidence <= 1)) {
    return {
      code: 'CONFIDENCE_OUT_OF_RANGE',
      message: `selfConfidence must be in [0,1], got ${commitment.selfConfidence}`,
    };
  }

  const sealed = instant(commitment.sealedAt);
  const acted = instant(actionStartedAt);
  if (sealed === null || acted === null) {
    return {
      code: 'UNPARSEABLE_TIME',
      message:
        `could not order commitment against action ` +
        `(sealedAt='${commitment.sealedAt}', actionStartedAt='${actionStartedAt}')`,
    };
  }

  if (sealed > acted) {
    return {
      code: 'SEALED_AFTER_ACTION',
      message:
        `commitment sealed at ${commitment.sealedAt}, after the action started at ${actionStartedAt}. ` +
        `A prediction made after the fact is a description.`,
    };
  }
  if (sealed === acted) {
    return {
      code: 'SEALED_AT_ACTION',
      message:
        `commitment sealed at the same instant the action started (${actionStartedAt}); ` +
        `ordering cannot be established, so the prediction is refused`,
    };
  }
  return null;
}

/**
 * A completion criterion. Three outcomes, never two.
 *
 * `met: null` is NOT_CHECKED and is the DEFAULT, because the repo-wide rule is that two
 * outcomes collapse "we did not look" into "it passed" (trinity-ecosystem/CLAUDE.md).
 */
export interface CompletionCriterion {
  readonly id: string;
  readonly description: string;
  /** true = VERIFIED, false = FAILED, null = NOT_CHECKED. */
  readonly met: boolean | null;
}

/** A resource ceiling for the frame. `spent` is observed; `limit` is the ceiling. */
export interface Budget {
  readonly unit: 'usd' | 'tokens' | 'ms' | 'calls';
  readonly limit: number;
  readonly spent: number;
}

/** Where a piece of state came from. `[R]` recalled content is marked at the boundary (LESSONS §10). */
export interface Provenance {
  /** What produced this: a lane id, an agent id, a route, a corpus id. */
  readonly source: string;
  /** true when this arrived via recall/memory rather than being derived this session. */
  readonly recalled: boolean;
  readonly at: Iso8601;
}

/** A hypothesis under test within the frame, with its current standing. */
export interface Hypothesis {
  readonly id: string;
  readonly statement: string;
  readonly standing: 'OPEN' | 'SUPPORTED' | 'REFUTED' | 'ABANDONED';
}

/** The frame itself. */
export interface ContextFrame {
  readonly id: string;
  /** What this task is for, in one line. */
  readonly goal: string;
  readonly createdAt: Iso8601;
  readonly hypotheses: readonly Hypothesis[];
  /** Predictions sealed during this frame, oldest first. Empty until Phase 3. */
  readonly commitments: readonly Commitment[];
  readonly budgets: readonly Budget[];
  readonly provenance: readonly Provenance[];
  /** A frame with none of these cannot be completed, only abandoned. See `frameFaults`. */
  readonly completionCriteria: readonly CompletionCriterion[];
  /** Frame ids this one forked from, for parallel exploration. */
  readonly parents: readonly string[];
}

export interface FrameFault {
  code: 'NO_COMPLETION_CRITERIA' | 'EMPTY_GOAL' | 'BUDGET_EXCEEDED' | 'DUPLICATE_CRITERION_ID';
  message: string;
  severity: 'error' | 'flag';
}

/**
 * Structural problems with a frame.
 *
 * NO_COMPLETION_CRITERIA is an ERROR and not a flag, which is the one opinionated call in this
 * module. A frame that cannot state when it is done is the shape of every planning surface
 * NORTH-STAR lists as deprecated; permitting it here would rebuild the tenth one.
 */
export function frameFaults(frame: ContextFrame): FrameFault[] {
  const faults: FrameFault[] = [];

  if (frame.goal.trim() === '') {
    faults.push({ code: 'EMPTY_GOAL', message: `frame '${frame.id}' has no goal`, severity: 'error' });
  }

  if (frame.completionCriteria.length === 0) {
    faults.push({
      code: 'NO_COMPLETION_CRITERIA',
      message:
        `frame '${frame.id}' states no completion criteria, so it can never be finished, only abandoned`,
      severity: 'error',
    });
  }

  const seen = new Set<string>();
  for (const c of frame.completionCriteria) {
    if (seen.has(c.id)) {
      faults.push({
        code: 'DUPLICATE_CRITERION_ID',
        message: `frame '${frame.id}' has two completion criteria with id '${c.id}'`,
        severity: 'error',
      });
    }
    seen.add(c.id);
  }

  for (const b of frame.budgets) {
    if (b.spent > b.limit) {
      faults.push({
        code: 'BUDGET_EXCEEDED',
        message: `frame '${frame.id}' spent ${b.spent}${b.unit} against a limit of ${b.limit}${b.unit}`,
        severity: 'flag',
      });
    }
  }

  return faults;
}

/**
 * Whether a frame is complete. Three outcomes, never two.
 *
 * `NOT_CHECKED` wins over `VERIFIED`: if any criterion has not been looked at, the frame's
 * status is unknown, not met — even when every criterion that WAS checked passed. A single
 * FAILED criterion beats everything, because a known failure is more informative than an
 * unfinished check.
 */
export function frameCompletion(frame: ContextFrame): 'VERIFIED' | 'NOT_CHECKED' | 'FAILED' {
  if (frame.completionCriteria.length === 0) return 'NOT_CHECKED';
  if (frame.completionCriteria.some((c) => c.met === false)) return 'FAILED';
  if (frame.completionCriteria.some((c) => c.met === null)) return 'NOT_CHECKED';
  return 'VERIFIED';
}
