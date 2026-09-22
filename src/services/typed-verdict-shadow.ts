/**
 * typed-verdict-shadow.ts — what a typed evidence rule WOULD have said, recorded
 * with no power to say it.
 *
 * THE GAP THIS MEASURES. A task reaching a done state is, today, a claim by the
 * agent that did it. Nothing checks that a claim of the form "I built X" left
 * anything behind that a second party could look at. The evidence columns exist
 * and are empty: of 143,278 tasks in a done state, `verification_proof`,
 * `signatures` and `verifier_agent_id` are non-null on ZERO of them,
 * `verified_output` on one, and an artifact URL on 220 — 0.15%
 * [MEASURED 2026-09-22 against qnnpjhlxljtqyigedwkb].
 *
 * WHY SHADOW, AND NOT THE GATE ITSELF. Because of those same numbers. A rule that
 * demands evidence, switched on today, would escalate very nearly every task it
 * saw — not because the work is bad but because nothing has ever written those
 * columns. Enforcing it now would prove nothing about the policy and would stop
 * the fleet. `owner-ceiling-shadow.ts` is the pattern this follows, including the
 * part that matters most: IT EXPECTS TO BE UNINFORMATIVE AT FIRST AND SAYS SO, so
 * that a run of `escalate` is read as "coverage is zero", never as "the work
 * failed".
 *
 * THE NUMBER THIS EXISTS TO PRODUCE is not an agreement rate and not a quality
 * score. It is `escalate / observed` — THE COST OF SWITCHING ENFORCEMENT ON. That
 * is a fact about coverage. Falling escalate rates over time mean authors are
 * classifying and attaching evidence; they do not mean the work got better.
 *
 * FOUR PROPERTIES:
 *   1. It never alters anything. There is no caller that reads its return value
 *      to make a decision, and the table it writes to carries a CHECK
 *      (`had_power = false`) that makes a row claiming otherwise unstorable.
 *   2. It never throws into the caller. Every path is caught; a failure becomes an
 *      `error` outcome on the returned observation, never an exception.
 *   3. An unclassified task can never be accepted. `artifact_class IS NULL` means
 *      NOT CLASSIFIED, and the only verdict reachable from it is `not_checked`.
 *      There is no branch from NULL to `accept`, and a test proves it.
 *   4. It is inert while the flag is off: no reads, no writes, and `disabled` as
 *      the verdict so an empty dataset is legible rather than mistaken for
 *      agreement.
 *
 * NO PRODUCTION CALL SITE YET, AND THE REASON IS A HARD ORDERING, NOT A PUNT.
 * The natural observation point is `trinity-task-bridge.ts:119`, where a task
 * reaching a done state is fetched and bridged to RepID. That fetch names its
 * columns explicitly and does not include `artifact_class` or any of the evidence
 * columns. Adding them there BEFORE the migration is applied makes the select fail
 * with `column trinity_tasks.artifact_class does not exist` — on the live scoring
 * path, on every run, regardless of this module's flag. A flag cannot guard a
 * column list. So the order is: land the column, apply it, then wire the observer
 * in a change that can be reverted on its own. Until then this module is reachable
 * only from its tests, and saying so here is the point — a module that LOOKS wired
 * and is not is the thing that turns into a documented fact about production.
 */
import { db } from '../db';

/**
 * The rule's own version, stamped on every row.
 *
 * A shadow whose rule changed mid-collection and cannot say which rule produced
 * which row yields an agreement rate that silently averages two different rules.
 * Bump this whenever `evaluateTypedRule` changes its mind about anything.
 */
export const RULE_VERSION = 'evidence-presence/1';

/** @see migrations/2026_09_22_artifact_class_and_typed_verdict_shadow.sql */
export type ArtifactClass = 'checkable' | 'attestation' | 'chore';

export const ARTIFACT_CLASSES: readonly ArtifactClass[] = ['checkable', 'attestation', 'chore'];

export function isArtifactClass(v: unknown): v is ArtifactClass {
  return typeof v === 'string' && (ARTIFACT_CLASSES as readonly string[]).includes(v);
}

/**
 * Three outcomes, never two.
 *
 * `not_checked` is NOT a lenient `accept`. It is the rule declining to answer, and
 * it is what an unclassified task gets. Counting the two together is the exact
 * defect this whole layer exists to avoid, so they are separate values and the
 * report that reads them must never sum them.
 */
export type TypedVerdict = 'accept' | 'escalate' | 'not_checked';

/**
 * Statuses at which asking "where is the evidence?" is a fair question.
 *
 * A pending task has no evidence YET, so escalating it would be noise rather than
 * a finding. `shadow_reject`, `failed`, `cancelled` and `archived` are deliberately
 * absent: a task that did not claim success is not claiming evidence either.
 */
const TERMINAL_SUCCESS = new Set(['done', 'completed', 'verified']);

/** Machine-readable reasons, so the log can be grouped without parsing prose. */
export type TypedVerdictReason =
  | 'flag_off'
  | 'not_terminal'
  | 'unclassified'
  | 'unknown_class'
  | 'chore_no_evidence_expected'
  | 'checkable_has_artifact'
  | 'checkable_no_artifact'
  | 'attestation_signed'
  | 'attestation_unsigned'
  | 'error';

/**
 * The evidence columns, read once and passed in.
 *
 * Presence only — this layer never fetches a URL, verifies a signature or parses
 * an output. It measures whether anything was left behind at all, which is the
 * question that currently has no answer. Do not grow this into a verifier without
 * bumping RULE_VERSION and saying so.
 */
export interface TaskEvidence {
  artifactUrl?: string | null;
  externalArtifactUrl?: string | null;
  verifiedOutput?: unknown;
  verificationProof?: string | null;
  /** `trinity_tasks.signatures` defaults to `'[]'::jsonb`, so empty ≠ absent. */
  signatures?: unknown;
  verifierAgentId?: string | null;
}

export interface TypedRuleInput {
  taskId: number;
  status: string | null | undefined;
  artifactClass: string | null | undefined;
  evidence: TaskEvidence;
  now?: Date;
}

export interface TypedObservation {
  taskId: number;
  verdict: TypedVerdict | 'disabled' | 'error';
  reason: TypedVerdictReason;
  artifactClass: ArtifactClass | null;
  /** Which evidence was present. The raw inputs, kept so a disagreement is re-derivable. */
  evidencePresent: Record<string, boolean>;
  detail: string;
  ruleVersion: string;
  observedAt: string;
  /**
   * Whether the observation reached the log. FALSE with a verdict is not the same
   * as no observation: it means the rule answered and the answer was LOST. An
   * empty table read as "nothing to escalate" is the failure this field exists to
   * make impossible.
   */
  recorded: boolean;
}

const nonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/** `'[]'::jsonb` is the column default, so an empty array is absence, not evidence. */
const nonEmptyJson = (v: unknown): boolean => {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  if (typeof v === 'string') return v.trim().length > 0 && v.trim() !== '[]' && v.trim() !== '{}';
  return true;
};

function presenceMap(e: TaskEvidence): Record<string, boolean> {
  return {
    artifact_url: nonEmptyString(e.artifactUrl),
    external_artifact_url: nonEmptyString(e.externalArtifactUrl),
    verified_output: nonEmptyJson(e.verifiedOutput),
    verification_proof: nonEmptyString(e.verificationProof),
    signatures: nonEmptyJson(e.signatures),
    verifier_agent_id: nonEmptyString(e.verifierAgentId),
  };
}

/**
 * The whole policy, pure and in one place.
 *
 * NOTHING here can turn a NULL class into `accept`. The unclassified branch
 * returns before any class is considered, and `unknown_class` — a value the CHECK
 * constraint should have refused — also returns `not_checked` rather than being
 * folded into `chore`. Both are deliberate: a value we do not understand is not
 * permission.
 */
export function evaluateTypedRule(input: TypedRuleInput): TypedObservation {
  const observedAt = (input.now ?? new Date()).toISOString();
  const evidencePresent = presenceMap(input.evidence);
  const base = {
    taskId: input.taskId,
    evidencePresent,
    ruleVersion: RULE_VERSION,
    observedAt,
    recorded: false,
  };

  if (!input.status || !TERMINAL_SUCCESS.has(input.status)) {
    return {
      ...base,
      verdict: 'not_checked',
      reason: 'not_terminal',
      artifactClass: isArtifactClass(input.artifactClass) ? input.artifactClass : null,
      detail:
        `status ${JSON.stringify(input.status ?? null)} is not a terminal success — ` +
        'evidence is not owed yet, so this is not a finding about the task.',
    };
  }

  if (input.artifactClass === null || input.artifactClass === undefined) {
    return {
      ...base,
      verdict: 'not_checked',
      reason: 'unclassified',
      artifactClass: null,
      detail:
        'artifact_class is NULL — NOT CLASSIFIED. The rule has no opinion, and this must never ' +
        'be counted as an accept. Expected on every task predating the column.',
    };
  }

  if (!isArtifactClass(input.artifactClass)) {
    return {
      ...base,
      verdict: 'not_checked',
      reason: 'unknown_class',
      artifactClass: null,
      detail:
        `artifact_class ${JSON.stringify(input.artifactClass)} is not one of ` +
        `${ARTIFACT_CLASSES.join(' | ')}. The CHECK constraint should make this unreachable; ` +
        'if it appears, the constraint is missing or was applied NOT VALID over dirty rows.',
    };
  }

  if (input.artifactClass === 'chore') {
    return {
      ...base,
      verdict: 'accept',
      reason: 'chore_no_evidence_expected',
      artifactClass: 'chore',
      detail: 'declared chore — no evidence expected, and none is demanded.',
    };
  }

  if (input.artifactClass === 'checkable') {
    const hasArtifact =
      evidencePresent['artifact_url'] === true ||
      evidencePresent['external_artifact_url'] === true ||
      evidencePresent['verified_output'] === true;
    return {
      ...base,
      verdict: hasArtifact ? 'accept' : 'escalate',
      reason: hasArtifact ? 'checkable_has_artifact' : 'checkable_no_artifact',
      artifactClass: 'checkable',
      detail: hasArtifact
        ? 'declared checkable and something re-checkable was left behind (presence only — this layer does not fetch or validate it).'
        : 'declared checkable and reached a done state with no artifact_url, external_artifact_url or verified_output — nothing a second party could look at.',
    };
  }

  if (input.artifactClass === 'attestation') {
    const signed =
      evidencePresent['verification_proof'] === true ||
      evidencePresent['signatures'] === true ||
      evidencePresent['verifier_agent_id'] === true;
    return {
      ...base,
      verdict: signed ? 'accept' : 'escalate',
      reason: signed ? 'attestation_signed' : 'attestation_unsigned',
      artifactClass: 'attestation',
      detail: signed
        ? 'declared attestation and a signer or proof is recorded (presence only — the signature is not verified here).'
        : 'declared attestation and reached a done state with no proof, signature or verifier — an unsigned assertion. Note these three columns are non-null on ZERO done tasks in production [MEASURED 2026-09-22], so this is a coverage fact before it is anything else.',
    };
  }

  /**
   * A CLASS THIS RULE DOES NOT HANDLE, and the reason this branch is written out
   * rather than left as a fallthrough.
   *
   * The attestation test above used to be the final `return`, so any value added
   * to ARTIFACT_CLASSES and to the CHECK constraint — without a branch here —
   * would have been silently JUDGED AS AN ATTESTATION. It would demand a
   * signature it never promised to demand, or accept one it never promised to
   * accept, and every row would look deliberate. That is the house defect exactly:
   * a list and a switch that must be edited together, where forgetting one fails
   * quietly in a plausible direction.
   *
   * So the vocabulary and the policy are allowed to disagree, and when they do the
   * rule says so out loud instead of guessing. A test adds a fake class to prove
   * this branch is reachable.
   */
  return {
    ...base,
    verdict: 'not_checked',
    reason: 'unknown_class',
    artifactClass: null,
    detail:
      `artifact_class ${JSON.stringify(input.artifactClass)} is a known class with NO RULE BRANCH. ` +
      'The vocabulary was extended and this policy was not. Judged as nothing rather than as the ' +
      'nearest neighbour.',
  };
}

/**
 * Default OFF, read per call rather than at import so observation can be turned on
 * without a restart and a test can flip it.
 *
 * While off this module performs NO reads and NO writes. Any report over its table
 * must say so rather than implying the absence of rows is agreement.
 */
export function typedVerdictShadowEnabled(): boolean {
  return String(process.env['TYPED_VERDICT_SHADOW_ENABLED'] ?? '').toLowerCase() === 'true';
}

/**
 * Evaluate and record. NEVER THROWS, and changes nothing.
 *
 * Returns the observation so a test and a caller can see it; no production caller
 * acts on the return value.
 */
export async function observeTypedVerdict(input: TypedRuleInput): Promise<TypedObservation> {
  const observedAt = (input.now ?? new Date()).toISOString();

  if (!typedVerdictShadowEnabled()) {
    return {
      taskId: input.taskId,
      verdict: 'disabled',
      reason: 'flag_off',
      artifactClass: isArtifactClass(input.artifactClass) ? input.artifactClass : null,
      evidencePresent: {},
      detail: 'TYPED_VERDICT_SHADOW_ENABLED is not set — nothing read, nothing recorded, nothing observed.',
      ruleVersion: RULE_VERSION,
      observedAt,
      recorded: false,
    };
  }

  let observation: TypedObservation;
  try {
    observation = evaluateTypedRule(input);
  } catch (err) {
    return {
      taskId: input.taskId,
      verdict: 'error',
      reason: 'error',
      artifactClass: null,
      evidencePresent: {},
      detail: `typed rule threw (caller unaffected): ${err instanceof Error ? err.message : String(err)}`,
      ruleVersion: RULE_VERSION,
      observedAt,
      recorded: false,
    };
  }

  const recorded = await record(observation);
  return { ...observation, recorded };
}

/**
 * Returns whether the row landed — it does not throw and it does not pretend.
 *
 * The specific failure worth naming: if the flag is switched on BEFORE the
 * migration is applied, every insert fails with `relation … does not exist`, the
 * table stays empty, and an empty table reads exactly like a shadow that found
 * nothing to escalate. So a failed write is logged loudly and surfaced on the
 * observation as `recorded: false`, which is what distinguishes NOT CHECKED from
 * a clean run.
 */
async function record(o: TypedObservation): Promise<boolean> {
  try {
    const { error } = await db.from('typed_verdict_shadow').insert({
      task_id: o.taskId,
      observed_at: o.observedAt,
      artifact_class: o.artifactClass,
      would_be_verdict: o.verdict === 'disabled' || o.verdict === 'error' ? 'not_checked' : o.verdict,
      reason: o.reason,
      evidence: o.evidencePresent,
      rule_version: o.ruleVersion,
      had_power: false,
    });
    if (error) {
      console.error(
        `[typed-verdict-shadow] NOT RECORDED task=${o.taskId} verdict=${o.verdict} — ${error.message}. ` +
          'The rule answered and the answer was lost; this table is NOT a complete record. ' +
          'If this says the relation does not exist, the migration has not been applied.',
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      `[typed-verdict-shadow] NOT RECORDED task=${o.taskId} verdict=${o.verdict} — ` +
        `${err instanceof Error ? err.message : String(err)}. This table is NOT a complete record.`,
    );
    return false;
  }
}
