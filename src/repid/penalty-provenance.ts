/**
 * penalty-provenance.ts — WHY a score went down.
 *
 * The mirror of `ledger-provenance.ts`. That module answers "who can mint, and
 * from what". This one answers the question an auditor asks immediately after:
 * **"is this agent low because it went quiet, or because it got caught?"**
 *
 * Those are opposite facts wearing the same number. A dormant-but-honest agent
 * and a caught-fabricating agent can sit at identical RepID, and until the losses
 * are decomposed nothing on the surface tells them apart. "Points come off for
 * lying" is only an auditable claim if the ledger can show WHICH points came off
 * for lying.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THE LEDGER ACTUALLY CONTAINS  [V sql 2026-08-04, full ledger]
 * ════════════════════════════════════════════════════════════════════════════════
 *   HAL_SCORE_EVENT       68,321 events   -683,210   all vetoed; 43,022 hallucination_caught
 *   VALIDATION_FAILED         26 events     -2,628   21 carry a contract_id
 *   CHALLENGE_LOSS            15 events       -473
 *   PREDICTION_RESOLVE        40 events       -355   22 carry a veto_class
 *   GENESIS                    3 events     -2,209   administrative
 *   EPISTEMIC_VIOLATION        2 events       -120
 *   DORMANCY_DECAY             2 events         -6   NOT a punishment
 *   VALIDATOR_PENALTY          1 event          -5
 *
 * 99.9% of penalty VOLUME is HAL veto. Unlike the gain side — where volume
 * misrepresented soundness — that concentration is meaningful here: HAL vetoes are
 * the punishment mechanism, and they subtract. The gain-side module already
 * established the complement: those same events produced +5 of positive delta in
 * the entire history, so HAL can only ever take away.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE DISTINCTION THAT CARRIES THE WHOLE MODULE
 * ════════════════════════════════════════════════════════════════════════════════
 * `dormancy_decay` is NOT a penalty. It is the score of an agent that stopped
 * working, and treating it as misconduct would let an auditor — or a future
 * autonomy gate — read silence as dishonesty. Equally, misconduct must never be
 * laundered as decay. `isBehavioral()` is the line between them and is the only
 * thing an authority/HITL decision should ever consult.
 *
 * A `prediction_miss` is deliberately NOT behavioral either: being WRONG is not
 * the same as being DISHONEST, and a reputation system that cannot tell those
 * apart punishes the agent that took a hard call and rewards the one that never
 * committed to anything.
 *
 * Pure over a row shape — no DB, no clock. Zero DDL: every column already exists
 * (verified against information_schema, not the generated types).
 */

export type PenaltyClass =
  /** HAL caught a hallucination / vetoed the output. Behavioral. */
  | 'hallucination_veto'
  /** A counterparty said the delivered work failed. Behavioral, and externally attested. */
  | 'counterparty_dispute'
  /** Lost an adversarial challenge. Behavioral. */
  | 'challenge_loss'
  /** Epistemic / validator integrity breach. Behavioral, and the most serious. */
  | 'integrity_violation'
  /** Went quiet. NOT misconduct — see the header. */
  | 'dormancy_decay'
  /** Called it and was wrong. Wrong is not dishonest. */
  | 'prediction_miss'
  /** Bootstrap / operator adjustment. Not earned, not misconduct. */
  | 'administrative'
  /** Shape we do not recognise. Never silently folded into a softer class. */
  | 'unclassified';

/**
 * Integrity breaches — matched by PREFIX/substring, not exact equality.
 *
 * FOUND BY XC RED-TEAM 2026-08-05, verified independently before fixing. This was
 * a Set with bare 'DECEPTION' and 'SLASH' matched by `Set.has()` — exact equality.
 * The names the engine actually writes are `DEFENDED_DECEPTION_FABRICATED_CITATION`,
 * `HANDOFF_COSIGN_FALSE_PASS_SLASH`, `CONSTITUTIONAL_VIOLATION` … none of which
 * equal those strings. So the HEAVIEST penalties in the system — fabricated
 * citations and tool results (−60), false-pass co-signs (−15) — classified as
 * `unclassified`, and `isBehavioral()` excludes unclassified by design.
 *
 * Net effect, exactly backwards from intent: an agent caught fabricating evidence
 * would have dodged the HITL gate, while one that merely went quiet would not.
 * Wiring isBehavioral() into authority was the very next planned task.
 *
 * Substring matching is used deliberately rather than enumerating every variant:
 * the engine's deception taxonomy grows (8 DEFENDED_DECEPTION_* types today), and
 * an exact-match list silently fails open for every type added after it was
 * written. Failing open is the whole defect being fixed here.
 */
const INTEGRITY_PATTERNS = [
  'DECEPTION',            // DEFENDED_DECEPTION_* (all 8), DECEPTION
  'SLASH',                // HANDOFF_COSIGN_FALSE_PASS_SLASH, SLASH
  'COLLUSION',
  'EPISTEMIC_VIOLATION',
  'CONSTITUTIONAL_VIOLATION',
  'VALIDATOR_PENALTY',
  'UNSUPPORTED_CLAIM',    // -8, caller asserted something it could not back
] as const;

function isIntegrityType(type: string): boolean {
  return INTEGRITY_PATTERNS.some((p) => type.includes(p));
}
const DORMANCY_TYPES = new Set(['DORMANCY_DECAY', 'DECAY']);
const ADMIN_TYPES = new Set(['GENESIS', 'EPOCH_RESET', 'BASELINE']);

export interface PenaltyEventRow {
  event_type?: string | null;
  delta?: number | null;
  hal_decision?: string | null;
  hallucination_caught?: boolean | null;
  veto_class?: string | null;
  contract_id?: string | null;
}

function txt(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Classify one negative-delta event.
 *
 * Like the gain-side classifier, EVIDENCE outranks the label: a HAL veto is
 * recognised by `hal_decision`/`hallucination_caught`, and a counterparty dispute
 * by the presence of a real `contract_id`, before the event's own `event_type` is
 * consulted. `event_type` alone can never promote an event into a more serious
 * class — that is the field a caller controls.
 *
 * Non-negative deltas return null: this module explains LOSSES and must not be
 * used to characterise a gain.
 */
export function classifyPenalty(row: PenaltyEventRow): PenaltyClass | null {
  const delta = Number(row.delta ?? 0);
  if (!Number.isFinite(delta) || delta >= 0) return null;

  const type = txt(row.event_type).toUpperCase();

  // Dormancy and administrative are checked FIRST and by type, because they are
  // the two classes that must never be inflated into misconduct by an incidental
  // veto flag riding along on the row.
  if (DORMANCY_TYPES.has(type)) return 'dormancy_decay';
  if (ADMIN_TYPES.has(type)) return 'administrative';

  if (isIntegrityType(type)) return 'integrity_violation';

  // Evidence-first for the two behavioral classes that dominate.
  if (row.hallucination_caught === true || txt(row.hal_decision).toLowerCase() === 'vetoed') {
    return 'hallucination_veto';
  }
  if (type === 'VALIDATION_FAILED' && txt(row.contract_id) !== '') return 'counterparty_dispute';
  if (type === 'VALIDATION_FAILED') return 'challenge_loss'; // failed, but no counterparty attested it
  if (type === 'CHALLENGE_LOSS') return 'challenge_loss';
  if (type === 'PREDICTION_RESOLVE') return 'prediction_miss';

  return 'unclassified';
}

/**
 * Did the agent DO something wrong, as opposed to going quiet or being wrong?
 *
 * This is the only predicate an autonomy / HITL / collateral decision should
 * consult. `unclassified` is excluded deliberately: an unrecognised shape must not
 * be able to brand an agent as a bad actor, and a gate that fails toward "guilty"
 * on unknown input is how a scoring bug becomes an accusation.
 */
export function isBehavioral(c: PenaltyClass): boolean {
  return c === 'hallucination_veto' || c === 'counterparty_dispute'
    || c === 'challenge_loss' || c === 'integrity_violation';
}

export interface PenaltyBucket { events: number; netDelta: number }

export interface PenaltyBreakdown {
  totalPenaltyEvents: number;
  totalPenaltyDelta: number;
  byClass: Record<PenaltyClass, PenaltyBucket>;
  /** Losses attributable to something the agent actually did. */
  behavioral: PenaltyBucket;
  /** Losses from going quiet. Explicitly NOT misconduct. */
  dormancy: PenaltyBucket;
  /**
   * Share of total loss that is behavioral, 0..1, or null when there are no
   * losses. This is the number that separates "inactive" from "untrustworthy".
   */
  behavioralShareOfLosses: number | null;
  /** Integrity violations, surfaced separately — the most serious class. */
  integrityEvents: number;
}

const EMPTY = (): Record<PenaltyClass, PenaltyBucket> => ({
  hallucination_veto: { events: 0, netDelta: 0 },
  counterparty_dispute: { events: 0, netDelta: 0 },
  challenge_loss: { events: 0, netDelta: 0 },
  integrity_violation: { events: 0, netDelta: 0 },
  dormancy_decay: { events: 0, netDelta: 0 },
  prediction_miss: { events: 0, netDelta: 0 },
  administrative: { events: 0, netDelta: 0 },
  unclassified: { events: 0, netDelta: 0 },
});

export function summarizePenalties(rows: PenaltyEventRow[]): PenaltyBreakdown {
  const byClass = EMPTY();
  let total = 0;
  let events = 0;

  for (const r of rows) {
    const c = classifyPenalty(r);
    if (c === null) continue; // gains are not this module's business
    const d = Number(r.delta ?? 0);
    const delta = Number.isFinite(d) ? d : 0;
    byClass[c].events += 1;
    byClass[c].netDelta += delta;
    total += delta;
    events += 1;
  }

  const sum = (cs: PenaltyClass[]): PenaltyBucket =>
    cs.reduce((a, c) => ({ events: a.events + byClass[c].events, netDelta: a.netDelta + byClass[c].netDelta }),
      { events: 0, netDelta: 0 });

  const behavioral = sum(['hallucination_veto', 'counterparty_dispute', 'challenge_loss', 'integrity_violation']);

  return {
    totalPenaltyEvents: events,
    totalPenaltyDelta: total,
    byClass,
    behavioral,
    dormancy: byClass.dormancy_decay,
    // Magnitudes: both are negative, so the ratio is taken on absolute values.
    behavioralShareOfLosses: total < 0 ? Math.abs(behavioral.netDelta) / Math.abs(total) : null,
    integrityEvents: byClass.integrity_violation.events,
  };
}

/** Plain-language line for a public surface or a log. */
export function describePenalties(b: PenaltyBreakdown): string {
  if (b.totalPenaltyEvents === 0) return 'no penalties on record';
  const pct = b.behavioralShareOfLosses === null ? 'n/a' : `${Math.round(b.behavioralShareOfLosses * 100)}%`;
  return (
    `${b.totalPenaltyEvents} penalties totalling ${b.totalPenaltyDelta} · ${pct} behavioural · ` +
    `dormancy ${b.dormancy.netDelta} over ${b.dormancy.events} events · ` +
    `${b.integrityEvents} integrity violation${b.integrityEvents === 1 ? '' : 's'}`
  );
}
