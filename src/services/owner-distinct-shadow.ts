/**
 * owner-distinct-shadow.ts — would an owner-distinct counterparty rule credit this trade? SHADOW ONLY.
 *
 * WHY. North Star test 2: at least 90% of daily agent-to-agent trades must be between parties
 * with DIFFERENT owners. Reputation earned trading with yourself is not trust. A rule that
 * refuses or discounts same-owner trades moves RepID, so it is MAJOR and not decided. This file
 * is the finished-and-inert half (CLAUDE_RULES r23): it says what the rule WOULD do, in a log
 * line, and changes no outcome. scripts/metrics/owner-distinct-share.mjs measures the share.
 *
 * "SAME OWNER", AS THE CODE CAN SUPPORT IT TODAY. Owners come from `resolveOwner`
 * (agent-owner-resolver.ts), its ranked sources and its rule that two claims name the same
 * owner only when namespace AND key match (`sameOwner`). Only IDENTITY claims count: a claim
 * with a key, in a namespace other than `opaque` (the KYA custodian TIER is a category such as
 * "qualified_investor", not a person; comparing it as an owner would make every agent of that
 * tier one owner).
 *   same      the same agent on both sides, or ANY identity claim of the buyer names the same
 *             owner as ANY identity claim of the provider. Any shared claim counts, not just the
 *             winners: a lower-ranked row that ties the two together is still evidence of
 *             common control, and for a refusal that is the direction to err in.
 *   distinct  no shared claim, and each side's strongest identity claim is in the SAME
 *             namespace (so the keys are comparable) and differs.
 *   unknown   everything else: either side has no identity claim, or the strongest claims sit
 *             in different namespaces (a builder id and an SBT token can be the same person).
 *             Unknown is NOT distinct. It is the house rule: TRUE only on positive evidence.
 *
 * EVIDENCE, reported next to every relation (XC1 review of #1429):
 *   strong          every claim the answer rests on was SIGNED by someone (an ownership binding,
 *                   a delegation, a custodianship link: assurance attested_unverified or above).
 *   administrative  at least one of them is the unsigned `repid_agents.builder_id` FK. A test
 *                   fixture with its own builder id reads as a distinct owner here, so an
 *                   administrative `distinct` must never count toward the 90% target.
 *   none            relation is unknown; there is nothing to grade.
 *
 * GAPS:
 *   - MEASURED 2026-10-16: the 12 agents that traded in 30 days have zero ownership bindings,
 *     zero delegations, zero custodianship links, so every answer today is administrative.
 *   - `conservator_address` is deliberately not a source (it is the engine's minting signer).
 *     Agents with no builder_id and only a KYA tier (orch, w3c) are therefore `unknown`.
 *   - Cross-namespace equality is not established anywhere (no builder ↔ SBT ↔ wallet map).
 *   - Resolver quirk: a non-SBT binding with no builder_id carries a WALLET under kind
 *     `builder_id`. A builder id is a uuid, so a non-uuid key in that namespace is read here as
 *     a `wallet` and can never be compared with a builder (it would otherwise read as distinct).
 *
 * This module DECIDES NOTHING and writes nothing. With OWNER_DISTINCT_SHADOW unset the caller
 * never reaches it; with it set to 'true' it adds one log line per fulfilled contract.
 */
import {
  resolveOwner,
  sameOwner,
  ASSURANCE_RANK,
  type AgentRef,
  type OwnerClaim,
  type OwnerResolution,
} from './agent-owner-resolver';

export type OwnerRelation = 'distinct' | 'same' | 'unknown';
export type OwnerEvidence = 'strong' | 'administrative' | 'none';
export type OwnerDistinctWould = 'credit' | 'refuse_same_owner' | 'refuse_unknown';

export interface OwnerRelationResult {
  relation: OwnerRelation;
  evidence: OwnerEvidence;
}

/** What the rule would do for each relation. Unknown is refused: fail closed, never open. */
export const OWNER_DISTINCT_WOULD: Record<OwnerRelation, OwnerDistinctWould> = {
  distinct: 'credit',
  same: 'refuse_same_owner',
  unknown: 'refuse_unknown',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const identityClaims = (r: Pick<OwnerResolution, 'claims'>): OwnerClaim[] =>
  r.claims
    .filter((c) => c.ownerKey !== null && c.ownerKeyKind !== 'opaque')
    .map((c) => (c.ownerKeyKind === 'builder_id' && !UUID_RE.test(String(c.ownerKey)) ? { ...c, ownerKeyKind: 'wallet' as const } : c))
    .sort((a, b) => ASSURANCE_RANK[b.assurance] - ASSURANCE_RANK[a.assurance]);

const evidenceOf = (...claims: OwnerClaim[]): Exclude<OwnerEvidence, 'none'> =>
  claims.every((c) => ASSURANCE_RANK[c.assurance] >= ASSURANCE_RANK.attested_unverified) ? 'strong' : 'administrative';

/** PURE. The relation between the two parties' owners, and how strong the evidence is. */
export function ownerRelation(
  buyer: Pick<OwnerResolution, 'agentId' | 'claims'>,
  provider: Pick<OwnerResolution, 'agentId' | 'claims'>,
): OwnerRelationResult {
  if (buyer.agentId !== null && buyer.agentId === provider.agentId) return { relation: 'same', evidence: 'strong' };
  const b = identityClaims(buyer);
  const p = identityClaims(provider);
  const shared = b.flatMap((x) => p.filter((y) => sameOwner(x, y)).map((y) => evidenceOf(x, y)));
  if (shared.length > 0) return { relation: 'same', evidence: shared.includes('strong') ? 'strong' : 'administrative' };
  if (b[0] && p[0] && b[0].ownerKeyKind === p[0].ownerKeyKind) return { relation: 'distinct', evidence: evidenceOf(b[0], p[0]) };
  return { relation: 'unknown', evidence: 'none' };
}

/** Default OFF. Strict 'true', like every gate in this engine (config/flag-readiness.ts). */
export function ownerDistinctShadowEnabled(): boolean {
  return process.env.OWNER_DISTINCT_SHADOW === 'true';
}

export interface OwnerDistinctShadowLine {
  event: 'owner_distinct_shadow';
  contract_id: string;
  relation: OwnerRelation;
  evidence: OwnerEvidence;
  would: OwnerDistinctWould;
}

/**
 * Resolve both owners and log what the rule would do. Reads only, never throws, returns the line
 * (null when the flag is off or the read failed) so a test can assert it without parsing stdout.
 */
export async function logOwnerDistinctShadow(
  contract: { id: string; buyer_agent_id: string; provider_agent_id: string },
  resolve: (ref: AgentRef) => Promise<OwnerResolution> = resolveOwner,
): Promise<OwnerDistinctShadowLine | null> {
  if (!ownerDistinctShadowEnabled()) return null;
  try {
    const [buyer, provider] = await Promise.all([
      resolve({ id: contract.buyer_agent_id }),
      resolve({ id: contract.provider_agent_id }),
    ]);
    const { relation, evidence } = ownerRelation(buyer, provider);
    const line: OwnerDistinctShadowLine = {
      event: 'owner_distinct_shadow',
      contract_id: contract.id,
      relation,
      evidence,
      would: OWNER_DISTINCT_WOULD[relation],
    };
    console.log(JSON.stringify(line));
    return line;
  } catch (e) {
    console.warn(`[owner-distinct-shadow] contract ${contract.id} not measured: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
