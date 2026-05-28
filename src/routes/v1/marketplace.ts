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

// ----------------------------------------------------------------------------
// Recent-transactions surface — public read-only feed of completed
// service_contracts (fulfilled / satisfied / settled / resolved). Joins
// agent_services + service_categories + repid_agents + x402_settlements +
// repid_score_events so the response is one self-contained row per contract,
// suitable as the data source for a future TrustMarket page.
//
// Public-readable by design (no auth, no wallet addresses, no payloads — see
// auth bypass for GET /api/v1/marketplace/recent-transactions in
// middleware/auth.ts). RLS-safe because the response is hand-shaped here.
//
// Roadmap categories (v1_active=false in service_categories) are returned in
// `coming_soon` so the UI can render them honestly as "coming soon" rather
// than hiding the catalog. There is NO advertised price for them — only the
// display_name + description.
// ----------------------------------------------------------------------------

const RECENT_TX_STATUSES = ['fulfilled', 'satisfied', 'settled', 'resolved'] as const;
const RECENT_TX_LIMIT_DEFAULT = 10;
const RECENT_TX_LIMIT_MAX = 50;

type SettlementType = 'sim' | 'real' | 'none';

interface MarketplaceTransaction {
  contract_id: string;
  service_type: string | null;
  service_display_name: string | null;
  price_usdc: string;
  buyer_agent: string | null;
  provider_agent: string | null;
  status: string;
  fulfilled_at: string | null;
  satisfied_at: string | null;
  settled_at: string | null;
  buyer_satisfaction_score: number | null;
  settlement_type: SettlementType;
  settlement_tx_hash: string | null;
  provider_repid_delta: number;
  buyer_repid_delta: number;
  is_simulated: boolean;
}

function priceFromRaw(raw: number | string | null | undefined): string {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n as number) || (n as number) < 0) return '0.000000';
  return ((n as number) / 1_000_000).toFixed(6);
}

router.get('/recent-transactions', async (req: Request, res: Response) => {
  const limitRaw = Number(req.query.limit);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, RECENT_TX_LIMIT_MAX)
    : RECENT_TX_LIMIT_DEFAULT;

  try {
    const { data: contracts, error: cErr } = await db
      .from('service_contracts')
      .select(
        'id, service_id, buyer_agent_id, provider_agent_id, agreed_price_usdc_raw, ' +
        'status, fulfilled_at, satisfied_at, settled_at, buyer_satisfaction_score, ' +
        'x402_payment_id, metadata'
      )
      .in('status', RECENT_TX_STATUSES as unknown as string[])
      .order('fulfilled_at', { ascending: false, nullsFirst: false })
      .limit(limit);

    if (cErr) {
      console.error('[marketplace.recent-transactions] contracts query failed:', cErr.message);
      return res.status(500).json({ error: 'recent_transactions_query_failed' });
    }

    const rows = (contracts ?? []) as any[];
    if (rows.length === 0) {
      const comingSoon = await readComingSoon();
      return res.status(200).json({
        transactions: [],
        coming_soon: comingSoon,
        meta: {
          now: new Date().toISOString(),
          live_handler_types: [
            'verification', 'cross_validation', 'anfis_routing',
            'reputation_audit', 'decentralized_storage',
          ],
        },
      });
    }

    const serviceIds = Array.from(new Set(rows.map((r) => r.service_id).filter(Boolean))) as string[];
    const agentIds = Array.from(new Set(
      rows.flatMap((r) => [r.buyer_agent_id, r.provider_agent_id]).filter(Boolean),
    )) as string[];
    const settlementIds = Array.from(new Set(
      rows.map((r) => r.x402_payment_id).filter(Boolean),
    )) as string[];
    const contractIdsForEvents = rows.map((r) => r.id);

    const [servicesRes, agentsRes, settlementsRes, eventsRes] = await Promise.all([
      serviceIds.length > 0
        ? db.from('agent_services').select('id, service_type').in('id', serviceIds)
        : Promise.resolve({ data: [], error: null } as any),
      agentIds.length > 0
        ? db.from('repid_agents').select('id, agent_name').in('id', agentIds)
        : Promise.resolve({ data: [], error: null } as any),
      settlementIds.length > 0
        ? db
          .from('x402_settlements')
          .select('id, is_simulated, status, tx_hash')
          .in('id', settlementIds)
        : Promise.resolve({ data: [], error: null } as any),
      contractIdsForEvents.length > 0
        ? db
          .from('repid_score_events')
          .select('agent_id, event_type, delta, metadata')
          .in('event_type', ['SERVICE_FULFILLED', 'SERVICE_SATISFIED'])
          .in('metadata->>contract_id', contractIdsForEvents)
        : Promise.resolve({ data: [], error: null } as any),
    ]);

    const serviceById = new Map<string, { service_type: string | null }>();
    for (const s of (servicesRes.data ?? []) as any[]) {
      serviceById.set(s.id, { service_type: s.service_type ?? null });
    }

    const agentNameById = new Map<string, string>();
    for (const a of (agentsRes.data ?? []) as any[]) {
      if (a.id && typeof a.agent_name === 'string') agentNameById.set(a.id, a.agent_name);
    }

    const settlementById = new Map<string, { is_simulated: boolean; tx_hash: string | null }>();
    for (const s of (settlementsRes.data ?? []) as any[]) {
      settlementById.set(s.id, {
        is_simulated: Boolean(s.is_simulated),
        tx_hash: typeof s.tx_hash === 'string' && s.tx_hash.length > 0 ? s.tx_hash : null,
      });
    }

    // deltas: sum SERVICE_FULFILLED + SERVICE_SATISFIED for each (contract_id, agent_id).
    const deltaByContractAgent = new Map<string, number>(); // key = `${contract_id}|${agent_id}`
    for (const ev of (eventsRes.data ?? []) as any[]) {
      const cid = ev?.metadata?.contract_id;
      if (typeof cid !== 'string' || !ev.agent_id) continue;
      const k = `${cid}|${ev.agent_id}`;
      deltaByContractAgent.set(k, (deltaByContractAgent.get(k) ?? 0) + Number(ev.delta ?? 0));
    }

    const liveTypes = new Set([
      'verification', 'cross_validation', 'anfis_routing',
      'reputation_audit', 'decentralized_storage',
    ]);
    const serviceDisplayNameByType: Record<string, string> = {
      verification: 'Verification-as-a-Service',
      cross_validation: 'Cross-Validation',
      anfis_routing: 'ANFIS Routing Advisory',
      reputation_audit: 'Reputation Audit',
      decentralized_storage: 'Artifact Storage',
    };

    const transactions: MarketplaceTransaction[] = rows.map((r) => {
      const svc = serviceById.get(r.service_id);
      const settlement = r.x402_payment_id ? settlementById.get(r.x402_payment_id) : undefined;

      let settlementType: SettlementType;
      if (!settlement) {
        settlementType = 'none';
      } else {
        settlementType = settlement.is_simulated ? 'sim' : 'real';
      }

      const providerDelta = deltaByContractAgent.get(`${r.id}|${r.provider_agent_id}`) ?? 0;
      const buyerDelta = deltaByContractAgent.get(`${r.id}|${r.buyer_agent_id}`) ?? 0;

      // metadata.is_simulated is the canonical demo/sim marker on service_contracts;
      // truthy via the F-series normalized check.
      const isSimMetadata = (() => {
        const v = r?.metadata?.is_simulated;
        if (v === true || v === 1) return true;
        if (typeof v === 'string') return ['true', '1', 'yes'].includes(v.trim().toLowerCase());
        return false;
      })();
      const isSimulated = isSimMetadata || settlementType === 'sim';

      const type = svc?.service_type ?? null;
      const display = type && liveTypes.has(type)
        ? serviceDisplayNameByType[type] ?? type
        : type;

      return {
        contract_id: r.id,
        service_type: type,
        service_display_name: display,
        price_usdc: priceFromRaw(r.agreed_price_usdc_raw),
        buyer_agent: agentNameById.get(r.buyer_agent_id) ?? null,
        provider_agent: agentNameById.get(r.provider_agent_id) ?? null,
        status: r.status,
        fulfilled_at: r.fulfilled_at ?? null,
        satisfied_at: r.satisfied_at ?? null,
        settled_at: r.settled_at ?? null,
        buyer_satisfaction_score: r.buyer_satisfaction_score ?? null,
        settlement_type: settlementType,
        settlement_tx_hash: settlement?.tx_hash ?? null,
        provider_repid_delta: providerDelta,
        buyer_repid_delta: buyerDelta,
        is_simulated: isSimulated,
      };
    });

    const comingSoon = await readComingSoon();

    return res.status(200).json({
      transactions,
      coming_soon: comingSoon,
      meta: {
        now: new Date().toISOString(),
        live_handler_types: Array.from(liveTypes),
      },
    });
  } catch (e: any) {
    console.error('[marketplace.recent-transactions] unhandled error:', e?.message ?? String(e));
    return res.status(500).json({ error: 'recent_transactions_unhandled' });
  }
});

async function readComingSoon(): Promise<Array<{ service_type: string; display_name: string; description: string | null }>> {
  const { data, error } = await db
    .from('service_categories')
    .select('category_name, display_name, description')
    .eq('v1_active', false)
    .order('category_name', { ascending: true });

  if (error) {
    console.error('[marketplace.recent-transactions] coming_soon query failed:', error.message);
    return [];
  }

  return ((data ?? []) as any[]).map((c) => ({
    service_type: c.category_name,
    display_name: typeof c.display_name === 'string' ? c.display_name : c.category_name,
    description: typeof c.description === 'string' ? c.description : null,
  }));
}

export default router;
