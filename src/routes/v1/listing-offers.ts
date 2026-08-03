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

/** What this surface is, and whether it is on. Public. */
listingOffersRouter.get('/listings/offers/info', (_req: Request, res: Response) => {
  res.json({
    enabled: LISTING_BRIDGE_ENABLED,
    how: [
      'POST /api/v1/marketplace/listings/:id/offers { amount_usdc?, message?, service_id? }',
      'GET  /api/v1/marketplace/listings/:id/offers   (poster or offerer only)',
      'POST /api/v1/marketplace/offers/:id/accept { service_id? }  → creates a contract',
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

export default listingOffersRouter;
