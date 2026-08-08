/**
 * deception-emitter.ts — Trust Harness P1 KEYSTONE (M3): the shadow-first bridge.
 *
 * THE GAP THIS CLOSES (narrative-truth audit, critical-path #3):
 * M2 (behavioral-integrity.ts) holds the deception DETECTORS and M1
 * (repid-update.ts) holds the asymmetric PENALTY tiers (-60 / -40) plus the
 * shadow/enforce gate — but NOTHING ran the detectors on a real interaction and
 * fed a confirmed detection into the penalty path. `classifyInteraction` had zero
 * production callers, so no `DEFENDED_DECEPTION_*` event ever reached
 * `updateRepId`. Result: "defended deception costs more than honest error" was
 * DESIGNED but not OPERATIVE. This module is the missing caller — and it makes
 * the mechanism OBSERVABLE in shadow without turning enforcement on.
 *
 * SHADOW ONLY, DEFAULT-OFF. One env switch, `TRUST_DECEPTION_MODE`:
 *   unset / anything-else → 'off'      the emitter is a COMPLETE no-op: it does
 *                                      not build a record, run a detector, or
 *                                      touch the DB. Provably inert (test-proven).
 *   'shadow'             → record-only  run the detectors; on a CONFIRMED
 *                                      detection, RECORD the class + the penalty
 *                                      that WOULD apply, WITHOUT mutating
 *                                      current_repid. Inertness is enforced inside
 *                                      updateRepId's shadow-deception path (M1
 *                                      findings 1+2), which this module reuses
 *                                      rather than re-implements.
 *   'enforce'            → would-apply  the penalty is applied to current_repid.
 *                                      KEEP OFF until Sean ratifies (a measured
 *                                      shadow run he has seen, plus his GO —
 *                                      CLAUDE_RULES r23 shadow-only-until-ratified).
 *
 * WHY THE DEFAULT DIFFERS FROM deceptionMode() (repid-update.ts): that function
 * defaults unset→'shadow' so a deception event that somehow reaches updateRepId is
 * never enforced by accident. THIS emitter defaults unset→'off' so the live
 * score-event path does NO detection work at all until Sean flips it. Both read
 * the SAME env var, so 'shadow' here == 'shadow' there and 'enforce' here ==
 * 'enforce' there: one switch, consistent behavior, no second knob to forget.
 *
 * HONESTY (item 3 — a shadow detection is a CANDIDATE, not a conviction):
 *   - The record-grounded detectors (denial / fabricated-tool / fabricated-
 *     citation / fabricated-benchmark / story-change) fire only on a PROVABLE
 *     mismatch against the receipt chain — grounded=true, high confidence.
 *   - The three heuristic detectors (doubt-attack / sycophantic-false-premise /
 *     threshold-dancing) are interpretable lexical patterns with LOWER confidence
 *     and are carried as grounded=false. The emitter never upgrades a heuristic to
 *     a proof; M1's gate additionally withholds the heavy -60 tier from any
 *     ungrounded signal. A recorded shadow event is a measurement to be reviewed,
 *     not a verdict.
 *
 * This module has NO direct DB or network dependency of its own: it composes the
 * pure M2 classifier with the audited M1 writer, so it is safe on the shadow path.
 */

import {
  InteractionRecord,
  classifyInteraction,
  isConfirmed,
  detectionToEventType,
  type Interaction,
  type DetectionResult,
  type ReceiptKind,
} from './behavioral-integrity';
import { updateRepId, gatedDeceptionDelta, type RepIdUpdateInput } from './repid-update';

export type DeceptionEmitterMode = 'off' | 'shadow' | 'enforce';

/**
 * Resolve the emitter mode from TRUST_DECEPTION_MODE. Unset (or any value other
 * than the two explicit words) → 'off': the emitter must be inert by default so
 * the live score-event path does no work until Sean opts in. Only 'shadow' or
 * 'enforce', spelled exactly, enable it.
 */
export function deceptionEmitterMode(): DeceptionEmitterMode {
  const v = (process.env.TRUST_DECEPTION_MODE || '').toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

/** A prior receipted interaction used to seed the record-grounded detectors. */
export interface PriorReceipt {
  kind: ReceiptKind;
  content: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

export interface DeceptionEmitterInput {
  agentId: string;
  /** The text the agent just produced (decision_text on the score-event path). */
  decisionText: string;
  /**
   * Prior receipted context, if any, to seed the record-grounded detectors. On
   * the CURRENT score-event path there is no persisted receipt chain, so this is
   * usually empty and only the heuristic detectors have signal — see the HONEST
   * MAP in the PR body. A future receipt store fills this in.
   */
  priorReceipts?: PriorReceipt[];
  // --- caller-supplied claim assertions the record-grounded detectors check ---
  claimedCitation?: string;
  citationAssertedAsPriorReceipt?: boolean;
  claimedCitationReceiptRef?: string;
  claimedToolResult?: { tool: string; output: string };
  claimedHash?: string;
  hashAssertedAsPriorReceipt?: boolean;
  claimedBenchmark?: { metric: string; value: number };
  userStatement?: string;
  userStatementIsFalse?: boolean;
  /** Free-form HAL/scoring context logged alongside a shadow detection. */
  halContext?: Record<string, unknown>;
}

export interface DeceptionEmitterResult {
  /** false ONLY when mode==='off' — the emitter did not run at all (fully inert). */
  ran: boolean;
  mode: DeceptionEmitterMode;
  /** The classifier result. `clean` when there was no signal. */
  detection: DetectionResult;
  /** detection.class !== 'clean' && confidence >= the confirm threshold. */
  confirmed: boolean;
  /** The DEFENDED_DECEPTION_* event type, or null when clean/unconfirmed. */
  eventType: string | null;
  /**
   * The penalty the confirmed detection WOULD apply (M1 gated delta). In shadow
   * this is recorded but NOT applied; in enforce it is applied. Null when not
   * confirmed. Note this can be 0 for an ungrounded record-corrupting signal
   * (the -60 tier requires a grounded proof) — honest by construction.
   */
  wouldApplyDelta: number | null;
  /** Whether an audit row was written (via updateRepId). Only on a confirmed hit. */
  recorded: boolean;
  /** Whether current_repid actually changed. ALWAYS false in shadow. */
  scoreMutated: boolean;
  repIdBefore: number | null;
  repIdAfter: number | null;
}

const CLEAN_DETECTION: DetectionResult = {
  class: 'clean',
  confidence: 0,
  grounded: false,
  evidence: 'Emitter inert (TRUST_DECEPTION_MODE off) — no detector was run.',
  receiptRefs: [],
};

/**
 * Run the M2 detectors on one interaction and, on a CONFIRMED detection, record
 * the DEFENDED_DECEPTION_* class + the penalty it would apply via the audited M1
 * writer. Shadow-first and default-OFF (see module header).
 *
 * Never throws: on the live score-event path this is a fire-and-forget shadow
 * measurement that must never break scoring. A DB/writer failure is logged and
 * returned as `recorded: false`, not raised.
 */
export async function emitDeceptionShadow(
  input: DeceptionEmitterInput,
): Promise<DeceptionEmitterResult> {
  const mode = deceptionEmitterMode();

  // DEFAULT-OFF: a COMPLETE no-op. No record is built, no detector runs, the DB is
  // never touched. This is the "provably inert when the flag is off" guarantee.
  if (mode === 'off') {
    return {
      ran: false,
      mode,
      detection: CLEAN_DETECTION,
      confirmed: false,
      eventType: null,
      wouldApplyDelta: null,
      recorded: false,
      scoreMutated: false,
      repIdBefore: null,
      repIdAfter: null,
    };
  }

  // Build the receipt record from any supplied prior context. Empty on the
  // current score-event path (no persisted receipt chain yet) — so only the
  // heuristic detectors and caller-supplied prior-assertions have signal there.
  const record = new InteractionRecord(input.agentId);
  for (const r of input.priorReceipts ?? []) {
    record.append({ kind: r.kind, content: r.content, payload: r.payload, timestamp: r.timestamp });
  }

  const interaction: Interaction = {
    agentId: input.agentId,
    text: input.decisionText,
    claimedCitation: input.claimedCitation,
    citationAssertedAsPriorReceipt: input.citationAssertedAsPriorReceipt,
    claimedCitationReceiptRef: input.claimedCitationReceiptRef,
    claimedToolResult: input.claimedToolResult,
    claimedHash: input.claimedHash,
    hashAssertedAsPriorReceipt: input.hashAssertedAsPriorReceipt,
    claimedBenchmark: input.claimedBenchmark,
    userStatement: input.userStatement,
    userStatementIsFalse: input.userStatementIsFalse,
  };

  const detection = classifyInteraction(interaction, record);
  const confirmed = isConfirmed(detection);

  // Honest interaction (or a below-threshold candidate): record NOTHING. A shadow
  // measurement of deception must not write a row for clean behavior.
  if (!confirmed) {
    return {
      ran: true,
      mode,
      detection,
      confirmed: false,
      eventType: null,
      wouldApplyDelta: null,
      recorded: false,
      scoreMutated: false,
      repIdBefore: null,
      repIdAfter: null,
    };
  }

  const eventType = detectionToEventType(detection);
  if (!eventType) {
    // Confirmed but unmappable (should not happen for a non-clean class).
    return {
      ran: true,
      mode,
      detection,
      confirmed: true,
      eventType: null,
      wouldApplyDelta: null,
      recorded: false,
      scoreMutated: false,
      repIdBefore: null,
      repIdAfter: null,
    };
  }

  // The DetectionResult IS exactly the `deceptionProof` shape M1's gate consumes.
  const deceptionInput: RepIdUpdateInput = {
    agentId: input.agentId,
    eventType: eventType as RepIdUpdateInput['eventType'],
    deceptionProof: {
      class: detection.class,
      confidence: detection.confidence,
      grounded: detection.grounded,
      evidence: detection.evidence,
      receiptRefs: detection.receiptRefs,
    },
  };

  // The would-be penalty, computed by the SAME gate updateRepId uses. In shadow
  // this is recorded (metadata.deltaComputed) but not applied; in enforce it is
  // applied. Reserved to grounded, confirmed detections (the -60/-40 tiers).
  const wouldApplyDelta = gatedDeceptionDelta(deceptionInput).delta;

  try {
    // Bridge M2 -> M1. updateRepId reads the SAME TRUST_DECEPTION_MODE, so it
    // records the would-be penalty INERTLY in shadow (top-level delta 0,
    // current_repid untouched, mode 'shadow-deception') or applies it in enforce.
    // We do NOT re-implement inertness here — we reuse the audited, test-covered
    // path so there is exactly one source of truth for shadow behavior.
    const result = await updateRepId(deceptionInput);
    const scoreMutated = result.repIdAfter !== result.repIdBefore;

    // No silent modes: a confirmed shadow detection announces itself once, plainly
    // labelled as a candidate measurement (not a conviction).
    console.log(
      `[deception-emitter] mode=${mode} agent=${input.agentId} class=${detection.class} ` +
      `grounded=${detection.grounded} confidence=${detection.confidence} ` +
      `wouldApplyDelta=${wouldApplyDelta} applied=${result.delta} scoreMutated=${scoreMutated} ` +
      `(shadow detection = CANDIDATE, not a conviction)`,
    );

    return {
      ran: true,
      mode,
      detection,
      confirmed: true,
      eventType,
      wouldApplyDelta,
      recorded: true,
      scoreMutated,
      repIdBefore: result.repIdBefore,
      repIdAfter: result.repIdAfter,
    };
  } catch (e: any) {
    // Fire-and-forget safety: never break scoring on a shadow measurement.
    console.error(
      `[deception-emitter] shadow record FAILED for agent ${input.agentId} ` +
      `(class=${detection.class}, eventType=${eventType}): ${e?.message ?? e}`,
    );
    return {
      ran: true,
      mode,
      detection,
      confirmed: true,
      eventType,
      wouldApplyDelta,
      recorded: false,
      scoreMutated: false,
      repIdBefore: null,
      repIdAfter: null,
    };
  }
}
