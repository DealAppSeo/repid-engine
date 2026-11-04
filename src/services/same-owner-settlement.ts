/**
 * same-owner-settlement.ts — a trade between two agents of one owner is not independent evidence.
 *
 * WHY (Sean, option M2, 2026-11-02). The daily attestation-minter (scripts/cron/mint-attestation.mjs)
 * has trinity-nexus buy from another fleet agent, and every run paid canonical RepID to both sides:
 * SERVICE_FULFILLED provider +10 / buyer +5, SERVICE_SATISFIED provider +30 / buyer +15. One owner
 * on both sides. Reputation earned trading with yourself is not trust.
 *
 * SAME_OWNER_SETTLEMENT_MODE (parsed in scoring/grounding.ts, shared with the payment resolver):
 *   unset / 'off'  no owner lookup, no new metadata: byte-for-byte today.
 *   'shadow'       look the owners up; every settlement row records `same_owner_settlement`
 *                  (would_not_count: same_owner | owner_unknown | null); no number changes.
 *   'enforce'      same owner, or an owner that cannot be established, earns 0 canonical RepID.
 *
 * WHERE IT APPLIES (validation-repid-delta.ts): T1 SERVICE_FULFILLED, T2 SERVICE_SATISFIED, T3
 * SERVICE_OUTCOME, dispute deltas (both sides, penalty and award), and the ERC-8004 on-chain write
 * the T1 bridge row leads to (inline call skipped + bridge row born processed so FeedbackLoopWorker
 * never drains it). Payment grounding uses counterpartyIndependenceFor below.
 *
 * OWNERS. One rule, not a second: #1470's verifier check (bounty-authorization.ts
 * verifierIndependence) over agent-owner-resolver. Self and any shared identity claim = same owner;
 * anything not POSITIVELY a different owner in a comparable namespace = owner_unknown. Fail closed.
 */
import { db } from '../db';
import { verifierIndependence } from './bounty-authorization';
import { resolveOwner, type AgentRef, type OwnerResolution } from './agent-owner-resolver';
import { assessIndependence, type IndependenceAssurance } from './owner-classes';
import { sameOwnerSettlementMode, type PartyIndependence, type SameOwnerSettlementMode } from '../scoring/grounding';

type Resolve = (ref: AgentRef) => Promise<OwnerResolution>;

/** agentId -> squad_id (repid_agents.squad_id, uuid) for the two parties; null when unknown. Owner-classes only. */
type Squads = (buyerId: string, providerId: string) => Promise<{ buyer: string | null; provider: string | null }>;
const dbSquads: Squads = async (buyerId, providerId) => {
  const { data, error } = await db.from('repid_agents').select('id, squad_id').in('id', [buyerId, providerId]);
  if (error || !data) return { buyer: null, provider: null };
  const m = new Map((data as { id: string; squad_id: string | null }[]).map((r) => [r.id, r.squad_id]));
  return { buyer: m.get(buyerId) ?? null, provider: m.get(providerId) ?? null };
};

/** Never throws: verifierIndependence turns a failed lookup into owner_not_established. */
export async function partyIndependence(a: string, b: string, resolve: Resolve = resolveOwner): Promise<PartyIndependence> {
  const r = await verifierIndependence(a, b, resolve);
  if (r.ok) return 'independent';
  return r.reason === 'owner_not_established' ? 'owner_unknown' : 'same_owner';
}

export interface SameOwnerSettlementTag {
  mode: Exclude<SameOwnerSettlementMode, 'off'>;
  would_not_count: Exclude<PartyIndependence, 'independent'> | null;
  /** false only under enforce: this row's delta was withheld. */
  counted: boolean;
  /** What the row would carry without the rule. */
  ungated_delta: number;
}
/**
 * EXPERIMENT (owner-classes, shadow-only overlay): how independence WOULD be assured if the squad designation
 * were real — `verified` (evidence found two distinct real owners), `designated` (a squad fiction, NEVER counted
 * as verified), or `none`. A SEPARATE key from the settlement tag on purpose: it NEVER governs `counted` — a
 * designation cannot un-withhold a real delta (evidence does that, in the tag). Aggregating `designated` as
 * verified reintroduces the lie this guards.
 */
export interface OwnerAssuranceTag {
  assurance: IndependenceAssurance;
  reason: string;
}
type Side = { delta: number; meta: { same_owner_settlement?: SameOwnerSettlementTag; owner_assurance?: OwnerAssuranceTag } };

/**
 * Gate one contract's provider and buyer deltas. 'off' returns them untouched with empty metadata
 * and reads nothing.
 */
export async function gateSettlementDeltas(
  contract: { id: string; provider_agent_id: string; buyer_agent_id: string },
  deltas: { provider: number; buyer: number },
  resolve: Resolve = resolveOwner,
  squads: Squads = dbSquads,
): Promise<{ provider: Side; buyer: Side }> {
  const mode = sameOwnerSettlementMode();
  if (mode === 'off') return { provider: { delta: deltas.provider, meta: {} }, buyer: { delta: deltas.buyer, meta: {} } };

  const independence = await partyIndependence(contract.buyer_agent_id, contract.provider_agent_id, resolve);
  const notCounted = independence === 'independent' ? null : independence;
  const withhold = mode === 'enforce' && notCounted !== null;

  // EXPERIMENT (owner-classes): layer the squad designation on the REAL verdict, honestly tagged. This only
  // annotates how independence WOULD be assured if the designation were real — evidence still governs
  // `counted`/`withhold` (unchanged below), so a `designated` can never un-withhold a real delta. Resolve squads
  // only when the real verdict is owner_unknown (the sole case a designation may speak to) — otherwise no DB read.
  const squadIds = independence === 'owner_unknown'
    ? await squads(contract.buyer_agent_id, contract.provider_agent_id)
    : { buyer: null, provider: null };
  const assurance = assessIndependence(independence, { squadId: squadIds.buyer }, { squadId: squadIds.provider });

  if (notCounted) {
    console.log(JSON.stringify({ event: 'same_owner_settlement', contract_id: contract.id, mode, would_not_count: notCounted, withheld: withhold, owner_assurance: assurance.assurance }));
  }
  const side = (d: number): Side => ({
    delta: withhold ? 0 : d,
    meta: {
      same_owner_settlement: { mode, would_not_count: notCounted, counted: !withhold, ungated_delta: d },
      owner_assurance: { assurance: assurance.assurance, reason: assurance.reason },
    },
  });
  return { provider: side(deltas.provider), buyer: side(deltas.buyer) };
}

/**
 * For the payment-grounding resolver: is the agent behind `wallet` owned by someone other than
 * `agentId`? A wallet that maps to no registered agent, or to more than one, has no owner we can
 * establish, so it is owner_unknown.
 */
export function counterpartyIndependenceFor(agentId: string, resolve: Resolve = resolveOwner) {
  return async (wallet: string): Promise<PartyIndependence> => {
    const w = wallet.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(w)) return 'owner_unknown'; // also keeps the filter below injection-free
    const { data, error } = await db
      .from('repid_agents')
      .select('id')
      .or(`wallet_address.ilike.${w},erc8004_address.ilike.${w}`)
      .limit(2);
    if (error || !data || data.length !== 1) return 'owner_unknown';
    return partyIndependence((data[0] as { id: string }).id, agentId, resolve);
  };
}
