/**
 * The RepID event vocabulary and the fixed-delta tariff — extracted so a
 * module that must NEVER write can read them.
 *
 * WHY THIS FILE EXISTS. `FIXED_DELTAS` used to be a private const inside
 * `src/engine/repid-update.ts`, which imports `../db` at module scope. Anything
 * wanting the tariff — a preview, a docs generator, a calculator — had to import
 * the scoring engine and therefore the database client. The progressive-trust
 * signup needs to SHOW a visitor what an action is worth without touching a row,
 * and "we added a dryRun flag to updateRepId" is the wrong shape for that: one
 * missed write site and a preview mutates real reputation.
 *
 * So the constant moved here and this file has NO imports at all. A consumer can
 * depend on the tariff without inheriting a database handle, and
 * `tests/repid-preview.test.ts` asserts that property structurally rather than
 * trusting this comment.
 *
 * THIS IS THE TARIFF, NOT THE OUTCOME. `updateRepId` overrides several of these
 * at runtime — STAKE is forced to 0 pending an on-chain verifier, self-reported
 * positives can be zeroed by the evidence gate, and every applied delta is then
 * passed through the redemption modifier, decay and the ecosystem-need weight.
 * Reading a number out of this table tells you what an event is worth on paper.
 * It does not tell you what an agent would actually be awarded.
 */

/**
 * Every score-changing event class. This is the canonical list: `RepIdUpdateInput`
 * derives its `eventType` from it, so adding a member here is what makes a new
 * event type exist, and an exhaustive `Record<RepIdEventType, …>` anywhere else
 * then fails to compile until the new member is classified.
 */
export type RepIdEventType =
  | 'CHALLENGE_WIN'|'CHALLENGE_LOSS'|'CHALLENGE_DRAW'
  | 'EPISTEMIC_VIOLATION'|'CONSTITUTIONAL_VIOLATION'
  | 'PREDICTION_RESOLVE'
  | 'STAKE'|'GENESIS'|'REFERRAL'|'PEACEMAKER'|'SELF_MONITOR'
  | 'CODE_CONTRIBUTION' | 'WORKFLOW_CONTRIBUTION' | 'TOOL_PIONEER'
  | 'AGENT_TEACHING' | 'AUDIT_CONTRIBUTION'
  | 'HANDOFF_COSIGN_VERIFIED' | 'HANDOFF_COSIGN_FALSE_PASS_SLASH'
  | 'PEER_VERIFY_WRONG_CALL' // Phase 3 dogfooding (behind DOGFOOD_REPID_FROM_COSIGN) + BFT panel divergence
  // --- Ordinary error (light penalty) ------------------------------------
  // An honest wrong answer / unsupported claim. Penalized, but LIGHTLY — it
  // does not attack supervisability. Contrast with DEFENDED_DECEPTION_* below.
  | 'UNSUPPORTED_CLAIM'
  // --- Defended deception (heavy penalty) — Trust Harness P1 KEYSTONE M1 ---
  // These attack the ability to supervise the agent (they corrupt the record
  // itself), so they carry a markedly heavier negative delta than ordinary
  // error. ENFORCEMENT is shadow-first behind TRUST_DECEPTION_MODE.
  | 'DEFENDED_DECEPTION_DENIAL_OF_PRIOR_OUTPUT'
  | 'DEFENDED_DECEPTION_DOUBT_ATTACK'
  | 'DEFENDED_DECEPTION_FABRICATED_CITATION'
  | 'DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT'
  | 'DEFENDED_DECEPTION_FABRICATED_BENCHMARK'
  | 'DEFENDED_DECEPTION_THRESHOLD_DANCING'
  | 'DEFENDED_DECEPTION_SYCOPHANTIC_FALSE_PREMISE'
  | 'DEFENDED_DECEPTION_STORY_CHANGE';

/**
 * Flat per-event deltas for the event classes that do not go through a scorer.
 * Challenge outcomes (`scoreChallengeOutcome`), predictions (`scorePrediction`)
 * and the eight defended-deception classes (`gatedDeceptionDelta`) are absent by
 * design — their value is computed, not tabulated.
 */
export const FIXED_DELTAS: Partial<Record<RepIdEventType, number>> = {
  STAKE: 5, GENESIS: 0, REFERRAL: 20, PEACEMAKER: 15, SELF_MONITOR: 10,
  CODE_CONTRIBUTION: 25, WORKFLOW_CONTRIBUTION: 20, TOOL_PIONEER: 12,
  AGENT_TEACHING: 15, AUDIT_CONTRIBUTION: 15,
  HANDOFF_COSIGN_VERIFIED: 10, // producer + verifier each get + on verified co-sign (calibrated)
  HANDOFF_COSIGN_FALSE_PASS_SLASH: -15, // slash the rubber-stamper (verifier) on false-PASS
  PEER_VERIFY_WRONG_CALL: -5, // BFT panel: reviewer diverged from majority (bounded; low-confidence self-flag exempt)
  // Ordinary error — an honest wrong/unsupported claim. LIGHT penalty. This is
  // the baseline the deception tiers are deliberately heavier than.
  UNSUPPORTED_CLAIM: -8,
};

/** RepID is clamped to this range everywhere it is written. */
export const REPID_MIN = 10;
export const REPID_MAX = 10000;
