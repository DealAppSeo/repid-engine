/**
 * handoff-gate.ts — a lane's work does not advance until its outputs provably exist.
 *
 * WHAT THIS FIXES, precisely. `cosign-consumer.ts` already refuses to advance a task
 * without a *disjoint* co-signer and an artifact URL. That is the right gate on WHO
 * signed. It says nothing about WHETHER THE ARTIFACT CONTAINS THE WORK. Eighteen
 * nightly reports had artifact URLs, real co-signers, and zero measurements inside.
 * A gate on the signature cannot catch an empty envelope.
 *
 * So this gate checks the CONTENTS: every output the task declared it would produce
 * must be present, non-empty, and not a placeholder. Adapted from gstack's Pre-Gate
 * Verification, whose rule is the one that matters — *if any required output is
 * missing, go back and produce it* — plus two of our own hard-won additions:
 *
 *   1. A MEASUREMENT WITHOUT ITS RULER IS NOT A RESULT (CLAUDE_RULES 24). A bare
 *      number is rejected. HAL's F1 has been quoted at 0.34 / 0.74 / 0.886 / 0.890, so
 *      "did HAL improve?" has no answer today. A figure must arrive with the corpus and
 *      configuration it was taken at, or it is not admissible.
 *
 *   2. A MISSING VOICE IS UNVERIFIED, NEVER CONFIRMED. gstack states this for its dual
 *      voices ("Missing voice = N/A, not CONFIRMED") and we have already been bitten by
 *      the same class of bug in a different costume: a dead provider key silently
 *      shrank the HAL quorum and the narrower quorum still reported agreement. Absence
 *      of dissent is not consensus.
 *
 * PURE AND DB-FREE on purpose, exactly like the decision core of `cosign-consumer.ts`.
 * Everything here is a function of its arguments so it can be unit-tested without a
 * database, and so the same gate can be called from a dispatch poller, a CI check, or
 * a report reviewer without three divergent copies of the rule.
 */

import type { LaneId } from './lane-registry';

// ---------------------------------------------------------------------------
// Required outputs
// ---------------------------------------------------------------------------

export type OutputKind =
  /** Free text: a finding, a rationale, a description. Must be substantive. */
  | 'prose'
  /** A number that was measured. MUST carry its ruler. */
  | 'measurement'
  /** A path or URL to something that exists outside the report. */
  | 'artifact'
  /** An explicit verdict: pass/fail/hold. */
  | 'verdict';

export interface RequiredOutput {
  key: string;
  kind: OutputKind;
  /** What this output is for. Shown in the refusal so the lane knows what to fix. */
  description: string;
}

/**
 * A measured value together with the ruler it was measured on. Both halves are
 * mandatory — that is the entire point of the type existing rather than using `number`.
 */
export interface MeasuredValue {
  value: number;
  /** What was measured against: corpus name + hash, dataset id, contract id. */
  corpus: string;
  /** The configuration width it was taken at: "5 families", "strictness 2", "n=294". */
  config: string;
}

export type ReportedValue = string | number | boolean | MeasuredValue | null | undefined;

/**
 * Text that looks like an answer and contains none. Every entry here was observed in a
 * real agent report, which is why the list is specific rather than clever — a general
 * "looks low-effort" heuristic would reject legitimate short findings like "0 rows".
 */
const PLACEHOLDERS = new Set([
  'tbd',
  'todo',
  'n/a',
  'na',
  'none',
  'pending',
  'see above',
  'see below',
  'as discussed',
  'not applicable',
  'no issues found',
  'looks good',
  'lgtm',
  'done',
  'complete',
  'completed',
  'success',
  'ok',
  'verified',
  '-',
  '--',
  '...',
  '?',
]);

/**
 * Minimum characters for a prose output to count as substantive.
 *
 * Chosen against the failure it prevents: "no issues found" (15 chars) and "looks good"
 * (10) are the observed empty-report strings, and gstack's rule is that "no issues
 * found" is valid ONLY with 1–2 sentences of what was examined. Forty characters is
 * about one clause of that. It is a floor against emptiness, not a proxy for quality.
 */
export const MIN_PROSE_CHARS = 40;

const isMeasured = (v: unknown): v is MeasuredValue =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as MeasuredValue).value === 'number' &&
  typeof (v as MeasuredValue).corpus === 'string' &&
  typeof (v as MeasuredValue).config === 'string';

/** Is this string a placeholder pretending to be content? */
export function isPlaceholder(s: string): boolean {
  const norm = s.trim().toLowerCase().replace(/[.!]+$/, '');
  return norm.length === 0 || PLACEHOLDERS.has(norm);
}

export interface OutputProblem {
  key: string;
  problem: string;
}

/**
 * Check one declared output against what was actually reported.
 *
 * Returns null when the output is acceptable, or a problem naming what is wrong in
 * terms the producing lane can act on.
 */
export function checkOutput(req: RequiredOutput, value: ReportedValue): OutputProblem | null {
  if (value === undefined || value === null) {
    return { key: req.key, problem: `missing entirely — ${req.description}` };
  }

  switch (req.kind) {
    case 'measurement': {
      if (isMeasured(value)) {
        if (!Number.isFinite(value.value)) {
          return { key: req.key, problem: 'measured value is not a finite number' };
        }
        if (isPlaceholder(value.corpus) || isPlaceholder(value.config)) {
          return {
            key: req.key,
            problem:
              'ruler is a placeholder — state the actual corpus and configuration ' +
              '(e.g. "corpus v1 @ 9f2c1a, 5 families"), not "N/A"',
          };
        }
        return null;
      }
      // A bare number is the exact failure CLAUDE_RULES 24 exists to stop.
      return {
        key: req.key,
        problem:
          `reported as a bare ${typeof value} — a measurement must carry its ruler: ` +
          `{ value, corpus, config }. Numbers on different rulers are not comparable, ` +
          `so a bare figure cannot be trended or called progress.`,
      };
    }

    case 'prose': {
      if (typeof value !== 'string') {
        return { key: req.key, problem: `expected text, got ${typeof value}` };
      }
      if (isPlaceholder(value)) {
        return {
          key: req.key,
          problem:
            `"${value.trim()}" is a placeholder, not a finding. State what was examined ` +
            `and why nothing was flagged.`,
        };
      }
      if (value.trim().length < MIN_PROSE_CHARS) {
        return {
          key: req.key,
          problem: `too short to be a finding (${value.trim().length} < ${MIN_PROSE_CHARS} chars) — ${req.description}`,
        };
      }
      return null;
    }

    case 'artifact': {
      if (typeof value !== 'string' || isPlaceholder(value)) {
        return { key: req.key, problem: 'no artifact path or URL given' };
      }
      // Deliberately NOT checking existence here: this module is pure. The caller that
      // has filesystem or network access performs the existence check and passes the
      // result. A gate that silently skips a check it cannot perform is the fallback
      // pattern we keep removing.
      return null;
    }

    case 'verdict': {
      if (typeof value === 'boolean') return null;
      if (typeof value !== 'string' || value.trim().length === 0) {
        return { key: req.key, problem: 'no explicit verdict' };
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Verification status
// ---------------------------------------------------------------------------

/**
 * CONFIRMED requires a real second voice. There is no path from "nobody disagreed" to
 * CONFIRMED — that is the whole distinction between UNVERIFIED and CONFIRMED.
 */
export type VerificationStatus = 'CONFIRMED' | 'DISPUTED' | 'UNVERIFIED' | 'SELF_SIGNED';

export interface Voice {
  lane: LaneId;
  /** true = agrees the work is sound. false = disputes it. null = did not report. */
  agrees: boolean | null;
}

/**
 * Resolve the verification status of a report from the voices that actually spoke.
 *
 * The ordering of these checks is the load-bearing part:
 *   - a producer signing itself is SELF_SIGNED and never counts as verification;
 *   - any genuine dissent is DISPUTED, even if others agree — a single credible
 *     objection outranks a majority, because the majority may share one blind spot
 *     (the Pythagorean Comma veto: high-confidence agreement can be coordinated
 *     dissonance rather than truth);
 *   - a voice that did not report contributes NOTHING. Silence is not assent.
 */
export function resolveVerification(producer: LaneId, voices: readonly Voice[]): VerificationStatus {
  const external = voices.filter((v) => v.lane !== producer);
  const spoke = external.filter((v) => v.agrees !== null);

  if (spoke.some((v) => v.agrees === false)) return 'DISPUTED';
  if (spoke.length > 0) return 'CONFIRMED';
  // Nothing external spoke. If the only voice present was the producer's own, say so
  // explicitly — "self-signed" is a more actionable refusal than "unverified".
  if (voices.some((v) => v.lane === producer && v.agrees !== null)) return 'SELF_SIGNED';
  return 'UNVERIFIED';
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface HandoffRequest {
  taskId: string | number;
  producer: LaneId;
  requiredOutputs: readonly RequiredOutput[];
  reported: Readonly<Record<string, ReportedValue>>;
  voices: readonly Voice[];
  /**
   * Whether this work can change live state — money, RepID, on-chain writes, or a
   * public surface (CLAUDE_RULES 23). Live-state work needs CONFIRMED; inert work may
   * advance UNVERIFIED, because a branch nobody reviewed costs nothing.
   */
  touchesLiveState: boolean;
}

export interface HandoffDecision {
  advance: boolean;
  verification: VerificationStatus;
  problems: OutputProblem[];
  /** One line, suitable for a dispatch log or a Telegram alert. */
  reason: string;
}

/**
 * Should this task advance?
 *
 * FAIL-CLOSED, matching `cosign-consumer.ts`: any missing output, any unresolved
 * dispute, any live-state change without a real second voice → do not advance. A stuck
 * task is a safe state; a task wrongly marked done is a trust breach.
 */
export function evaluateHandoff(req: HandoffRequest): HandoffDecision {
  const problems: OutputProblem[] = [];
  for (const out of req.requiredOutputs) {
    const p = checkOutput(out, req.reported[out.key]);
    if (p) problems.push(p);
  }

  const verification = resolveVerification(req.producer, req.voices);

  // Outputs first: a report missing its contents should not be reviewed at all, and
  // saying so before discussing verification tells the lane the cheaper thing to fix.
  if (problems.length > 0) {
    return {
      advance: false,
      verification,
      problems,
      reason:
        `HOLD ${req.taskId}: ${problems.length} of ${req.requiredOutputs.length} required ` +
        `outputs unusable (${problems.map((p) => p.key).join(', ')}). Produce them, then re-submit.`,
    };
  }

  if (verification === 'DISPUTED') {
    return {
      advance: false,
      verification,
      problems,
      reason: `HOLD ${req.taskId}: a verifier disputes this. Resolve the disagreement — do not out-vote it.`,
    };
  }

  if (verification === 'SELF_SIGNED') {
    return {
      advance: false,
      verification,
      problems,
      reason: `HOLD ${req.taskId}: signed only by its producer (${req.producer}). Self-verification is not verification.`,
    };
  }

  if (req.touchesLiveState && verification !== 'CONFIRMED') {
    return {
      advance: false,
      verification,
      problems,
      reason:
        `HOLD ${req.taskId}: touches live state and no independent voice reported. ` +
        `Silence is not assent — get a co-sign from a lane that can reach the evidence.`,
    };
  }

  return {
    advance: true,
    verification,
    problems,
    reason:
      `ADVANCE ${req.taskId}: all ${req.requiredOutputs.length} outputs present, ` +
      `verification ${verification}${req.touchesLiveState ? ' (live-state change)' : ' (inert)'}.`,
  };
}

// ---------------------------------------------------------------------------
// Decision classification
// ---------------------------------------------------------------------------

/**
 * D-054 has two outcomes: models agree → proceed, or models disagree → ask Sean. gstack
 * has three, and the third is the one we have been missing:
 *
 *   MECHANICAL     — one clearly right answer. Decide silently.
 *   TASTE          — reasonable people could differ. Decide, but surface the choice.
 *   USER_CHALLENGE — the models AGREE the user's own stated direction should change.
 *
 * That third case is not a stronger version of agreement; it is a different kind of
 * event, and it is exactly where confident agreement is least trustworthy — the models
 * share a blind spot precisely where they lack the user's context. So it is NEVER
 * auto-decided, and the user's original direction is the DEFAULT: the models must make
 * the case for change, not the other way around.
 *
 * This is the rung between "Claude and Grok concur, proceed" and "escalate on
 * disagreement" that D-054 does not have — and it is the category most of the wasted
 * cycles have fallen into.
 */
export type DecisionClass = 'MECHANICAL' | 'TASTE' | 'USER_CHALLENGE';

export interface DecisionInput {
  /** Do the reviewing models agree with each other? */
  modelsAgree: boolean;
  /** Does their conclusion contradict a direction the user actually stated? */
  contradictsStatedDirection: boolean;
  /** Is there genuinely only one defensible answer? */
  singleDefensibleAnswer: boolean;
}

export interface Classified {
  klass: DecisionClass;
  autoDecidable: boolean;
  reason: string;
}

export function classifyDecision(d: DecisionInput): Classified {
  // Checked FIRST and unconditionally: a challenge to the user's direction outranks
  // how obvious the models find it. "It's obviously right" is the sentiment that makes
  // this category dangerous, not the one that exempts it.
  if (d.contradictsStatedDirection) {
    return {
      klass: 'USER_CHALLENGE',
      autoDecidable: false,
      reason:
        'This contradicts a direction Sean stated. Present it as a challenge with what he ' +
        'said, what the models recommend, why, what context we may be missing, and the cost ' +
        'if his original direction was right. His direction is the default.',
    };
  }
  if (d.singleDefensibleAnswer && d.modelsAgree) {
    return {
      klass: 'MECHANICAL',
      autoDecidable: true,
      reason: 'One defensible answer and no disagreement — decide and log it, do not ask.',
    };
  }
  return {
    klass: 'TASTE',
    autoDecidable: true,
    reason: d.modelsAgree
      ? 'Several viable options and no disagreement — pick one, then surface the choice made.'
      : 'The models differ. Pick the better-argued option, then surface the disagreement.',
  };
}
