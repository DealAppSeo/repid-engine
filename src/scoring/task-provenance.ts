/**
 * task-provenance.ts — demand-provenance class for a task (TrustLattice v0.3 §2).
 *
 * WHY (Grok red-team #1, the strongest objection). A reputation system can be gamed even when every
 * deliverable is independently verified — if the swarm is allowed to MANUFACTURE the work, inflate its
 * difficulty, and define its value. So reward must separate "did the agent do what it claimed?" (a
 * HAL/RepID question, already handled) from "was the work externally valuable enough to justify the
 * reward?" (this file). They are ORTHOGONAL to `task-purpose.ts`, which asks a third thing — is a HAL
 * hallucination-veto a legitimate scoring surface here. A task has all three axes at once.
 *
 * THE THREE CLASSES (one immutable class per task; the issuer, never the Maker, sets it):
 *   E — externally grounded: an outside party requested it with a verifiable outcome, a frozen
 *       known-answer / gold benchmark, or an independently validated production impact. The ONLY class
 *       that may ever carry a difficulty/demand multiplier (spec §2: O and S are fixed at D=1).
 *   O — owner-sponsored: a human conductor signed the objective and value budget. Legitimate
 *       prioritisation, NOT independent proof of value — capped, no multiplier.
 *   S — swarm-proposed: an idea/ticket the automation generated (dreams, cron, always-on). A small
 *       capped investigation bounty only; it can never inflate its own reward.
 *
 * THE GUARDRAIL — conservative default is S. A positive reward needs an AFFIRMATIVE signal, mirroring
 * `task-purpose.isDeliverableDomain`: E needs a positive external-demand signal, O needs a positive
 * owner-sign signal, and ANYTHING ELSE (incl. `insert_source='system'`, the 363,865-row automated
 * swarm [V 2026-11-04, Trinity prod]) falls through to S — the smallest cap, no multiplier. So a
 * self-generated task can never masquerade as externally valuable: the lie Grok #1 names dies here.
 *
 * PURE + INERT. No I/O, no DB, no env, no clock. It classifies the task shape it is handed and returns a
 * class + the experimental reward ceiling for that class. It is wired to NO scoring path yet: capping an
 * experimental bounty by this class is a separate, owner-gated step (shadow first), built later. The caps
 * below are TrustLattice v0.3 §2 placeholders, not implemented RepID rules — Sean owns the final values.
 */

export type ProvenanceClass = 'E' | 'O' | 'S';

/**
 * Experimental reward ceilings per class (TrustLattice v0.3 §2 illustrative placeholders: E≤150, O≤50,
 * S≤5). NOT live RepID rules and not tuned — Sean owns the final values; tune only through shadow A/B.
 */
export const PROVENANCE_CAPS: Record<ProvenanceClass, number> = { E: 150, O: 50, S: 5 };

export interface ProvenanceVerdict {
  provenanceClass: ProvenanceClass;
  /** This class's experimental reward ceiling (PROVENANCE_CAPS). */
  rewardCap: number;
  /** Only E may carry a difficulty/demand multiplier; O and S are fixed at D=1 (spec §2). */
  multiplierEligible: boolean;
  /** Machine-readable reason, for the experimental event and for audit. */
  reason: string;
}

/** The minimal task shape the classifier reads — all verified `trinity_tasks` columns [V 2026-11-04]. */
export interface TaskProvenanceInput {
  insert_source: string | null | undefined;
  sprint_tag?: string | null;
  /** jsonb; only `external_sponsor` / `demand_evidence_ref` / `owner_signed` are consulted. */
  metadata?: Record<string, unknown> | null;
}

/**
 * insert_source prefixes that mean a HUMAN conductor dispatched the task (→ O). Kept deliberately small
 * and grounded in live sources [V 2026-11-04]; everything not here (incl. `system`, `always-on-*`,
 * `autonomous-*`, `overnight-*`, `midnight-*`, `evergreen-*`, and unrecognised historical one-offs) falls
 * through to S by design — under-rewarding (the safe direction), never over-rewarding. Sean owns this set.
 */
const OWNER_SOURCE_PREFIXES = ['claude-sprint', 'claude-loop', 'claude-now', 'strategy-claude', 'cowork', 'cc-open-pool'];

/**
 * insert_source values that are a POSITIVE external-demand signal (→ E). EMPTY today: nothing in
 * `trinity_tasks` is externally grounded yet [V 2026-11-04], and the spec forbids pretending otherwise.
 * An E task must instead carry an explicit metadata signal (external_sponsor / demand_evidence_ref), or
 * be added here when a real external-demand source exists. Sean owns this set.
 */
const EXTERNAL_SOURCES = new Set<string>();

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

const verdict = (provenanceClass: ProvenanceClass, reason: string): ProvenanceVerdict => ({
  provenanceClass,
  rewardCap: PROVENANCE_CAPS[provenanceClass],
  multiplierEligible: provenanceClass === 'E',
  reason,
});

/**
 * Classify a task's demand provenance. Pure + total. Checks for an affirmative E signal, then an
 * affirmative O signal, then defaults to S — so the absence of any signal is the smallest reward, never
 * the largest. Evidence-of-external-demand always wins; a swarm task cannot relabel itself upward.
 */
export function classifyProvenance(task: TaskProvenanceInput): ProvenanceVerdict {
  const src = (task.insert_source ?? '').trim().toLowerCase();
  const meta = task.metadata ?? {};

  // E — an affirmative external-demand signal. Metadata flags first (the forward path), then the
  // (currently empty) source allowlist. No signal ⇒ NOT E, whatever the task claims about itself.
  if (nonEmpty(meta['external_sponsor']) || nonEmpty(meta['demand_evidence_ref']) || EXTERNAL_SOURCES.has(src)) {
    return verdict('E', 'externally grounded — positive external-demand signal (sponsor/evidence_ref)');
  }

  // O — an affirmative owner-sign signal: an explicit owner signature, or a human-conductor dispatch source.
  if (meta['owner_signed'] === true || OWNER_SOURCE_PREFIXES.some((p) => src.startsWith(p))) {
    return verdict('O', `owner-sponsored — human conductor signed/dispatched (${src || 'owner_signed'})`);
  }

  // S — default. Swarm/automation-generated (incl. insert_source='system') or any unrecognised source.
  // The conservative floor: no affirmative external or owner signal ⇒ smallest cap, no multiplier.
  return verdict('S', `swarm-proposed — no external or owner signal (${src || 'unset'}); capped, no difficulty multiplier`);
}
