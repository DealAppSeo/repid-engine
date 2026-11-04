/**
 * owner-classes.ts — designated squad owners for the behavioral-independence experiment, honestly labeled so a
 * designation can NEVER be counted as verified independence.
 *
 * WHY (design map 2026-11-03, owner-classes & agent-success). Today every Trinity agent is controlled by one
 * human (Sean), so the evidence resolver (agent-owner-resolver.ts) returns `owner_unknown` for every cross-squad
 * pair (no signed binding says otherwise) and `verifierIndependence` (#1470) fails closed — there is no
 * independent counterparty to run the trust experiment against. To exercise the independence machinery we DESIGNATE
 * a distinct owner per squad (Sean=Orchestration, Matthew=Alpha, Mark=BETA, Luke=GAMMA). That is a fiction for the
 * experiment, and the whole point of this module is to keep the fiction from ever being mistaken for fact.
 *
 * TWO DIFFERENT THINGS, DELIBERATELY SEPARATE.
 *   - `kind` (real | designated) describes the OWNER PRINCIPAL: `real` = a genuinely distinct human who actually
 *     controls the squad; `designated` = a label we assigned for the experiment (the squad is really still Sean's).
 *   - `assurance` (verified | designated | none) describes an INDEPENDENCE VERDICT between two agents.
 * They are not the same, and `kind: real` does NOT upgrade a verdict to `verified`. The ONLY path to `verified` is
 * the EVIDENCE resolver positively establishing two different real owners. This module never produces `verified`.
 *
 * THE NON-NEGOTIABLE GUARDRAIL (assessIndependence). Evidence always wins:
 *   - real `independent`  → verified   (the evidence resolver found two distinct real owners — gold standard).
 *   - real `same_owner`   → NOT independent, `none`. A genuine same-owner pair is NEVER laundered into independent
 *                           by a squad designation. You cannot un-same-owner two agents by relabeling them.
 *   - real `owner_unknown`→ designation may fill the gap: two DIFFERENT designated squads → independent/`designated`
 *                           (eligible for the experiment, flagged forever); otherwise NOT independent.
 * So a designated verdict is tagged `designated` and must be recorded as such on the experimental event; a caller
 * that aggregates `designated` into a verified-independent-trust metric is reintroducing exactly the lie this guards.
 *
 * BEHAVIORAL-VALIDITY CAVEAT (not enforceable in code, stated so it is not forgotten). Designation is a valid proxy
 * for independence ONLY with real behavioral separation — different goals/priorities per squad and no shared
 * backchannel. Without that you are studying coordinated agents wearing independent labels, and the `designated`
 * tag is the honest admission that this has not been established.
 *
 * PURE + INERT. No I/O, no DB, no flag. `assessIndependence` TAKES the real `PartyIndependence` (computed by the
 * caller via the existing resolveOwner / verifierIndependence path) and layers the designation on top. Nothing
 * here reads the DB, moves a score, or is wired in; applying a designated verdict stays inside the already-gated
 * SAME_OWNER_SETTLEMENT_MODE (shadow first) / experimental path — an owner-gated flip, built separately.
 */
import type { PartyIndependence } from '../scoring/grounding';

export type OwnerKind = 'real' | 'designated';

/** How an independence verdict was established. `verified` ⇒ evidence; `designated` ⇒ experiment label only. */
export type IndependenceAssurance = 'verified' | 'designated' | 'none';

export interface DesignatedOwner {
  /** stable experiment principal id. */
  principal: string;
  /** real = a genuinely distinct controller; designated = an experiment label (Sean still controls it today). */
  kind: OwnerKind;
  /** human-readable squad name. */
  squad: string;
}

/**
 * squad_id (repid_agents.squad_id, uuid) → designated owner. Grounded [V 2026-11-03, Trinity prod]: the four
 * active Trinity squads are exactly these uuids, 3 agents each. 148 non-squad agents (mocks/humans/probes) carry
 * a null squad_id and get NO designation (fail closed). Config-of-record for the experiment — Sean owns it.
 */
const SQUAD_OWNERS: Record<string, DesignatedOwner> = {
  '550e8400-e29b-41d4-a716-446655440004': { principal: 'owner:sean', kind: 'real', squad: 'orchestration' }, // orch, shofet, w3c
  '550e8400-e29b-41d4-a716-446655440001': { principal: 'owner:matthew', kind: 'designated', squad: 'alpha' }, // gcm, torch, veritas
  '550e8400-e29b-41d4-a716-446655440002': { principal: 'owner:mark', kind: 'designated', squad: 'beta' }, // apm, chesed, mel
  '550e8400-e29b-41d4-a716-446655440003': { principal: 'owner:luke', kind: 'designated', squad: 'gamma' }, // hdm, nexus, sophia
};

/** The designated owner for a squad, or null when the squad is unknown / unset (no designation — fail closed). */
export function designatedOwnerForSquad(squadId: string | null | undefined): DesignatedOwner | null {
  if (!squadId) return null;
  return SQUAD_OWNERS[squadId] ?? null;
}

export interface IndependenceAssessment {
  independent: boolean;
  assurance: IndependenceAssurance;
  /** machine-readable reason, for the experimental event and for audit. */
  reason: string;
}

/**
 * Combine the EVIDENCE verdict (`real`, from the existing resolveOwner / verifierIndependence path) with the squad
 * designation. Pure, total. Evidence always wins; a designation only fills an `owner_unknown` gap and is tagged
 * `designated`, never `verified`; a real `same_owner` is never overridden. See the guardrail in the header.
 */
export function assessIndependence(
  real: PartyIndependence,
  a: { squadId?: string | null },
  b: { squadId?: string | null },
): IndependenceAssessment {
  if (real === 'independent') return { independent: true, assurance: 'verified', reason: 'evidence_distinct_owner' };
  if (real === 'same_owner') return { independent: false, assurance: 'none', reason: 'same_real_owner' };

  // real === 'owner_unknown': the only case a designation may speak to.
  const oa = designatedOwnerForSquad(a.squadId);
  const ob = designatedOwnerForSquad(b.squadId);
  if (oa && ob && oa.principal !== ob.principal) {
    return { independent: true, assurance: 'designated', reason: `distinct_designated_owner:${oa.principal}|${ob.principal}` };
  }
  return { independent: false, assurance: 'none', reason: oa && ob ? 'same_designated_owner' : 'owner_unknown_undesignated' };
}
