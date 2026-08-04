/**
 * Offers on marketplace listings — the "buy" button's destination.
 *
 * Mounted alongside the P0 list/browse router (routes/marketplace.ts), which is
 * documented as list/browse ONLY. Identity comes from that router's
 * resolvePosterIdentity so a human login token and an agent API key are handled
 * exactly the same way here as when posting a listing — one identity resolver, not
 * two that drift.
 */

import { Router, Request, Response } from 'express';
import { resolvePosterIdentity } from '../marketplace';
import {
  createOffer,
  acceptOffer,
  serviceIdFromOffer,
  LISTING_BRIDGE_ENABLED,
  type Party,
} from '../../services/listing-bridge';
import { isHandledServiceType } from '../../services/handled-service-types';
import {
  describeNextStep,
  offerRoles,
  viewerRole,
  AUTHORIZATION_NOTE,
} from './exchange-next-step';
import { db } from '../../db';

export const listingOffersRouter = Router();

function statusFor(reason?: string): number {
  switch (reason) {
    case 'disabled':
      return 503;
    case 'listing_not_found':
    case 'offer_not_found':
    case 'service_not_found':
      return 404;
    case 'not_the_poster':
    case 'service_not_owned_by_provider':
      return 403;
    case 'listing_not_open':
    case 'offer_not_pending':
      return 409;
    case 'write_failed':
      return 500;
    default:
      return 400;
  }
}

/**
 * Every agent id a caller acts as.
 *
 * An agent acts as itself. A human acts as every agent they own and have not
 * revoked — a human is the GOVERNOR of transacting agents, never a contract party
 * itself, so "is this person allowed to see this exchange" is a question about
 * their bound agents. Returns [] rather than throwing when the binding table is
 * unreadable: an empty set fails the party check closed, which is the right
 * direction for a read gate.
 */
async function callerAgentIds(identity: { poster_type: 'agent' | 'human'; poster_id: string }): Promise<string[]> {
  if (identity.poster_type === 'agent') return [identity.poster_id];
  try {
    const { data } = await db
      .from('human_agent_bindings')
      .select('agent_id')
      .eq('builder_id', identity.poster_id)
      .is('revoked_at', null);
    return ((data ?? []) as Array<{ agent_id: string }>).map((r) => String(r.agent_id)).filter(Boolean);
  } catch {
    return [];
  }
}

/** What this surface is, and whether it is on. Public. */
listingOffersRouter.get('/listings/offers/info', (_req: Request, res: Response) => {
  res.json({
    enabled: LISTING_BRIDGE_ENABLED,
    how: [
      'POST /api/v1/marketplace/listings/:id/offers { amount_usdc?, message?, service_id? }',
      'GET  /api/v1/marketplace/listings/:id/offers   (poster or offerer only)',
      'POST /api/v1/marketplace/offers/:id/accept { service_id? }  → creates a contract',
      'GET  /api/v1/marketplace/offers/:id          (poster or offerer) → the contract it became',
      'GET  /api/v1/marketplace/exchanges/:contractId (party only) → stage, whose turn, exact next call',
      'then the normal path: POST /api/v1/contracts/:contractId/escrow',
    ],
    notes: [
      'A contract must reference a service the provider already publishes. Services are never ' +
        'auto-created from a listing — that is the provide-side eligibility proof.',
      "A listing's kind decides who pays: 'have' means the poster provides, 'want' means the poster buys.",
      'Contract parties are agents. A human party transacts through an agent they own.',
    ],
  });
});

/** Make an offer. */
listingOffersRouter.post('/listings/:id/offers', async (req: Request, res: Response) => {
  const identity = await resolvePosterIdentity(req);
  if (!identity) {
    return res.status(401).json({
      error: 'auth_required',
      message: 'Sign in (human login token) or present an agent API key to make an offer.',
    });
  }
  const offerer: Party = { type: identity.poster_type, id: identity.poster_id };
  const r = await createOffer({
    listingId: String(req.params.id),
    offerer,
    amountUsdc: req.body?.amount_usdc != null ? Number(req.body.amount_usdc) : null,
    message: typeof req.body?.message === 'string' ? req.body.message : null,
    serviceId: typeof req.body?.service_id === 'string' ? req.body.service_id : null,
  });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason, message: r.detail });
  return res.status(201).json({ offer: r.data });
});

/**
 * Read offers on a listing. Poster sees all; an offerer sees only their own.
 * Nobody else sees any — competing offer amounts are the competitive information
 * on this surface, the same way bid prices are on the RFQ surface.
 */
listingOffersRouter.get('/listings/:id/offers', async (req: Request, res: Response) => {
  const identity = await resolvePosterIdentity(req);
  if (!identity) {
    return res.status(401).json({ error: 'auth_required', message: 'Credential required.' });
  }

  const { data: listing } = await db
    .from('marketplace_listings')
    .select('id, poster_type, poster_id, kind, status')
    .eq('id', String(req.params.id))
    .maybeSingle();
  if (!listing) return res.status(404).json({ error: 'listing_not_found' });

  const isPoster =
    (listing as any).poster_type === identity.poster_type &&
    String((listing as any).poster_id) === identity.poster_id;

  const { data: rows } = await db
    .from('marketplace_offers')
    .select('id, listing_id, offerer_id, offerer_type, amount_usdc, message, status, created_at')
    .eq('listing_id', String(req.params.id))
    .order('created_at', { ascending: false });

  const all = (rows ?? []) as Array<Record<string, any>>;
  const visible = isPoster
    ? all
    : all.filter(
        (o) => o.offerer_type === identity.poster_type && String(o.offerer_id) === identity.poster_id,
      );

  if (!isPoster && visible.length === 0) {
    return res.status(403).json({
      error: 'not_a_participant',
      message: 'Only the poster or someone who has made an offer may read offers on this listing.',
    });
  }

  return res.json({
    listing_id: String((listing as any).id),
    kind: (listing as any).kind,
    viewer: isPoster ? 'poster' : 'offerer',
    count: visible.length,
    offers: visible.map((o) => ({
      id: o.id,
      offerer_type: o.offerer_type,
      offerer_id: o.offerer_id,
      amount_usdc: o.amount_usdc,
      status: o.status,
      created_at: o.created_at,
      service_id: serviceIdFromOffer(o.message ?? null),
    })),
  });
});

/** The poster accepts. A contract exists after this. */
listingOffersRouter.post('/offers/:id/accept', async (req: Request, res: Response) => {
  const identity = await resolvePosterIdentity(req);
  if (!identity) {
    return res.status(401).json({ error: 'auth_required', message: 'Credential required.' });
  }
  const r = await acceptOffer({
    offerId: String(req.params.id),
    caller: { type: identity.poster_type, id: identity.poster_id },
    serviceId: typeof req.body?.service_id === 'string' ? req.body.service_id : null,
  });
  if (!r.ok) return res.status(statusFor(r.reason)).json({ error: r.reason, message: r.detail });
  return res.status(201).json({
    ...r.data,
    note: 'No money has moved. Escrow takes an authorization; payment releases only after the deliverable is verified.',
  });
});

/**
 * GET /offers/:id — the OFFERER's half of the accept.
 *
 * THE MISSING LINK. `POST /offers/:id/accept` returns the new contract_id to the
 * POSTER. On a 'have' listing the poster is the PROVIDER and the offerer is the
 * BUYER — so the id of the contract lands with the party that has nothing to do
 * next, while the buyer, who must present the payment authorization at escrow, is
 * told nothing at all. There is no contract_id column on marketplace_offers
 * (verified against information_schema, not the stale generated types), accept
 * writes only the forward pointer into service_contracts.payload.offer_id, and
 * GET /listings/:id/offers returns no contract. The RFQ path has its reverse
 * traversal at GET /negotiation/awards/by-contract/:contractId; the listing path
 * had none in either direction, so an accepted offer was a dead end for the one
 * party who has to act on it.
 *
 * Read-only. Visible to the listing's poster and to the offerer, nobody else —
 * an offer amount is competitive information exactly as a sealed bid is.
 */
listingOffersRouter.get('/offers/:id', async (req: Request, res: Response) => {
  const identity = await resolvePosterIdentity(req);
  if (!identity) {
    return res.status(401).json({ error: 'auth_required', message: 'Credential required.' });
  }

  const { data: offer } = await db
    .from('marketplace_offers')
    .select('id, listing_id, offerer_id, offerer_type, amount_usdc, message, status, created_at')
    .eq('id', String(req.params.id))
    .maybeSingle();
  if (!offer) return res.status(404).json({ error: 'offer_not_found' });

  const { data: listing } = await db
    .from('marketplace_listings')
    .select('id, poster_type, poster_id, kind, mode, title, status, price_usdc')
    .eq('id', (offer as any).listing_id)
    .maybeSingle();
  if (!listing) return res.status(404).json({ error: 'listing_not_found' });

  const isPoster =
    (listing as any).poster_type === identity.poster_type &&
    String((listing as any).poster_id) === identity.poster_id;
  const isOfferer =
    (offer as any).offerer_type === identity.poster_type &&
    String((offer as any).offerer_id) === identity.poster_id;

  if (!isPoster && !isOfferer) {
    return res.status(403).json({
      error: 'not_a_participant',
      message: 'Only the poster of the listing or the agent that made this offer may read it.',
    });
  }

  const kind = String((listing as any).kind);
  const roles = offerRoles(kind);
  const viewerSide = isPoster ? 'poster' : 'offerer';

  // The reverse link. accept() stamps payload.offer_id on the contract it creates,
  // so that is the only join that exists — there is no column to index on the
  // offer side and inventing one is DDL this surface has no business doing.
  let contract: Record<string, any> | null = null;
  if ((offer as any).status === 'accepted') {
    const { data } = await db
      .from('service_contracts')
      .select('id, status, buyer_agent_id, provider_agent_id, agreed_price_usdc_raw, service_id, created_at')
      .eq('payload->>offer_id', String((offer as any).id))
      .maybeSingle();
    contract = (data as Record<string, any> | null) ?? null;
  }

  return res.json({
    offer: {
      id: (offer as any).id,
      listing_id: (offer as any).listing_id,
      offerer_type: (offer as any).offerer_type,
      offerer_id: (offer as any).offerer_id,
      amount_usdc: (offer as any).amount_usdc,
      status: (offer as any).status,
      created_at: (offer as any).created_at,
      service_id: serviceIdFromOffer((offer as any).message ?? null),
    },
    listing: {
      id: (listing as any).id,
      kind,
      mode: (listing as any).mode,
      title: (listing as any).title,
      status: (listing as any).status,
    },
    viewer: viewerSide,
    /** Which side of the exchange each party is on. 'have' and 'want' invert this. */
    roles: roles ? { buyer: roles.buyer, provider: roles.provider } : null,
    your_side: roles ? (roles.buyer === viewerSide ? 'buyer' : 'provider') : null,
    contract: contract
      ? {
          id: contract.id,
          status: contract.status,
          agreed_price_usdc_raw: Number(contract.agreed_price_usdc_raw),
          buyer_agent_id: contract.buyer_agent_id,
          provider_agent_id: contract.provider_agent_id,
          state_url: `/api/v1/marketplace/exchanges/${contract.id}`,
        }
      : null,
    note:
      (offer as any).status === 'accepted' && !contract
        ? 'This offer is accepted but no contract references it. That is an orphan and worth reporting — the ' +
          'accept is meant to be all-or-nothing.'
        : AUTHORIZATION_NOTE,
  });
});

/**
 * GET /exchanges/:contractId — whose turn is it, and what exactly do they call?
 *
 * THE SECOND HALF OF THE GAP. An accepted offer or an awarded bid leaves a
 * contract at 'pending', and RepID only moves three calls later at
 * POST /contracts/:id/satisfy. Nothing walked that chain and nothing told a party
 * they were the one holding it up, so exchanges died mid-path: at the time of
 * writing 148 of 184 service_contracts sat at 'fulfilled' — delivered, unpaid, no
 * settle-side RepID — the oldest from 2026-05-18 and the newest from the previous
 * day. escrowed→fulfilled has a drain (the cascade settlement worker);
 * fulfilled→settled has none, because only the buyer can release it.
 *
 * This route does not settle anything and cannot. It reports the stage, names the
 * party whose call is next, gives the exact request, and lists the refusals that
 * call can hit — which is what a buy flow needs and what the 148 never had.
 * Read-only, party-scoped, and origin-agnostic: it answers for contracts from the
 * listing bridge and from the RFQ award path alike.
 */
listingOffersRouter.get('/exchanges/:contractId', async (req: Request, res: Response) => {
  const identity = await resolvePosterIdentity(req);
  if (!identity) {
    return res.status(401).json({ error: 'auth_required', message: 'Credential required.' });
  }

  const { data: contract } = await db
    .from('service_contracts')
    .select(
      'id, status, service_id, buyer_agent_id, provider_agent_id, agreed_price_usdc_raw, ' +
        'x402_payment_id, result, payload, metadata, created_at, escrowed_at, fulfilled_at, settled_at',
    )
    .eq('id', String(req.params.contractId))
    .maybeSingle();
  if (!contract) return res.status(404).json({ error: 'contract_not_found' });

  const mine = await callerAgentIds(identity);
  const role = viewerRole(contract as any, mine);
  if (!role) {
    return res.status(403).json({
      error: 'not_a_party',
      message:
        identity.poster_type === 'human'
          ? 'None of the agents bound to this account is a party to this exchange.'
          : 'Only the buyer or the provider named on this contract may read its state.',
    });
  }

  const { data: service } = await db
    .from('agent_services')
    .select('id, service_type, service_name')
    .eq('id', (contract as any).service_id)
    .maybeSingle();
  const serviceType = (service as any)?.service_type ?? null;

  const next = describeNextStep({
    status: String((contract as any).status),
    serviceType,
    handlerDelivered: isHandledServiceType(serviceType),
    hasPaymentAuthorization: Boolean((contract as any).x402_payment_id),
    settledAt: (contract as any).settled_at ?? null,
    resultVerdict:
      typeof ((contract as any).result as any)?.verdict === 'string'
        ? String(((contract as any).result as any).verdict).toUpperCase()
        : null,
    settleOnDelivery: process.env.X402_SETTLE_ON_DELIVERY === 'true',
    enforcementEnabled: process.env.X402_ENFORCEMENT_ENABLED === 'true',
    now: Date.now(),
  });

  // The concrete path, with the id substituted — a caller should not have to
  // string-replace a placeholder to make the next call.
  const withId = <T extends { path: string } | null>(a: T): T =>
    a === null ? a : ({ ...a, path: a.path.replace('/:id/', `/${(contract as any).id}/`) } as T);

  const origin =
    ((contract as any).payload as any)?.source === 'marketplace_listing'
      ? {
          kind: 'marketplace_listing' as const,
          listing_id: ((contract as any).payload as any)?.listing_id ?? null,
          offer_id: ((contract as any).payload as any)?.offer_id ?? null,
        }
      : ((contract as any).metadata as any)?.negotiation
        ? { kind: 'a2a_award' as const, rfq_id: ((contract as any).metadata as any).negotiation.rfq_id ?? null }
        : { kind: 'direct' as const };

  return res.json({
    contract_id: (contract as any).id,
    status: (contract as any).status,
    origin,
    your_role: role,
    your_turn: next.turn === role,
    counterparty_role: role === 'buyer' ? 'provider' : 'buyer',
    service: { id: (service as any)?.id ?? null, service_type: serviceType, service_name: (service as any)?.service_name ?? null },
    price_usdc_raw: Number((contract as any).agreed_price_usdc_raw),
    payment_state: (contract as any).x402_payment_id
      ? 'AUTHORIZATION_RECORDED'
      : 'NO_AUTHORIZATION_RECORDED',
    timeline: {
      created_at: (contract as any).created_at ?? null,
      escrowed_at: (contract as any).escrowed_at ?? null,
      fulfilled_at: (contract as any).fulfilled_at ?? null,
      settled_at: (contract as any).settled_at ?? null,
    },
    next_step: { ...next, action: withId(next.action), optional_next: withId(next.optional_next ?? null) },
    note: AUTHORIZATION_NOTE,
  });
});

export default listingOffersRouter;
