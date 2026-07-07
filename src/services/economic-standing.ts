/**
 * RepID Economic-Standing / Band guard hook (Anti-Sybil MVP, 2026-07-07).
 *
 * Design: E:\dev\living-docs\03_specs\REPID_ECONOMIC_DESIGN_v1.md §1 (THE BANDS).
 * T2 red-team: E:\dev\reports\2026-07-07\T2_SYBIL_FARMING_REDTEAM.md.
 *
 * Reputation is NOT one score that unlocks everything. Four bands:
 *   PROVISIONAL — free, frictionless, gates NOTHING real (Sybil lives here, inert).
 *   ECONOMIC    — gated by a proof-of-cost bond; the ONLY band that gates spend/autonomy.
 *   VERIFIER    — earned by accurate independent red-team judgments (future).
 *   GOVERNANCE  — slowest, Sybil-resistant identity + contribution (future).
 *
 * This module is the SINGLE WIRING POINT for the PROVISIONAL↔ECONOMIC boundary.
 * The spend / autonomy gates call `isEconomicStanding(agent)` so the boundary
 * exists even before bonds ship.
 *
 * STUB SEMANTICS (bonds not yet built):
 *   - Behind flag REPID_ECONOMIC_BAND_ENABLED (default OFF), this returns `true`
 *     for every agent — i.e. NO behavior change vs today. Callers keep working
 *     exactly as before; the band is a no-op wiring point.
 *   - When the flag is ON, an agent is in ECONOMIC standing only if it holds an
 *     active bond (agent_bonds, migration FILE only — table does not exist in
 *     prod yet). Until the bond table + populate path ship, ON is intentionally
 *     conservative (no active bond ⇒ provisional). Sean's parameters (bond size,
 *     threshold) gate the real rollout — see the build spec §"Needs Sean".
 *
 * RULE-4: no fake-pass may steer scoring. This hook does NOT mutate RepID; it
 * only reports which band an agent is in, for spend/autonomy gates to consult.
 */

export type RepidBand = 'PROVISIONAL' | 'ECONOMIC' | 'VERIFIER' | 'GOVERNANCE';

/** Minimal shape needed to classify a band. Kept structural so callers can pass
 *  a full `repid_agents` row or a thin projection. */
export interface BandAgentLike {
  id?: string;
  current_repid?: number | null;
  /** Present only once the bond table ships. Truthy = an active, unforfeited bond. */
  has_active_bond?: boolean | null;
  /** Optional explicit band override (future GOVERNANCE/VERIFIER promotion path). */
  band?: RepidBand | null;
}

/** True when the ECONOMIC-band gate is switched on. Default OFF → the boundary
 *  is inert and every agent is treated as economic-standing (no behavior change). */
export function economicBandGateEnabled(): boolean {
  return process.env.REPID_ECONOMIC_BAND_ENABLED === 'true';
}

/**
 * Does this agent hold ECONOMIC standing (may earn spend-gating RepID / act with
 * autonomy)? The one function every spend/autonomy gate should call.
 *
 * Flag OFF (default): always true — provisional agents behave exactly as today.
 * Flag ON: true only for an agent with an active proof-of-cost bond (or an
 * explicit ECONOMIC/higher band). No bond ⇒ provisional ⇒ false.
 */
export function isEconomicStanding(agent: BandAgentLike | null | undefined): boolean {
  if (!economicBandGateEnabled()) return true; // inert wiring point — no behavior change
  if (!agent) return false;
  if (agent.band === 'ECONOMIC' || agent.band === 'VERIFIER' || agent.band === 'GOVERNANCE') return true;
  return agent.has_active_bond === true;
}

/**
 * Classify an agent into its band. Advisory/reporting only — the load-bearing
 * gate is `isEconomicStanding`. With the flag OFF everything reads PROVISIONAL
 * for honesty (the band concept is not yet enforced), except an explicit band.
 */
export function classifyBand(agent: BandAgentLike | null | undefined): RepidBand {
  if (agent?.band) return agent.band;
  if (!economicBandGateEnabled()) return 'PROVISIONAL';
  if (agent?.has_active_bond === true) return 'ECONOMIC';
  return 'PROVISIONAL';
}
