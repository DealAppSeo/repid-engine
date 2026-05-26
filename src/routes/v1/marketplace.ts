/**
 * RepID marketplace substrate — rent/sell agent listings. V2 SUBSTRATE (PHASE 2 OF MARKETPLACE).
 *
 * ⚠️⚠️ SETTLEMENT DISABLED ⚠️⚠️
 * This router is CRUD over agent_listings / rental_records ONLY. It records intent + lifecycle.
 * NO money moves, NOTHING settles on-chain. Creating a rental writes a rental_record and returns
 * a settlement-disabled note — it does NOT transfer USDC, escrow, or touch any on-chain contract.
 * The MARKETPLACE_SETTLEMENT_ENABLED gate below is hard-wired OFF for V2; flipping the env var is a
 * no-op here (the settlement code path does not exist yet by design).
 *
 * KEY ECONOMIC RULE: RepID earned during a rental attributes to the AGENT, not the renter
 * (rental_records.rep_id_earned_during_rental). The full UI + live economics defer to TrustMarket.dev.
 *
 * Depends on tables: agent_listings, rental_records (migration 20260526130000 — NOT applied; orchestrator applies).
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';

// V2 substrate: settlement is intentionally disabled. Even if the env var is set true, this router
// never moves money or writes on-chain — the settlement path is deferred to a later phase. The flag
// exists so ops can see it is OFF and so a future phase has a single seam to wire.
export const MARKETPLACE_SETTLEMENT_ENABLED = false; // hard-off for V2 (env intentionally NOT consulted)

const LISTING_TYPES = ['rent', 'sell'] as const;
const LISTING_STATUSES = ['active', 'paused', 'sold', 'rented_out'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CreateListingBody {
  agent_id?: unknown;
  owner_sbt_id?: unknown;
  listing_type?: unknown;
  price_usdc?: unknown;
  rep_id_at_listing?: unknown;
  rental_duration_hours?: unknown;
}

/** Pure validation for POST /listings (unit-testable, no IO). */
export function validateCreateListing(
  body: CreateListingBody,
):
  | {
      ok: true;
      agent_id: string;
      owner_sbt_id: string;
      listing_type: 'rent' | 'sell';
      price_usdc: number;
      rep_id_at_listing: number;
      rental_duration_hours: number | null;
    }
  | { ok: false; error: string } {
  const agent_id = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
  const owner_sbt_id = typeof body.owner_sbt_id === 'string' ? body.owner_sbt_id.trim() : '';
  const listing_type = typeof body.listing_type === 'string' ? body.listing_type.trim() : '';
  const price_usdc = typeof body.price_usdc === 'number' ? body.price_usdc : Number(body.price_usdc);
  const rep_id_at_listing =
    typeof body.rep_id_at_listing === 'number' ? body.rep_id_at_listing : Number(body.rep_id_at_listing);

  if (!agent_id || !UUID_RE.test(agent_id)) return { ok: false, error: 'valid agent_id (uuid) required' };
  if (!owner_sbt_id) return { ok: false, error: 'owner_sbt_id required' };
  if (!(LISTING_TYPES as readonly string[]).includes(listing_type)) {
    return { ok: false, error: "listing_type must be 'rent' or 'sell'" };
  }
  if (!Number.isFinite(price_usdc) || price_usdc < 0) return { ok: false, error: 'price_usdc must be a non-negative number' };
  if (!Number.isInteger(rep_id_at_listing) || rep_id_at_listing < 0) {
    return { ok: false, error: 'rep_id_at_listing must be a non-negative integer' };
  }

  let rental_duration_hours: number | null = null;
  if (body.rental_duration_hours !== undefined && body.rental_duration_hours !== null) {
    const d = typeof body.rental_duration_hours === 'number' ? body.rental_duration_hours : Number(body.rental_duration_hours);
    if (!Number.isInteger(d) || d <= 0) return { ok: false, error: 'rental_duration_hours must be a positive integer' };
    rental_duration_hours = d;
  }

  return {
    ok: true,
    agent_id,
    owner_sbt_id,
    listing_type: listing_type as 'rent' | 'sell',
    price_usdc,
    rep_id_at_listing,
    rental_duration_hours,
  };
}

const router = Router();

/** POST /listings — create a listing. */
router.post('/listings', async (req: Request, res: Response) => {
  const v = validateCreateListing(req.body ?? {});
  if (!v.ok) return res.status(400).json({ error: v.error });

  const { data, error } = await db
    .from('agent_listings')
    .insert({
      agent_id: v.agent_id,
      owner_sbt_id: v.owner_sbt_id,
      listing_type: v.listing_type,
      price_usdc: v.price_usdc,
      rep_id_at_listing: v.rep_id_at_listing,
      rental_duration_hours: v.rental_duration_hours,
      status: 'active',
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[marketplace] listing insert failed:', error?.message);
    return res.status(500).json({ error: 'listing_create_failed' });
  }

  return res.status(201).json({ listing_id: data.id, status: 'active' });
});

/** GET /listings — list active listings. */
router.get('/listings', async (_req: Request, res: Response) => {
  const { data, error } = await db
    .from('agent_listings')
    .select('*')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[marketplace] listings query failed:', error.message);
    return res.status(500).json({ error: 'listings_query_failed' });
  }
  return res.status(200).json({ listings: data ?? [] });
});

/** PATCH /listings/:id — update status (active|paused|sold|rented_out). */
router.patch('/listings/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'valid listing id required' });

  const status = typeof req.body?.status === 'string' ? req.body.status.trim() : '';
  if (!(LISTING_STATUSES as readonly string[]).includes(status)) {
    return res.status(400).json({ error: "status must be one of 'active','paused','sold','rented_out'" });
  }

  const { data, error } = await db
    .from('agent_listings')
    .update({ status })
    .eq('id', id)
    .select('id, status')
    .maybeSingle();

  if (error) {
    console.error('[marketplace] listing patch failed:', error.message);
    return res.status(500).json({ error: 'listing_update_failed' });
  }
  if (!data) return res.status(404).json({ error: 'listing not found' });

  return res.status(200).json({ listing_id: data.id, status: data.status });
});

/**
 * POST /rentals — create a rental_record.
 * ⚠️ EXPLICITLY NO SETTLEMENT: no money moves, nothing on-chain. The record captures intent +
 * window only. RepID earned during the rental attributes to the AGENT, not the renter.
 */
router.post('/rentals', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    listing_id?: unknown;
    renter_sbt_id?: unknown;
    target_squad_id?: unknown;
    ends_at?: unknown;
  };
  const listingId = Number(body.listing_id);
  if (!Number.isInteger(listingId) || listingId <= 0) return res.status(400).json({ error: 'valid listing_id required' });
  const renter_sbt_id = typeof body.renter_sbt_id === 'string' ? body.renter_sbt_id.trim() : '';
  if (!renter_sbt_id) return res.status(400).json({ error: 'renter_sbt_id required' });
  const target_squad_id =
    typeof body.target_squad_id === 'string' && body.target_squad_id.trim() ? body.target_squad_id.trim() : null;
  const ends_at = typeof body.ends_at === 'string' && body.ends_at.trim() ? body.ends_at.trim() : null;

  const { data, error } = await db
    .from('rental_records')
    .insert({
      listing_id: listingId,
      renter_sbt_id,
      target_squad_id,
      ends_at,
      rep_id_earned_during_rental: 0,
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error('[marketplace] rental insert failed:', error?.message);
    return res.status(500).json({ error: 'rental_create_failed' });
  }

  return res.status(200).json({
    rental_id: data.id,
    settlement: 'disabled',
    settlement_enabled: MARKETPLACE_SETTLEMENT_ENABLED,
    note: 'Rental record created. SETTLEMENT IS DISABLED (V2 substrate) — no money moved, nothing on-chain. RepID earned during rental attributes to the AGENT, not the renter. Full settlement defers to TrustMarket.dev.',
  });
});

/** GET /rentals — list rental records. */
router.get('/rentals', async (_req: Request, res: Response) => {
  const { data, error } = await db
    .from('rental_records')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[marketplace] rentals query failed:', error.message);
    return res.status(500).json({ error: 'rentals_query_failed' });
  }
  return res.status(200).json({ rentals: data ?? [] });
});

export default router;
