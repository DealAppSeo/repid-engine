/**
 * Detection-probability (P_catch) interface — STUB for GA's Phase-2 detection-probability sweep.
 * Branch: feat/cc-2026-06-29-v3.1-audit-atomic-penalty. NOT wired into the live pipeline yet.
 *
 * WHY: GA's economic sim is replacing the hard-coded `detected = true` with a per-adversary detection
 * PROBABILITY, and sweeping "what is the MINIMUM P_catch that keeps EV<0 for attack class Y?" The output is a
 * target table ("HAL must catch >= X% of class Y"). This file gives that sweep a real TypeScript shape to bind
 * to, and marks the three real sources that will eventually PRODUCE a P_catch so Phase-2 isn't testing a fiction.
 *
 * HONEST STATUS (cold-audit finding): detection efficacy is UNPROVEN. These are INPUTS to be measured/swept,
 * never asserted. Nothing here governs a live score. BUILD -> MEASURE, never GOVERN.
 */

/** Attack classes the sim scores. Keep in lockstep with GA's sim adversary list (reconcile names with GA). */
export type AttackClass =
  | 'threshold_dance'      // sit just under the veto threshold to farm +delta (the open economic gap)
  | 'sybil'                // many cheap identities to manufacture consensus
  | 'collusion'            // coordinated rubber-stamp / mutual vouch
  | 'false_pass'           // approve broken work as a verifier
  | 'hallucination'        // confidently wrong claim
  | 'mercy_stack'          // P1-4: floor_override recovery-grace + intent-grace stacked
  | 'lazy_artifact';       // ship nothing / NO_ARTIFACT_SAVED

/** Where a real P_catch comes from once wired (the detector that would catch this class). */
export type DetectionSource =
  | 'hal_confidence'       // HAL cross-LLM verdict confidence vs a per-class threshold
  | 'predicate_gate'       // §7.1b objective-predicate gate (pre-commit anchor / provenance / repeat-window)
  | 'redteam_adjudication' // S-REDTEAM finder catching a fault
  | 'peer_verification'    // peer-verify queue outcome
  | 'none';                // not yet detectable — P_catch = 0 until a detector exists

export interface DetectionProbability {
  attackClass: AttackClass;
  /** Probability in [0,1] that an instance of this class is caught. INPUT to the sim; measured, never assumed. */
  pCatch: number;
  source: DetectionSource;
  /** True once a real detector backs this number; false = placeholder for the sweep. */
  calibrated: boolean;
  /** Free-text provenance: which measurement/run produced pCatch (e.g. GA_SIM_DETECTION_TARGETS.md row). */
  basis?: string;
}

/**
 * Per-class detection config. pCatch values are PLACEHOLDERS (calibrated:false) — GA's sweep overrides them and
 * the resulting "HAL must catch >= X%" bars get pre-registered as §7.3 graduation targets. Until calibrated,
 * treat pCatch as 0 for any GOVERNING decision (fail-closed: undetectable = ungoverned).
 */
export const DETECTION_TARGETS: Record<AttackClass, DetectionProbability> = {
  threshold_dance: { attackClass: 'threshold_dance', pCatch: 0, source: 'hal_confidence',       calibrated: false },
  sybil:           { attackClass: 'sybil',           pCatch: 0, source: 'predicate_gate',       calibrated: false },
  collusion:       { attackClass: 'collusion',       pCatch: 0, source: 'peer_verification',    calibrated: false },
  false_pass:      { attackClass: 'false_pass',      pCatch: 0, source: 'redteam_adjudication', calibrated: false },
  hallucination:   { attackClass: 'hallucination',   pCatch: 0, source: 'hal_confidence',       calibrated: false },
  mercy_stack:     { attackClass: 'mercy_stack',     pCatch: 0, source: 'predicate_gate',       calibrated: false },
  lazy_artifact:   { attackClass: 'lazy_artifact',   pCatch: 0, source: 'redteam_adjudication', calibrated: false },
};

/** Sim/consumer entry point. Returns the (current, possibly-placeholder) P_catch for a class. */
export function getDetectionProbability(attackClass: AttackClass): DetectionProbability {
  return DETECTION_TARGETS[attackClass] ?? { attackClass, pCatch: 0, source: 'none', calibrated: false };
}

/**
 * TODO (Phase-2 wiring, after GA's sweep sets the targets):
 *  - hal_confidence  -> read the real HAL cross-LLM verdict confidence in scoring/pipeline.ts (S-DRAIN already
 *    computes quorum/hallucination_caught); map confidence -> pCatch per class vs GA's minimum bar.
 *  - predicate_gate  -> bind to the §7.1b objective-predicate stubs (pre-commit anchor / provenance / repeat-window)
 *    once §7.1b leaves BLOCKED-FOR-SHADOW.
 *  - redteam_adjudication -> derive empirical catch-rate from red_team_results (good_catch vs missed).
 * Each wiring must report a calibrated:true DetectionProbability with `basis` pointing at the measurement run.
 */
