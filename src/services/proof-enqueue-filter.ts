/**
 * L4-adjacent: proof-enqueue churn filter (producer-side, shadow-first).
 *
 * WHY THIS EXISTS
 * ---------------
 * `runScoreEvent` (src/scoring/pipeline.ts) fires on EVERY internal HAL scoring
 * event and always writes `event_type='HAL_SCORE_EVENT'`. Its ZK-proof enqueue
 * therefore floods `repid_proof_queue` with non-economic internal-scoring churn.
 *
 * Beat 8 diagnostic (read-only SQL vs qnnpjhlxljtqyigedwkb, 2026-07-25) [V]:
 *   repid_proof_queue pending = 40,541, of which
 *     HAL_SCORE_EVENT   ≈ 40,258  (99.3% — internal scoring, non-economic)
 *     SERVICE_FULFILLED ≈    252  } genuine economic events (~258 total)
 *     VALIDATOR_REWARD  /  SERVICE_SATISFIED / PREDICTION_RESOLVE ≈ 6
 * The proof-GENERATION consumer has been down since ~2026-06-16, so a future
 * restart would generate + on-chain-anchor 40k churn proofs, burying the ~258
 * gas-worthy economic proofs and paying gas to attest internal scoring.
 *
 * WHAT THIS DOES
 * --------------
 * A pure decision helper that classifies a proof-enqueue event as "churn"
 * (HAL_SCORE_EVENT and friends) vs economic, and — gated by an env lever,
 * SHADOW-FIRST — lets the caller SKIP enqueuing churn proofs so the queue stays
 * a clean, gas-worthy economic set. Same anti-churn discipline as breakers
 * 2.0 / 2.1 / 2.3. Economic events (routed through `applyValidationEvent`) are
 * never classified as churn and are never skipped.
 *
 * SAFETY
 * ------
 *  - Pure: no I/O, no DB, no network — trivially testable, cannot throw on infra.
 *  - Fail-safe: only ever SKIPS a churn proof; never adds an enqueue, never
 *    touches an economic event, never mutates existing rows.
 *  - Shadow-first: default mode 'shadow' logs "would-skip" but behaves exactly
 *    like legacy (still enqueues). 'off' = byte-identical legacy. 'enforce' =
 *    actually skip churn proof enqueues. One env change flips it, fully reversible.
 */

export type ProofEnqueueMode = 'off' | 'shadow' | 'enforce';

/**
 * Event types that produce non-economic, internal-scoring proof churn.
 * `HAL_SCORE_EVENT` is the only one emitted by `runScoreEvent` today; the set
 * keeps room for future internal event types without touching call sites.
 */
export const CHURN_PROOF_EVENT_TYPES: ReadonlySet<string> = new Set([
  'HAL_SCORE_EVENT',
]);

/**
 * Parse the `PROOF_ENQUEUE_HAL_MODE` lever. Unknown / empty / undefined values
 * fall back to 'shadow' (the safe default — observe before gating). Only the
 * three canonical spellings enable/disable; everything else is shadow so a typo
 * can never silently start dropping proofs.
 */
export function parseProofEnqueueMode(raw?: string | null): ProofEnqueueMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'off' || v === 'enforce' || v === 'shadow') return v;
  return 'shadow';
}

/** True iff this event type is internal-scoring proof churn (non-economic). */
export function isChurnProofEvent(eventType: string | null | undefined): boolean {
  if (!eventType) return false;
  return CHURN_PROOF_EVENT_TYPES.has(eventType.trim().toUpperCase());
}

export interface ProofEnqueueDecision {
  /** Whether the event is classified as internal-scoring churn. */
  churn: boolean;
  /** Whether the caller should SKIP the proof enqueue (true only in enforce mode on churn). */
  skip: boolean;
  /** Whether the caller should emit a "would-skip" shadow log (churn + shadow mode). */
  shadow: boolean;
  /** Resolved mode used for the decision. */
  mode: ProofEnqueueMode;
}

/**
 * Decide whether a proof-enqueue for `eventType` should be suppressed.
 *
 * - off      → never skip, never shadow-log (legacy).
 * - shadow   → never skip; shadow-log churn events (observe volume before gating).
 * - enforce  → skip churn events; economic events always pass through.
 *
 * Economic events (anything not in CHURN_PROOF_EVENT_TYPES) always return
 * skip=false regardless of mode.
 */
export function evaluateProofEnqueue(
  eventType: string | null | undefined,
  mode: ProofEnqueueMode
): ProofEnqueueDecision {
  const churn = isChurnProofEvent(eventType);
  return {
    churn,
    skip: churn && mode === 'enforce',
    shadow: churn && mode === 'shadow',
    mode,
  };
}
