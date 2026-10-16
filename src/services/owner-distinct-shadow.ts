/**
 * owner-distinct-shadow.ts — would an owner-distinct counterparty rule credit this trade? SHADOW ONLY.
 *
 * WHY. North Star test 2: at least 90% of daily agent-to-agent trades must be between parties
 * with DIFFERENT owners. Reputation earned trading with yourself is not trust. A rule that
 * refuses or discounts same-owner trades moves RepID, so it is MAJOR and not decided. This file
 * is the finished-and-inert half (CLAUDE_RULES r23): it says what the rule WOULD do, in a log
 * line, and changes no outcome. MEASURED 2026-10-16 (30d, 32 settled contracts): 3 distinct,
 * 25 same, 4 unknown — scripts/metrics/owner-distinct-share.mjs re-runs it.
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
 * GAPS (each one is why `unknown` or a weak `distinct` exists):
 *   - Distinct today rests on `repid_agents.builder_id`, an ADMINISTRATIVE foreign key nobody
 *     signed. MEASURED 2026-10-16: the 12 agents that traded in 30 days have zero ownership
 *     bindings, zero delegations, zero custodianship links. One builder account per agent is
 *     enough to read as distinct, so this is a floor on same-owner trading, not a ceiling.
 *   - `conservator_address` is deliberately not a source (it is the engine's minting signer).
 *     Agents with no builder_id and only a KYA tier (orch, w3c) are therefore `unknown`.
 *   - Cross-namespace equality is not established anywhere (no builder ↔ SBT ↔ wallet map).
 *   - A non-SBT binding with no builder_id carries a WALLET under kind `builder_id` (resolver
 *     quirk, inherited as-is).
 *
 * This module DECIDES NOTHING and writes nothing. With OWNER_DISTINCT_SHADOW unset the caller
 * never reaches it; with it set to 'true' it adds one log line per settled contract.
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
export type OwnerDistinctWould = 'credit' | 'refuse_same_owner' | 'refuse_unknown';

/** What the rule would do for each relation. Unknown is refused: fail closed, never open. */
export const OWNER_DISTINCT_WOULD: Record<OwnerRelation, OwnerDistinctWould> = {
  distinct: 'credit',
  same: 'refuse_same_owner',
  unknown: 'refuse_unknown',
};

const identityClaims = (r: Pick<OwnerResolution, 'claims'>): OwnerClaim[] =>
  r.claims
    .filter((c) => c.ownerKey !== null && c.ownerKeyKind !== 'opaque')
    .sort((a, b) => ASSURANCE_RANK[b.assurance] - ASSURANCE_RANK[a.assurance]);

/** PURE. The relation between the two parties' owners. See the header for the definition. */
export function ownerRelation(
  buyer: Pick<OwnerResolution, 'agentId' | 'claims'>,
  provider: Pick<OwnerResolution, 'agentId' | 'claims'>,
): OwnerRelation {
  if (buyer.agentId !== null && buyer.agentId === provider.agentId) return 'same';
  const b = identityClaims(buyer);
  const p = identityClaims(provider);
  if (b.some((x) => p.some((y) => sameOwner(x, y)))) return 'same';
  if (b[0] && p[0] && b[0].ownerKeyKind === p[0].ownerKeyKind) return 'distinct';
  return 'unknown';
}

/** Default OFF. Strict 'true', like every gate in this engine (config/flag-readiness.ts). */
export function ownerDistinctShadowEnabled(): boolean {
  return process.env.OWNER_DISTINCT_SHADOW === 'true';
}

export interface OwnerDistinctShadowLine {
  event: 'owner_distinct_shadow';
  contract_id: string;
  relation: OwnerRelation;
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
    const relation = ownerRelation(buyer, provider);
    const line: OwnerDistinctShadowLine = {
      event: 'owner_distinct_shadow',
      contract_id: contract.id,
      relation,
      would: OWNER_DISTINCT_WOULD[relation],
    };
    console.log(JSON.stringify(line));
    return line;
  } catch (e) {
    console.warn(`[owner-distinct-shadow] contract ${contract.id} not measured: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
