/**
 * listing-bridge.ts — the missing step between "I want this" and a real contract.
 *
 * THE GAP. `marketplace_listings` had list and browse and nothing else. A visitor
 * who found a listing and wanted it had nowhere to go: the RFQ engine is a
 * separate path with its own entry, and `marketplace_offers` existed as a table
 * with no endpoints. Every front-end design needs a "buy" button that lands
 * somewhere. This is the landing.
 *
 * WHAT IT DOES NOT DO, AND WHY THAT MATTERS MOST.
 *
 * `service_contracts.service_id` is NOT NULL with an FK to `agent_services`, and
 * the RFQ path already treats that as load-bearing — negotiation.ts calls
 * service_id "the provide-side eligibility proof". So the tempting shortcut here
 * is to auto-create an `agent_services` row per listing to satisfy the FK.
 *
 * That would be a mistake, and a quiet one. Anybody could post a listing and mint
 * themselves a service, which is exactly the eligibility proof the RFQ path
 * requires you to already hold. The provider side would go from "an agent that
 * publishes this service" to "an agent that typed a title", and every downstream
 * surface that reads `agent_services` as a capability claim — the manifest, the
 * catalog, /llms.txt — would silently start reporting listings as capabilities.
 *
 * So the bridge REQUIRES an existing service_id owned by the provider side, and
 * verifies ownership. Same discipline as the RFQ path, on purpose.
 *
 * DIRECTION. A listing's `kind` decides who pays:
 *   have  → the poster is offering. Poster = PROVIDER, offerer = BUYER.
 *   want  → the poster is requesting. Poster = BUYER, offerer = PROVIDER.
 * Getting this backwards would pay the wrong party, so it is derived in one place
 * and tested both ways.
 *
 * HUMANS CANNOT BE CONTRACT PARTIES. buyer_agent_id and provider_agent_id are
 * both FKs to repid_agents. Per spec §2 the human is the GOVERNOR of transacting
 * agents, not a transactor — so a human side resolves through their bound agent
 * (human_agent_bindings). If they have no binding, the offer is refused with a
 * reason rather than being quietly attributed to some agent.
 *
 * FLAG: LISTING_BRIDGE_ENABLED (default OFF). Creates contracts, which is the
 * head of the path that moves money — lands finished and inert per CLAUDE_RULES 23.
 */

import { db } from '../db';

export const LISTING_BRIDGE_ENABLED = process.env.LISTING_BRIDGE_ENABLED === 'true';

export type PartyType = 'agent' | 'human';

export interface Party {
  type: PartyType;
  id: string;
}

export type BridgeReason =
  | 'disabled'
  | 'listing_not_found'
  | 'listing_not_open'
  | 'offer_not_found'
  | 'offer_not_pending'
  | 'not_the_poster'
  | 'self_dealing'
  | 'service_required'
  | 'service_not_found'
  | 'service_not_owned_by_provider'
  | 'human_not_bound'
  | 'binding_disabled'
  | 'invalid_amount'
  | 'write_failed';

export interface BridgeResult<T> {
  ok: boolean;
  data?: T;
  reason?: BridgeReason;
  detail?: string;
}

/**
 * Which side pays. Derived once; a mistake here pays the wrong party.
 */
export function resolveRoles(
  kind: 'have' | 'want',
  poster: Party,
  offerer: Party,
): { buyer: Party; provider: Party } {
  return kind === 'have'
    ? { buyer: offerer, provider: poster }
    : { buyer: poster, provider: offerer };
}

/**
 * A human acts through the agent they own. Never through an agent we picked.
 */
export async function resolveToAgent(party: Party): Promise<BridgeResult<string>> {
  if (party.type === 'agent') return { ok: true, data: party.id };

  const bindingEnabled = process.env.HUMAN_AGENT_BIND_ENABLED === 'true';
  if (!bindingEnabled) {
    return {
      ok: false,
      reason: 'binding_disabled',
      detail:
        'Human parties transact through an agent they own, and ownership binding is not enabled ' +
        'on this deployment. An agent-to-agent exchange works today.',
    };
  }

  const { data } = await db
    .from('human_agent_bindings')
    .select('agent_id')
    .eq('builder_id', party.id)
    .is('revoked_at', null)
    .limit(1);
  const agentId = (data ?? [])[0]?.agent_id;
  if (!agentId) {
    return {
      ok: false,
      reason: 'human_not_bound',
      detail:
        'This account does not own an agent yet. Bind an agent first — a contract party must be ' +
        'an agent, because the human is the governor of a transacting agent rather than a party to it.',
    };
  }
  return { ok: true, data: String(agentId) };
}

export interface CreateOfferInput {
  listingId: string;
  offerer: Party;
  amountUsdc?: number | null;
  message?: string | null;
  /** Required when the OFFERER is the provider (a `want` listing). */
  serviceId?: string | null;
}

export interface OfferRow {
  id: string;
  listing_id: string;
  offerer_id: string;
  offerer_type: string;
  amount_usdc: number | null;
  message: string | null;
  status: string;
  created_at: string;
}

export async function createOffer(input: CreateOfferInput): Promise<BridgeResult<OfferRow>> {
  if (!LISTING_BRIDGE_ENABLED) {
    return { ok: false, reason: 'disabled', detail: 'Listing offers are not enabled on this deployment.' };
  }

  const { data: listing } = await db
    .from('marketplace_listings')
    .select('id, poster_type, poster_id, kind, status, price_usdc')
    .eq('id', input.listingId)
    .maybeSingle();
  if (!listing) {
    return { ok: false, reason: 'listing_not_found', detail: 'No such listing.' };
  }
  if ((listing as any).status !== 'open') {
    return {
      ok: false,
      reason: 'listing_not_open',
      detail: `This listing is '${(listing as any).status}', not open to offers.`,
    };
  }

  const poster: Party = {
    type: (listing as any).poster_type as PartyType,
    id: String((listing as any).poster_id),
  };

  // Same-identity check before anything else — the DB has a no-self-dealing
  // CHECK, but a 500 from a constraint is a worse answer than a clear refusal.
  if (poster.type === input.offerer.type && poster.id === input.offerer.id) {
    return {
      ok: false,
      reason: 'self_dealing',
      detail: 'You cannot make an offer on your own listing.',
    };
  }

  if (input.amountUsdc != null && !(Number(input.amountUsdc) > 0)) {
    return { ok: false, reason: 'invalid_amount', detail: 'amount_usdc must be greater than zero.' };
  }

  const { data, error } = await db
    .from('marketplace_offers')
    .insert({
      listing_id: input.listingId,
      offerer_id: input.offerer.id,
      offerer_type: input.offerer.type,
      amount_usdc: input.amountUsdc ?? (listing as any).price_usdc ?? null,
      // The service_id travels in the message envelope rather than a new column,
      // so this needs no DDL. It is re-verified at accept time regardless.
      message: input.serviceId
        ? JSON.stringify({ note: input.message ?? null, service_id: input.serviceId })
        : (input.message ?? null),
      status: 'pending',
    })
    .select('id, listing_id, offerer_id, offerer_type, amount_usdc, message, status, created_at')
    .single();

  if (error || !data) {
    return { ok: false, reason: 'write_failed', detail: error?.message ?? 'insert failed' };
  }
  return { ok: true, data: data as unknown as OfferRow };
}

/** Pull a service_id back out of an offer, whichever shape it was stored in. */
export function serviceIdFromOffer(message: string | null): string | null {
  if (!message) return null;
  try {
    const parsed = JSON.parse(message);
    return typeof parsed?.service_id === 'string' ? parsed.service_id : null;
  } catch {
    return null;
  }
}

export interface AcceptResult {
  offer_id: string;
  contract_id: string;
  buyer_agent_id: string;
  provider_agent_id: string;
  agreed_price_usdc_raw: number;
  next: string;
}

/**
 * The poster accepts an offer, and a real contract exists.
 *
 * From here the existing path takes over unchanged: escrow takes an EIP-3009
 * authorization, the work is delivered and verified, and payment releases only
 * then. This function deliberately does NOT touch money — it hands off to the
 * flow that already knows how.
 */
export async function acceptOffer(params: {
  offerId: string;
  /** Who is calling. Must be the listing's poster. */
  caller: Party;
  /** Required when the PROVIDER is the poster (a `have` listing). */
  serviceId?: string | null;
}): Promise<BridgeResult<AcceptResult>> {
  if (!LISTING_BRIDGE_ENABLED) {
    return { ok: false, reason: 'disabled', detail: 'Listing offers are not enabled on this deployment.' };
  }

  const { data: offer } = await db
    .from('marketplace_offers')
    .select('id, listing_id, offerer_id, offerer_type, amount_usdc, message, status')
    .eq('id', params.offerId)
    .maybeSingle();
  if (!offer) return { ok: false, reason: 'offer_not_found', detail: 'No such offer.' };
  if ((offer as any).status !== 'pending') {
    return {
      ok: false,
      reason: 'offer_not_pending',
      detail: `This offer is already '${(offer as any).status}'.`,
    };
  }

  const { data: listing } = await db
    .from('marketplace_listings')
    .select('id, poster_type, poster_id, kind, status, price_usdc')
    .eq('id', (offer as any).listing_id)
    .maybeSingle();
  if (!listing) return { ok: false, reason: 'listing_not_found', detail: 'The listing no longer exists.' };
  if ((listing as any).status !== 'open') {
    return {
      ok: false,
      reason: 'listing_not_open',
      detail: `This listing is '${(listing as any).status}', not open.`,
    };
  }

  const poster: Party = {
    type: (listing as any).poster_type as PartyType,
    id: String((listing as any).poster_id),
  };

  // Only the poster may accept. Anyone else accepting would let a third party
  // commit two strangers to a contract.
  if (params.caller.type !== poster.type || params.caller.id !== poster.id) {
    return {
      ok: false,
      reason: 'not_the_poster',
      detail: 'Only the agent or account that posted this listing may accept an offer on it.',
    };
  }

  const offerer: Party = {
    type: (offer as any).offerer_type as PartyType,
    id: String((offer as any).offerer_id),
  };
  const kind = (listing as any).kind as 'have' | 'want';
  const roles = resolveRoles(kind, poster, offerer);

  // Both sides must be agents.
  const buyerAgent = await resolveToAgent(roles.buyer);
  if (!buyerAgent.ok) return { ok: false, reason: buyerAgent.reason, detail: buyerAgent.detail };
  const providerAgent = await resolveToAgent(roles.provider);
  if (!providerAgent.ok) return { ok: false, reason: providerAgent.reason, detail: providerAgent.detail };

  if (buyerAgent.data === providerAgent.data) {
    return {
      ok: false,
      reason: 'self_dealing',
      detail:
        'Both sides resolve to the same agent, so this would be self-dealing. The database refuses ' +
        'it too — this is the earlier, clearer refusal.',
    };
  }

  // The provide-side eligibility proof. NOT auto-created — see module header.
  const serviceId = params.serviceId ?? serviceIdFromOffer((offer as any).message ?? null);
  if (!serviceId) {
    return {
      ok: false,
      reason: 'service_required',
      detail:
        'A contract must reference a service the provider already publishes — that is the ' +
        'provide-side eligibility proof. Supply service_id.',
    };
  }
  const { data: service } = await db
    .from('agent_services')
    .select('id, provider_agent_id, active, base_price_usdc_raw')
    .eq('id', serviceId)
    .maybeSingle();
  if (!service || (service as any).active !== true) {
    return { ok: false, reason: 'service_not_found', detail: 'No active service with that id.' };
  }
  if (String((service as any).provider_agent_id) !== providerAgent.data) {
    return {
      ok: false,
      reason: 'service_not_owned_by_provider',
      detail:
        'That service belongs to a different agent. The provider on this exchange must be the ' +
        'agent that publishes the service.',
    };
  }

  // Price: the offer, else the listing, else the service. Must be > 0 (DB CHECK).
  const usdc =
    Number((offer as any).amount_usdc ?? 0) > 0
      ? Number((offer as any).amount_usdc)
      : Number((listing as any).price_usdc ?? 0);
  const raw =
    usdc > 0
      ? Math.round(usdc * 1e6)
      : Number((service as any).base_price_usdc_raw ?? 0);
  if (!(raw > 0)) {
    return {
      ok: false,
      reason: 'invalid_amount',
      detail: 'No positive price on the offer, the listing, or the service — nothing to contract for.',
    };
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: contract, error: cErr } = await db
    .from('service_contracts')
    .insert({
      service_id: serviceId,
      buyer_agent_id: buyerAgent.data,
      provider_agent_id: providerAgent.data,
      agreed_price_usdc_raw: raw,
      payload: {
        source: 'marketplace_listing',
        listing_id: (listing as any).id,
        offer_id: (offer as any).id,
        listing_kind: kind,
      },
      status: 'pending',
      expires_at: expiresAt,
      metadata: { bridged_from_listing: true },
    })
    .select('id')
    .single();

  if (cErr || !contract) {
    return { ok: false, reason: 'write_failed', detail: cErr?.message ?? 'contract insert failed' };
  }

  // Close the loop. Best-effort: the contract is the thing that matters, and a
  // stale 'pending' offer beside a real contract is recoverable — a contract that
  // failed to exist is not.
  await db.from('marketplace_offers').update({ status: 'accepted' }).eq('id', (offer as any).id);
  await db.from('marketplace_listings').update({ status: 'matched' }).eq('id', (listing as any).id);
  await db
    .from('marketplace_offers')
    .update({ status: 'rejected' })
    .eq('listing_id', (listing as any).id)
    .eq('status', 'pending');

  return {
    ok: true,
    data: {
      offer_id: String((offer as any).id),
      contract_id: String((contract as any).id),
      buyer_agent_id: buyerAgent.data!,
      provider_agent_id: providerAgent.data!,
      agreed_price_usdc_raw: raw,
      next: `POST /api/v1/contracts/${(contract as any).id}/escrow`,
    },
  };
}
