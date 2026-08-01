/**
 * negotiation.ts — A2A negotiation router (mount at /api/v1/negotiation).
 *
 * RFQ → sealed bids → bounded counter-rounds → exactly one award → contract.
 *
 * THE PIVOT: `POST /rfqs/:id/accept` has NO price field in its body. The price
 * is read server-side out of the referenced `a2a_bid_rounds` row after its
 * `offer_hash` is recomputed and matched. That is the whole point — see the
 * module header of src/services/a2a-negotiation.ts for what this does and does
 * NOT guarantee (in particular: it does not prevent collusion, and post-award
 * delivery validation is still counterparty self-validation).
 *
 * IDENTITY: every write endpoint requires an agent-bound (DB-issued) API key
 * and compares the claimed agent id DIRECTLY against the key's binding. It does
 * NOT rely on authMiddleware's f2-authz check, which resolves only the FIRST
 * truthy value of an OR chain and therefore lets a body carrying both
 * `agent_id` (own) and `provider_agent_id` (a victim's) through.
 * Operator (env `REPID_API_KEYS`) keys carry no binding at all and are rejected
 * 403 on every write.
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { todayPT } from '../../lib/time';
import {
  AGENT_PANEL_COLUMNS,
  AWARD_REASON_CODES,
  COLLUSION_CLAIM_NOTE,
  POST_AWARD_VALIDATION_NOTE,
  REPID_DISCLOSURE,
  type AgentIdentity,
  type AttestationLevel,
  type BidRow,
  type BidWithRounds,
  type IdentityKeyField,
  type RfqRow,
  type RfqSummaryForPanel,
  type RoundRow,
  acceptAndAward,
  applySnipeExtension,
  boundAgentId,
  buildDecisionSnapshot,
  buildOnChainPanel,
  checkValueCaps,
  computeBuyerPanel,
  computeConcentration,
  computeOfferHash,
  currentOffer,
  filterVisibleBids,
  isPastBidClose,
  isRelated,
  isRfqExpired,
  loadAgent,
  loadAgents,
  loadAwardEdges,
  loadBidsWithRounds,
  loadProviderContractCounts,
  loadRfq,
  lowestValidPrice,
  negotiationConfig,
  offerCap,
  operatorFingerprint,
  roundCapExceeded,
  roundExpiry,
  sameAgent,
  settledTodayRaw,
  sharedIdentityKeys,
  sortBidsDeterministic,
  touchRfqExpiry,
  validCompetingBids,
  validateAwardRationale,
  validateEta,
  validatePrice,
  validateWindows,
  verifyOfferSignature,
  verifyStoredOfferHash,
  viewerRole,
} from '../../services/a2a-negotiation';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Shared response furniture — the honest labels ride on every payload
// ─────────────────────────────────────────────────────────────────────────────

const DISCLOSURES = {
  repid_reward_price_coupled: false as const,
  repid_role: REPID_DISCLOSURE,
  post_award_validation: POST_AWARD_VALIDATION_NOTE,
  collusion_claim: COLLUSION_CLAIM_NOTE,
  bond_enforcement: 'not_implemented' as const,
  bond_note:
    'bid_bond is recorded as 0 and enforced nowhere. Forfeiture needs a new eventType in ' +
    'src/engine/repid-update.ts, which this module does not own. A bond that reads real but is inert ' +
    'would be worse than no bond.',
};

function fail(res: Response, status: number, error: string, message: string, extra?: Record<string, unknown>) {
  return res.status(status).json({ error, message, ...(extra ?? {}) });
}

/**
 * Every write endpoint starts here. Returns the bound agent id, or writes a 403
 * and returns null. Operator env keys never set `agent_id`, so the same check
 * rejects them — deliberately NOT gated on `tier`, which is spoofable config.
 */
function requireBoundAgent(req: Request, res: Response): string | null {
  const bound = boundAgentId(req as unknown as { agent_id?: unknown });
  if (!bound) {
    fail(
      res,
      403,
      'operator_key_forbidden',
      'This endpoint requires an agent-bound API key. Operator keys carry no agent binding, so they could ' +
        'impersonate any bidder — which would destroy the only thing making a bid non-repudiable.',
    );
    return null;
  }
  return bound;
}

/** Direct binding comparison. NOT delegated to the auth middleware OR-chain. */
function requireSelf(res: Response, bound: string, claimed: unknown, field: string): boolean {
  if (!sameAgent(bound, claimed)) {
    fail(res, 403, 'agent_binding_mismatch', `${field} must equal the agent your API key is bound to.`, {
      field,
      bound_agent_id: bound,
    });
    return false;
  }
  return true;
}

function pathParam(req: Request, name: string): string | null {
  const raw = (req.params as Record<string, string | undefined>)[name];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function iso(d: Date): string {
  return d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Panels
// ─────────────────────────────────────────────────────────────────────────────

async function buyerPanelFor(buyerAgentId: string, now: Date) {
  const { data } = await db
    .from('a2a_rfqs')
    .select('status, outcome, expires_at')
    .eq('buyer_agent_id', buyerAgentId)
    .limit(500);
  const rows = ((data ?? []) as unknown as RfqSummaryForPanel[]).map((r) => ({
    status: r.status,
    outcome: r.outcome,
    expires_at: r.expires_at,
    bid_count: undefined,
  }));
  const panel = computeBuyerPanel(rows, now);
  const buyer = await loadAgent(buyerAgentId);
  return {
    agent_id: buyerAgentId,
    agent_name: buyer?.agent_name ?? null,
    current_repid: buyer?.current_repid ?? null,
    tier: buyer?.tier ?? null,
    lifecycle_status: buyer?.lifecycle_status ?? null,
    ...panel,
    note:
      'award_ratio is computed from expires_at, not from the status column — an RFQ nobody ever touches again ' +
      'still counts as a lapse, so abandoning a harvest is not cheaper than cancelling it.',
  };
}

async function providerPanelFor(
  provider: AgentIdentity | null,
  providerAgentId: string,
  buyer: AgentIdentity | null,
  serviceRow: { total_fulfilled?: number | null; total_satisfied?: number | null; avg_satisfaction?: number | null } | null,
  withdrawnCount: number,
) {
  const counts = await loadProviderContractCounts(providerAgentId);
  const shared = provider && buyer ? sharedIdentityKeys(provider, buyer) : ([] as IdentityKeyField[]);
  const edges = buyer ? await loadAwardEdges(buyer.id, providerAgentId) : [];
  const concentration = buyer ? computeConcentration(edges, buyer.id, providerAgentId) : null;
  return {
    agent_id: providerAgentId,
    agent_name: provider?.agent_name ?? null,
    current_repid: provider?.current_repid ?? null,
    tier: provider?.tier ?? null,
    lifecycle_status: provider?.lifecycle_status ?? null,
    onchain: provider ? buildOnChainPanel(provider) : null,
    delivery: {
      service_total_fulfilled: Number(serviceRow?.total_fulfilled ?? 0),
      service_total_satisfied: Number(serviceRow?.total_satisfied ?? 0),
      service_avg_satisfaction: serviceRow?.avg_satisfaction ?? null,
      contracts_by_status: counts.byStatus,
      contracts_disputed: counts.disputed,
      bids_withdrawn: withdrawnCount,
    },
    concentration,
    related_to_buyer: shared.length > 0,
    shared_identity_keys_with_buyer: shared,
    disclosure: REPID_DISCLOSURE,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /rfqs — buyer posts an RFQ
// ─────────────────────────────────────────────────────────────────────────────

router.post('/rfqs', async (req: Request, res: Response) => {
  try {
    const bound = requireBoundAgent(req, res);
    if (!bound) return;

    const cfg = negotiationConfig();
    const now = new Date();
    const body = req.body ?? {};
    const {
      buyer_agent_id,
      service_type,
      scope,
      min_price_usdc_raw,
      max_price_usdc_raw,
      min_provider_repid,
      award_mode,
      max_rounds,
      max_bids,
      bids_close_at,
      expires_at,
      deadline_at,
    } = body;

    if (!requireSelf(res, bound, buyer_agent_id, 'buyer_agent_id')) return;

    if (typeof service_type !== 'string' || service_type.trim().length === 0) {
      return fail(res, 400, 'service_type_required', 'service_type is required');
    }
    if (scope === undefined || scope === null || typeof scope !== 'object') {
      return fail(res, 400, 'scope_required', 'scope must be a JSON object describing the work');
    }

    const floor = cfg.minPriceUsdcRaw;
    const minPrice = min_price_usdc_raw === undefined ? floor : Number(min_price_usdc_raw);
    if (!Number.isInteger(minPrice) || minPrice < floor) {
      return fail(
        res,
        400,
        'min_price_below_floor',
        `min_price_usdc_raw must be an integer >= ${floor} raw USDC units. RepID reward is price-decoupled, so ` +
          'a sub-cent contract pays the same reputation as a real one; the floor is what stops that loop.',
      );
    }
    const maxPrice = max_price_usdc_raw === undefined || max_price_usdc_raw === null ? null : Number(max_price_usdc_raw);
    if (maxPrice !== null && (!Number.isInteger(maxPrice) || maxPrice < minPrice)) {
      return fail(res, 400, 'invalid_price_band', 'max_price_usdc_raw must be an integer >= min_price_usdc_raw');
    }

    const minRepid = min_provider_repid === undefined ? cfg.minProviderRepidFloor : Number(min_provider_repid);
    if (!Number.isInteger(minRepid) || minRepid < cfg.minProviderRepidFloor) {
      return fail(
        res,
        400,
        'min_provider_repid_below_floor',
        `min_provider_repid must be an integer >= ${cfg.minProviderRepidFloor} (ESTABLISHED). Listing a service ` +
          'costs nothing, so RepID is the only real sybil price on the provide side.',
      );
    }

    const mode: string = award_mode === undefined ? 'sealed_close' : String(award_mode);
    if (mode !== 'sealed_close' && mode !== 'immediate') {
      return fail(res, 400, 'invalid_award_mode', "award_mode must be 'sealed_close' or 'immediate'");
    }
    const rounds = max_rounds === undefined ? 3 : Number(max_rounds);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
      return fail(res, 400, 'invalid_max_rounds', 'max_rounds must be an integer between 1 and 5');
    }
    const bidCap = max_bids === undefined ? 25 : Number(max_bids);
    if (!Number.isInteger(bidCap) || bidCap < 1 || bidCap > 100) {
      return fail(res, 400, 'invalid_max_bids', 'max_bids must be an integer between 1 and 100');
    }

    if (typeof bids_close_at !== 'string' || typeof expires_at !== 'string') {
      return fail(res, 400, 'window_required', 'bids_close_at and expires_at (ISO-8601) are required');
    }
    const windows = validateWindows({
      bids_close_at,
      expires_at,
      deadline_at: typeof deadline_at === 'string' ? deadline_at : null,
      now,
      cfg,
    });
    if (!windows.ok) return fail(res, 400, windows.error, windows.message);

    const buyer = await loadAgent(bound);
    if (!buyer) return fail(res, 404, 'buyer_not_found', 'Buyer agent not found');
    if ((buyer.lifecycle_status ?? 'active') !== 'active') {
      return fail(res, 403, 'buyer_not_active', `Buyer lifecycle_status is '${buyer.lifecycle_status}'`);
    }

    // Concurrent-harvest cap. Counted by the clock so an abandoned RFQ still
    // occupies a slot until it genuinely lapses.
    const { data: openRows } = await db
      .from('a2a_rfqs')
      .select('id, expires_at, status')
      .eq('buyer_agent_id', bound)
      .in('status', ['open', 'closed'])
      .limit(200);
    const stillOpen = ((openRows ?? []) as Array<{ expires_at: string }>).filter(
      (r) => Date.parse(r.expires_at) > now.getTime(),
    ).length;
    if (stillOpen >= cfg.maxOpenRfqsPerBuyer) {
      return fail(
        res,
        429,
        'too_many_open_rfqs',
        `A buyer may hold at most ${cfg.maxOpenRfqsPerBuyer} open RFQs at once.`,
        { open_rfqs: stillOpen },
      );
    }

    const { data, error } = await db
      .from('a2a_rfqs')
      .insert({
        buyer_agent_id: bound,
        service_type: service_type.trim(),
        scope,
        min_price_usdc_raw: minPrice,
        max_price_usdc_raw: maxPrice,
        min_provider_repid: minRepid,
        award_mode: mode,
        max_rounds: rounds,
        max_bids: bidCap,
        bids_close_at,
        expires_at,
        deadline_at: typeof deadline_at === 'string' ? deadline_at : null,
        status: 'open',
      })
      .select()
      .single();

    if (error) return fail(res, 400, 'rfq_insert_failed', error.message);

    return res.status(201).json({
      rfq: data,
      rules_frozen: {
        award_mode: mode,
        max_rounds: rounds,
        offer_cap_per_thread: rounds * 2,
        min_provider_repid: minRepid,
        note: 'award_mode and max_rounds are frozen at creation and shown to every bidder before they bid.',
      },
      disclosures: DISCLOSURES,
    });
  } catch (err: unknown) {
    console.error('[negotiation] POST /rfqs failed:', err);
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /rfqs — provider-side discovery (buyer panel included BEFORE bidding)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/rfqs', async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const serviceType = typeof req.query.service_type === 'string' ? req.query.service_type : null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    let q = db.from('a2a_rfqs').select('*').in('status', ['open', 'closed']).order('bids_close_at', { ascending: true });
    if (serviceType) q = q.eq('service_type', serviceType);
    const { data, error } = await q.limit(limit);
    if (error) return fail(res, 500, 'rfq_query_failed', error.message);

    const rfqs = ((data ?? []) as unknown as RfqRow[]).filter((r) => Date.parse(r.expires_at) > now.getTime());
    const buyerIds = Array.from(new Set(rfqs.map((r) => r.buyer_agent_id)));
    const panels = new Map<string, unknown>();
    for (const id of buyerIds) {
      panels.set(id.toLowerCase(), await buyerPanelFor(id, now));
    }

    const out = [];
    for (const r of rfqs) {
      const { count } = await db
        .from('a2a_bids')
        .select('*', { count: 'exact', head: true })
        .eq('rfq_id', r.id)
        .in('status', ['open', 'countered']);
      out.push({
        id: r.id,
        service_type: r.service_type,
        scope: r.scope,
        min_price_usdc_raw: Number(r.min_price_usdc_raw),
        max_price_usdc_raw: r.max_price_usdc_raw === null ? null : Number(r.max_price_usdc_raw),
        min_provider_repid: r.min_provider_repid,
        award_mode: r.award_mode,
        max_rounds: r.max_rounds,
        max_bids: r.max_bids,
        bids_close_at: r.bids_close_at,
        close_extensions: r.close_extensions,
        expires_at: r.expires_at,
        deadline_at: r.deadline_at,
        status: r.status,
        bid_count: count ?? 0,
        sealed: !isPastBidClose(r, now),
        buyer_panel: panels.get(r.buyer_agent_id.toLowerCase()) ?? null,
      });
    }

    return res.json({ data: out, count: out.length, disclosures: DISCLOSURES });
  } catch (err: unknown) {
    console.error('[negotiation] GET /rfqs failed:', err);
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /rfqs/:id — detail (never prices pre-close)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/rfqs/:id', async (req: Request, res: Response) => {
  try {
    const rfqId = pathParam(req, 'id');
    if (!rfqId) return fail(res, 400, 'rfq_id_required', 'rfq id is required');
    const now = new Date();

    let rfq = await loadRfq(rfqId);
    if (!rfq) return fail(res, 404, 'rfq_not_found', 'RFQ not found');

    const { count } = await db.from('a2a_bids').select('*', { count: 'exact', head: true }).eq('rfq_id', rfq.id);
    rfq = await touchRfqExpiry(rfq, count ?? 0, now);

    return res.json({
      rfq: {
        ...rfq,
        min_price_usdc_raw: Number(rfq.min_price_usdc_raw),
        max_price_usdc_raw: rfq.max_price_usdc_raw === null ? null : Number(rfq.max_price_usdc_raw),
      },
      bid_count: count ?? 0,
      sealed: !isPastBidClose(rfq, now),
      offer_cap_per_thread: offerCap(rfq),
      buyer_panel: await buyerPanelFor(rfq.buyer_agent_id, now),
      disclosures: DISCLOSURES,
    });
  } catch (err: unknown) {
    console.error('[negotiation] GET /rfqs/:id failed:', err);
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /rfqs/:id/bids — provider submits round 1
// ─────────────────────────────────────────────────────────────────────────────

router.post('/rfqs/:id/bids', async (req: Request, res: Response) => {
  try {
    const bound = requireBoundAgent(req, res);
    if (!bound) return;
    const rfqId = pathParam(req, 'id');
    if (!rfqId) return fail(res, 400, 'rfq_id_required', 'rfq id is required');

    const cfg = negotiationConfig();
    const now = new Date();
    const body = req.body ?? {};
    const { provider_agent_id, service_id, price_usdc_raw, eta_seconds, terms, round_ttl_seconds, signature } = body;

    if (!requireSelf(res, bound, provider_agent_id, 'provider_agent_id')) return;
    if (typeof service_id !== 'string' || service_id.length === 0) {
      return fail(res, 400, 'service_id_required', 'service_id is required — it is the provide-side eligibility proof');
    }

    let rfq = await loadRfq(rfqId);
    if (!rfq) return fail(res, 404, 'rfq_not_found', 'RFQ not found');

    const existingBids = await loadBidsWithRounds(rfq.id);
    rfq = await touchRfqExpiry(rfq, existingBids.length, now);

    if (isRfqExpired(rfq, now)) return fail(res, 410, 'rfq_expired', 'This RFQ has expired');
    if (rfq.status !== 'open') return fail(res, 409, 'rfq_not_open', `RFQ status is '${rfq.status}'`);
    if (isPastBidClose(rfq, now)) return fail(res, 409, 'bidding_closed', 'The bidding window has closed');

    if (sameAgent(rfq.buyer_agent_id, bound)) {
      return fail(res, 400, 'self_dealing_forbidden', 'The buyer of an RFQ may not bid on it');
    }

    const priceCheck = validatePrice(price_usdc_raw, rfq, cfg);
    if (!priceCheck.ok) return fail(res, 400, priceCheck.error ?? 'invalid_price', priceCheck.message ?? 'invalid price');
    const etaCheck = validateEta(eta_seconds);
    if (!etaCheck.ok) return fail(res, 400, etaCheck.error ?? 'invalid_eta', etaCheck.message ?? 'invalid eta');

    const provider = await loadAgent(bound);
    if (!provider) return fail(res, 404, 'provider_not_found', 'Provider agent not found');
    if ((provider.lifecycle_status ?? 'active') !== 'active') {
      return fail(res, 403, 'provider_not_active', `Provider lifecycle_status is '${provider.lifecycle_status}'`);
    }
    const providerRepid = Number(provider.current_repid ?? 0);
    if (providerRepid < rfq.min_provider_repid) {
      return fail(
        res,
        403,
        'provider_repid_below_rfq_minimum',
        `This RFQ requires RepID >= ${rfq.min_provider_repid}; yours is ${providerRepid}.`,
        { min_provider_repid: rfq.min_provider_repid, current_repid: providerRepid },
      );
    }

    const { data: service } = await db
      .from('agent_services')
      .select('id, provider_agent_id, service_type, active, base_price_usdc_raw')
      .eq('id', service_id)
      .maybeSingle();
    if (!service) return fail(res, 404, 'service_not_found', 'agent_services row not found');
    if (!sameAgent(service.provider_agent_id, bound)) {
      return fail(res, 403, 'service_not_owned', 'That agent_services row belongs to a different provider');
    }
    if (!service.active) return fail(res, 400, 'service_inactive', 'That agent_services row is not active');
    if (String(service.service_type) !== rfq.service_type) {
      return fail(
        res,
        400,
        'service_type_mismatch',
        `The RFQ is for '${rfq.service_type}'; that service lists '${service.service_type}'`,
      );
    }

    if (existingBids.some((b) => sameAgent(b.bid.provider_agent_id, bound))) {
      return fail(res, 409, 'bid_thread_exists', 'You already have a negotiation thread on this RFQ');
    }
    const liveBids = existingBids.filter((b) => b.bid.status === 'open' || b.bid.status === 'countered');
    if (liveBids.length >= rfq.max_bids) {
      return fail(res, 409, 'max_bids_reached', `This RFQ is capped at ${rfq.max_bids} threads`);
    }

    // Per-operator thread cap. UNIQUE(rfq_id, provider_agent_id) caps ONE
    // identity at one thread; it does nothing about N identities under one
    // operator exhausting max_bids to lock rivals out.
    const myFingerprint = operatorFingerprint(provider);
    if (myFingerprint) {
      const others = await loadAgents(liveBids.map((b) => b.bid.provider_agent_id));
      let sameOperator = 0;
      for (const b of liveBids) {
        const a = others.get(String(b.bid.provider_agent_id).toLowerCase());
        if (a && operatorFingerprint(a) === myFingerprint) sameOperator += 1;
      }
      if (sameOperator >= cfg.maxThreadsPerOperator) {
        return fail(
          res,
          409,
          'operator_thread_cap',
          `Agents sharing your published wallet/signing/builder identity already hold ${sameOperator} threads on ` +
            `this RFQ (cap ${cfg.maxThreadsPerOperator}).`,
        );
      }
    }

    // Anti-snipe soft close — applied BEFORE the bid lands so the extension is
    // recorded even if the insert then fails.
    const ext = applySnipeExtension(rfq, now, cfg);
    if (ext) {
      const { data: extended } = await db.from('a2a_rfqs').update(ext).eq('id', rfq.id).eq('status', 'open').select().maybeSingle();
      if (extended) rfq = extended as unknown as RfqRow;
    }

    const buyer = await loadAgent(rfq.buyer_agent_id);
    const relatedToBuyer = buyer !== null && isRelated(provider, buyer);
    const relatedToBidder = await (async () => {
      const others = await loadAgents(existingBids.map((b) => b.bid.provider_agent_id));
      for (const a of others.values()) {
        if (!sameAgent(a.id, bound) && isRelated(provider, a)) return true;
      }
      return false;
    })();

    const { data: bidRow, error: bidErr } = await db
      .from('a2a_bids')
      .insert({
        rfq_id: rfq.id,
        provider_agent_id: bound,
        service_id,
        status: 'open',
        rounds_used: 0,
        provider_repid_at_bid: providerRepid,
        bond_repid: 0,
        bond_enforcement: 'not_implemented',
        related_bidder_flag: relatedToBidder,
        related_to_buyer_flag: relatedToBuyer,
      })
      .select()
      .single();

    if (bidErr) {
      if (bidErr.code === '23505') return fail(res, 409, 'bid_thread_exists', 'You already have a thread on this RFQ');
      return fail(res, 400, 'bid_insert_failed', bidErr.message);
    }

    const bid = bidRow as unknown as BidRow;
    const roundResult = await appendRound({
      rfq,
      bid,
      roundNo: 1,
      offeredBy: 'provider',
      actor: provider,
      price: Number(price_usdc_raw),
      eta: Number(eta_seconds),
      terms: terms ?? {},
      acceptsRoundId: null,
      signature: typeof signature === 'string' ? signature : null,
      ttlSec: round_ttl_seconds === undefined ? undefined : Number(round_ttl_seconds),
      now,
      cfg,
    });

    if (!roundResult.ok) {
      // Never leave a dangling empty thread — it would lock this provider out
      // of the RFQ for nothing.
      await db.from('a2a_bids').delete().eq('id', bid.id);
      return fail(res, roundResult.status, roundResult.error, roundResult.message);
    }

    return res.status(201).json({
      bid: { ...bid, status: 'open', rounds_used: 1, current_round_id: roundResult.round.id },
      round: roundResult.round,
      attestation_level: roundResult.round.attestation_level,
      attestation_note:
        roundResult.round.attestation_level === 'counterparty_signed'
          ? 'This offer is signed by an address this agent published. The commitment is counterparty-attested.'
          : 'This offer is SERVER-ATTESTED only. The engine issues the API keys and holds custodied agent wallets, ' +
            'so an unsigned offer is not evidence of an independent second party. Sign the offer to change that.',
      related_to_buyer: relatedToBuyer,
      sealed: !isPastBidClose(rfq, now),
      close_extended: ext !== null,
      disclosures: DISCLOSURES,
    });
  } catch (err: unknown) {
    console.error('[negotiation] POST /rfqs/:id/bids failed:', err);
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Round append (shared by bid / counter / respond)
// ─────────────────────────────────────────────────────────────────────────────

type AppendRoundResult =
  | { ok: true; round: RoundRow }
  | { ok: false; status: number; error: string; message: string };

async function appendRound(params: {
  rfq: RfqRow;
  bid: BidRow;
  roundNo: number;
  offeredBy: 'provider' | 'buyer';
  actor: AgentIdentity;
  price: number;
  eta: number;
  terms: unknown;
  acceptsRoundId: string | null;
  signature: string | null;
  ttlSec: number | undefined;
  now: Date;
  cfg: ReturnType<typeof negotiationConfig>;
}): Promise<AppendRoundResult> {
  const { rfq, bid, roundNo, offeredBy, actor, price, eta, terms, acceptsRoundId, signature, ttlSec, now, cfg } = params;

  const expiresAt = roundExpiry(now, ttlSec, cfg);
  const offerHash = computeOfferHash({
    bid_id: bid.id,
    round_no: roundNo,
    offered_by: offeredBy,
    actor_agent_id: actor.id,
    price_usdc_raw: price,
    eta_seconds: eta,
    terms,
    expires_at: expiresAt,
  });

  const sig = verifyOfferSignature(offerHash, signature, actor);
  if (cfg.requireSignedRounds && !sig.verified) {
    return {
      ok: false,
      status: 400,
      error: 'signature_required',
      message: `A2A_REQUIRE_SIGNED_ROUNDS is on and this offer is not counterparty-signed (${sig.reason ?? 'unknown'}). ` +
        `Sign the string "A2A-OFFER-v1:<offer_hash>" with the address published on your agent record.`,
    };
  }
  const attestation: AttestationLevel = sig.verified ? 'counterparty_signed' : 'server_attested';

  const { data, error } = await db
    .from('a2a_bid_rounds')
    .insert({
      bid_id: bid.id,
      rfq_id: rfq.id,
      round_no: roundNo,
      offered_by: offeredBy,
      actor_agent_id: actor.id,
      price_usdc_raw: price,
      eta_seconds: eta,
      terms: terms ?? {},
      accepts_round_id: acceptsRoundId,
      offer_hash: offerHash,
      actor_signature: sig.verified ? signature : null,
      actor_signing_address: sig.address,
      signature_verified: sig.verified,
      attestation_level: attestation,
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return { ok: false, status: 409, error: 'round_already_exists', message: 'That round number is already taken — retry' };
    }
    return { ok: false, status: 400, error: 'round_insert_failed', message: error.message };
  }

  const round = data as unknown as RoundRow;
  const { error: updErr } = await db
    .from('a2a_bids')
    .update({
      rounds_used: roundNo,
      current_round_id: round.id,
      status: offeredBy === 'buyer' ? 'countered' : 'open',
      updated_at: iso(now),
    })
    .eq('id', bid.id);
  if (updErr) {
    // The round is append-only and stays. The pointer is recoverable from
    // max(round_no); it is not a reason to fabricate success on the write.
    console.error('[negotiation] round appended but bid pointer update failed:', updErr.message);
  }
  return { ok: true, round };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /rfqs/:id/bids — the sealed product surface
// ─────────────────────────────────────────────────────────────────────────────

router.get('/rfqs/:id/bids', async (req: Request, res: Response) => {
  try {
    const bound = requireBoundAgent(req, res);
    if (!bound) return;
    const rfqId = pathParam(req, 'id');
    if (!rfqId) return fail(res, 400, 'rfq_id_required', 'rfq id is required');

    const cfg = negotiationConfig();
    const now = new Date();
    let rfq = await loadRfq(rfqId);
    if (!rfq) return fail(res, 404, 'rfq_not_found', 'RFQ not found');

    const all = await loadBidsWithRounds(rfq.id);
    rfq = await touchRfqExpiry(rfq, all.length, now);

    const role = viewerRole(rfq, all.map((b) => b.bid), bound);
    if (role === 'outsider') {
      return fail(res, 403, 'not_a_participant', 'Only the buyer or a bidder on this RFQ may read its bids');
    }

    const view = filterVisibleBids({ rfq, bids: all, viewerAgentId: bound, now, cfg });
    const ordered = sortBidsDeterministic(view.visible);

    const buyer = await loadAgent(rfq.buyer_agent_id);
    const agents = await loadAgents(ordered.map((b) => b.bid.provider_agent_id));

    const withdrawnCounts = new Map<string, number>();
    for (const b of all) {
      if (b.bid.status === 'withdrawn') {
        const k = String(b.bid.provider_agent_id).toLowerCase();
        withdrawnCounts.set(k, (withdrawnCounts.get(k) ?? 0) + 1);
      }
    }

    const items = [];
    for (const b of ordered) {
      const offer = currentOffer(b);
      const provider = agents.get(String(b.bid.provider_agent_id).toLowerCase()) ?? null;
      const { data: svc } = await db
        .from('agent_services')
        .select('total_fulfilled, total_satisfied, avg_satisfaction')
        .eq('id', b.bid.service_id)
        .maybeSingle();
      items.push({
        bid_id: b.bid.id,
        provider_agent_id: b.bid.provider_agent_id,
        service_id: b.bid.service_id,
        status: b.bid.status,
        rounds_used: b.bid.rounds_used,
        offer_cap_per_thread: offerCap(rfq),
        current_round: offer
          ? {
              id: offer.id,
              round_no: offer.round_no,
              offered_by: offer.offered_by,
              price_usdc_raw: Number(offer.price_usdc_raw),
              eta_seconds: Number(offer.eta_seconds),
              terms: offer.terms,
              accepts_round_id: offer.accepts_round_id,
              offer_hash: offer.offer_hash,
              offer_hash_verified: verifyStoredOfferHash(offer),
              attestation_level: offer.attestation_level,
              expires_at: offer.expires_at,
            }
          : null,
        round_history: b.rounds.map((r) => ({
          id: r.id,
          round_no: r.round_no,
          offered_by: r.offered_by,
          price_usdc_raw: Number(r.price_usdc_raw),
          eta_seconds: Number(r.eta_seconds),
          accepts_round_id: r.accepts_round_id,
          offer_hash: r.offer_hash,
          offer_hash_verified: verifyStoredOfferHash(r),
          attestation_level: r.attestation_level,
          expires_at: r.expires_at,
          created_at: r.created_at,
        })),
        bond: { bond_repid: b.bid.bond_repid, bond_enforcement: b.bid.bond_enforcement },
        related_bidder_flag: b.bid.related_bidder_flag,
        related_to_buyer_flag: b.bid.related_to_buyer_flag,
        counterparty: await providerPanelFor(
          provider,
          b.bid.provider_agent_id,
          buyer,
          svc as { total_fulfilled?: number | null; total_satisfied?: number | null; avg_satisfaction?: number | null } | null,
          withdrawnCounts.get(String(b.bid.provider_agent_id).toLowerCase()) ?? 0,
        ),
      });
    }

    return res.json({
      rfq_id: rfq.id,
      viewer_role: view.viewer_role,
      sealed: view.sealed,
      hidden_bid_count: view.hidden_count,
      total_bid_count: all.length,
      competing_bid_count: validCompetingBids(all).length,
      is_uncontested: validCompetingBids(all).length <= 1,
      ordering: 'price_asc_then_created_at_asc — deterministic. No score, no rank, no recommendation.',
      bids: items,
      buyer_panel: await buyerPanelFor(rfq.buyer_agent_id, now),
      disclosures: DISCLOSURES,
    });
  } catch (err: unknown) {
    console.error('[negotiation] GET /rfqs/:id/bids failed:', err);
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /bids/:bidId/counter — buyer counters
// ─────────────────────────────────────────────────────────────────────────────

router.post('/bids/:bidId/counter', async (req: Request, res: Response) => {
  try {
    const bound = requireBoundAgent(req, res);
    if (!bound) return;
    const bidId = pathParam(req, 'bidId');
    if (!bidId) return fail(res, 400, 'bid_id_required', 'bid id is required');

    const cfg = negotiationConfig();
    const now = new Date();
    const { price_usdc_raw, eta_seconds, terms, round_ttl_seconds, signature } = req.body ?? {};

    const { data: bidData } = await db.from('a2a_bids').select('*').eq('id', bidId).maybeSingle();
    if (!bidData) return fail(res, 404, 'bid_not_found', 'Bid not found');
    const bid = bidData as unknown as BidRow;

    let rfq = await loadRfq(bid.rfq_id);
    if (!rfq) return fail(res, 404, 'rfq_not_found', 'RFQ not found');
    if (!sameAgent(rfq.buyer_agent_id, bound)) {
      return fail(res, 403, 'not_the_buyer', 'Only the RFQ buyer may counter a bid');
    }

    const all = await loadBidsWithRounds(rfq.id);
    rfq = await touchRfqExpiry(rfq, all.length, now);
    if (isRfqExpired(rfq, now)) return fail(res, 410, 'rfq_expired', 'This RFQ has expired');
    if (rfq.status !== 'open' && rfq.status !== 'closed') {
      return fail(res, 409, 'rfq_not_negotiable', `RFQ status is '${rfq.status}'`);
    }

    // SEALED-BID LEAK GUARD. The buyer sees more than any bidder does; letting
    // it counter while bids are still sealed would let it price its confederate
    // at (lowest_rival - 1) and produce a genuinely was_lowest_price=true award
    // that needs no written reason. Under sealed_close, countering waits for
    // the close, exactly like accepting does.
    if (rfq.award_mode === 'sealed_close' && !isPastBidClose(rfq, now)) {
      return fail(
        res,
        425,
        'sealed_until_close',
        'Under award_mode=sealed_close a buyer may not counter before bids_close_at — countering on live sealed ' +
          'prices is how rival bids leak to a favoured bidder.',
        { bids_close_at: rfq.bids_close_at },
      );
    }

    if (bid.status !== 'open' && bid.status !== 'countered') {
      return fail(res, 409, 'bid_not_negotiable', `Bid status is '${bid.status}'`);
    }
    if (roundCapExceeded(bid, rfq)) {
      return fail(res, 409, 'max_rounds_exceeded', `This thread is capped at ${offerCap(rfq)} offers`, {
        rounds_used: bid.rounds_used,
        offer_cap: offerCap(rfq),
      });
    }

    const thread = all.find((b) => sameAgent(b.bid.id, bid.id));
    const current = thread ? currentOffer(thread) : null;
    if (current && Date.parse(current.expires_at) <= now.getTime()) {
      return fail(res, 410, 'round_expired', 'The current offer on this thread has expired');
    }

    const priceCheck = validatePrice(price_usdc_raw, rfq, cfg);
    if (!priceCheck.ok) return fail(res, 400, priceCheck.error ?? 'invalid_price', priceCheck.message ?? 'invalid price');
    const etaCheck = validateEta(eta_seconds);
    if (!etaCheck.ok) return fail(res, 400, etaCheck.error ?? 'invalid_eta', etaCheck.message ?? 'invalid eta');

    const buyer = await loadAgent(bound);
    if (!buyer) return fail(res, 404, 'buyer_not_found', 'Buyer agent not found');

    const result = await appendRound({
      rfq,
      bid,
      roundNo: bid.rounds_used + 1,
      offeredBy: 'buyer',
      actor: buyer,
      price: Number(price_usdc_raw),
      eta: Number(eta_seconds),
      terms: terms ?? {},
      acceptsRoundId: null,
      signature: typeof signature === 'string' ? signature : null,
      ttlSec: round_ttl_seconds === undefined ? undefined : Number(round_ttl_seconds),
      now,
      cfg,
    });
    if (!result.ok) return fail(res, result.status, result.error, result.message);

    return res.status(201).json({
      bid_id: bid.id,
      round: result.round,
      rounds_used: result.round.round_no,
      offer_cap_per_thread: offerCap(rfq),
      attestation_level: result.round.attestation_level,
      disclosures: DISCLOSURES,
    });
  } catch (err: unknown) {
    console.error('[negotiation] POST /bids/:bidId/counter failed:', err);
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /bids/:bidId/respond — provider accepts the counter, or re-bids
// ─────────────────────────────────────────────────────────────────────────────

router.post('/bids/:bidId/respond', async (req: Request, res: Response) => {
  try {
    const bound = requireBoundAgent(req, res);
    if (!bound) return;
    const bidId = pathParam(req, 'bidId');
    if (!bidId) return fail(res, 400, 'bid_id_required', 'bid id is required');

    const cfg = negotiationConfig();
    const now = new Date();
    const { action, price_usdc_raw, eta_seconds, terms, round_ttl_seconds, signature } = req.body ?? {};
    if (action !== 'accept' && action !== 'rebid') {
      return fail(res, 400, 'invalid_action', "action must be 'accept' or 'rebid'");
    }

    const { data: bidData } = await db.from('a2a_bids').select('*').eq('id', bidId).maybeSingle();
    if (!bidData) return fail(res, 404, 'bid_not_found', 'Bid not found');
    const bid = bidData as unknown as BidRow;
    if (!sameAgent(bid.provider_agent_id, bound)) {
      return fail(res, 403, 'not_the_bidder', 'Only the provider on this thread may respond');
    }

    let rfq = await loadRfq(bid.rfq_id);
    if (!rfq) return fail(res, 404, 'rfq_not_found', 'RFQ not found');
    const all = await loadBidsWithRounds(rfq.id);
    rfq = await touchRfqExpiry(rfq, all.length, now);
    if (isRfqExpired(rfq, now)) return fail(res, 410, 'rfq_expired', 'This RFQ has expired');
    if (rfq.status !== 'open' && rfq.status !== 'closed') {
      return fail(res, 409, 'rfq_not_negotiable', `RFQ status is '${rfq.status}'`);
    }
    if (bid.status !== 'countered' && bid.status !== 'open') {
      return fail(res, 409, 'bid_not_negotiable', `Bid status is '${bid.status}'`);
    }
    if (roundCapExceeded(bid, rfq)) {
      return fail(res, 409, 'max_rounds_exceeded', `This thread is capped at ${offerCap(rfq)} offers`, {
        rounds_used: bid.rounds_used,
        offer_cap: offerCap(rfq),
      });
    }

    const thread = all.find((b) => sameAgent(b.bid.id, bid.id));
    const current = thread ? currentOffer(thread) : null;
    if (!current) return fail(res, 409, 'no_open_offer', 'This thread has no offer to respond to');
    if (Date.parse(current.expires_at) <= now.getTime()) {
      return fail(res, 410, 'round_expired', 'The offer you are responding to has expired');
    }

    const provider = await loadAgent(bound);
    if (!provider) return fail(res, 404, 'provider_not_found', 'Provider agent not found');

    let price: number;
    let eta: number;
    let responseTerms: unknown;
    let acceptsRoundId: string | null = null;

    if (action === 'accept') {
      if (current.offered_by !== 'buyer') {
        return fail(res, 409, 'nothing_to_accept', 'The current offer is your own — there is no counter to accept');
      }
      if (!verifyStoredOfferHash(current)) {
        return fail(res, 409, 'offer_tampered', 'The counter you are accepting does not match its recorded offer_hash');
      }
      price = Number(current.price_usdc_raw);
      eta = Number(current.eta_seconds);
      responseTerms = current.terms;
      acceptsRoundId = current.id;
    } else {
      const priceCheck = validatePrice(price_usdc_raw, rfq, cfg);
      if (!priceCheck.ok) return fail(res, 400, priceCheck.error ?? 'invalid_price', priceCheck.message ?? 'invalid price');
      const etaCheck = validateEta(eta_seconds);
      if (!etaCheck.ok) return fail(res, 400, etaCheck.error ?? 'invalid_eta', etaCheck.message ?? 'invalid eta');
      price = Number(price_usdc_raw);
      eta = Number(eta_seconds);
      responseTerms = terms ?? {};
    }

    const result = await appendRound({
      rfq,
      bid,
      roundNo: bid.rounds_used + 1,
      offeredBy: 'provider',
      actor: provider,
      price,
      eta,
      terms: responseTerms,
      acceptsRoundId,
      signature: typeof signature === 'string' ? signature : null,
      ttlSec: round_ttl_seconds === undefined ? undefined : Number(round_ttl_seconds),
      now,
      cfg,
    });
    if (!result.ok) return fail(res, result.status, result.error, result.message);

    return res.status(201).json({
      bid_id: bid.id,
      action,
      round: result.round,
      two_sided: acceptsRoundId !== null,
      attestation_level: result.round.attestation_level,
      note:
        acceptsRoundId !== null
          ? 'This round mirrors the buyer counter and references it via accepts_round_id — the terminal offer is two-sided.'
          : 'This is a fresh provider offer; the buyer must still accept it.',
      disclosures: DISCLOSURES,
    });
  } catch (err: unknown) {
    console.error('[negotiation] POST /bids/:bidId/respond failed:', err);
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /bids/:bidId/withdraw
// ─────────────────────────────────────────────────────────────────────────────

router.post('/bids/:bidId/withdraw', async (req: Request, res: Response) => {
  try {
    const bound = requireBoundAgent(req, res);
    if (!bound) return;
    const bidId = pathParam(req, 'bidId');
    if (!bidId) return fail(res, 400, 'bid_id_required', 'bid id is required');

    const { data: bidData } = await db.from('a2a_bids').select('*').eq('id', bidId).maybeSingle();
    if (!bidData) return fail(res, 404, 'bid_not_found', 'Bid not found');
    const bid = bidData as unknown as BidRow;
    if (!sameAgent(bid.provider_agent_id, bound)) {
      return fail(res, 403, 'not_the_bidder', 'Only the provider on this thread may withdraw it');
    }
    if (bid.status === 'accepted') {
      return fail(res, 409, 'already_accepted', 'This bid has been awarded and cannot be withdrawn');
    }
    if (bid.status !== 'open' && bid.status !== 'countered') {
      return fail(res, 409, 'bid_not_withdrawable', `Bid status is '${bid.status}'`);
    }

    const { data, error } = await db
      .from('a2a_bids')
      .update({ status: 'withdrawn', updated_at: new Date().toISOString() })
      .eq('id', bid.id)
      .in('status', ['open', 'countered'])
      .select()
      .maybeSingle();
    if (error) return fail(res, 400, 'withdraw_failed', error.message);
    if (!data) return fail(res, 409, 'bid_not_withdrawable', 'The bid changed state before the withdrawal landed');

    return res.json({
      bid: data,
      note: 'The round history is retained. Withdrawal counts are surfaced on your provider panel.',
      disclosures: DISCLOSURES,
    });
  } catch (err: unknown) {
    console.error('[negotiation] POST /bids/:bidId/withdraw failed:', err);
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /rfqs/:id/accept — THE PIVOT. No price field. Anywhere.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/rfqs/:id/accept', async (req: Request, res: Response) => {
  try {
    const bound = requireBoundAgent(req, res);
    if (!bound) return;
    const rfqId = pathParam(req, 'id');
    if (!rfqId) return fail(res, 400, 'rfq_id_required', 'rfq id is required');

    const cfg = negotiationConfig();
    const now = new Date();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { bid_id, round_id, award_reason_code, award_rationale } = body as {
      bid_id?: unknown;
      round_id?: unknown;
      award_reason_code?: unknown;
      award_rationale?: unknown;
    };

    // Structural guarantee, asserted at runtime too: a price in the accept body
    // is never read, and its presence is a caller bug worth surfacing loudly.
    for (const forbidden of ['price', 'price_usdc_raw', 'agreed_price_usdc_raw', 'amount']) {
      if (Object.prototype.hasOwnProperty.call(body, forbidden)) {
        return fail(
          res,
          400,
          'price_not_accepted_here',
          `'${forbidden}' is not an input to an award. The contract price is read server-side from the accepted ` +
            'a2a_bid_rounds row after its offer_hash is re-derived. Remove the field.',
        );
      }
    }

    if (typeof bid_id !== 'string' || typeof round_id !== 'string') {
      return fail(res, 400, 'bid_and_round_required', 'bid_id and round_id are required');
    }

    let rfq = await loadRfq(rfqId);
    if (!rfq) return fail(res, 404, 'rfq_not_found', 'RFQ not found');
    if (!sameAgent(rfq.buyer_agent_id, bound)) {
      return fail(res, 403, 'not_the_buyer', 'Only the RFQ buyer may award it');
    }

    const all = await loadBidsWithRounds(rfq.id);
    rfq = await touchRfqExpiry(rfq, all.length, now);

    if (rfq.status === 'awarded') return fail(res, 409, 'already_awarded', 'This RFQ has already been awarded');
    if (rfq.status !== 'open' && rfq.status !== 'closed') {
      return fail(res, 409, 'rfq_not_awardable', `RFQ status is '${rfq.status}'`);
    }
    if (isRfqExpired(rfq, now)) {
      return fail(res, 410, 'rfq_expired', "The buyer's right to award this RFQ has lapsed");
    }
    if (rfq.award_mode === 'sealed_close' && !isPastBidClose(rfq, now)) {
      return fail(res, 425, 'sealed_until_close', 'Under award_mode=sealed_close no award may land before bids_close_at', {
        bids_close_at: rfq.bids_close_at,
      });
    }

    const thread = all.find((b) => sameAgent(b.bid.id, bid_id));
    if (!thread) return fail(res, 404, 'bid_not_found', 'That bid is not on this RFQ');
    const bid = thread.bid;
    if (bid.status !== 'open' && bid.status !== 'countered') {
      return fail(res, 409, 'bid_not_awardable', `Bid status is '${bid.status}'`);
    }
    if (sameAgent(bid.provider_agent_id, rfq.buyer_agent_id)) {
      return fail(res, 400, 'self_dealing_forbidden', 'Buyer and provider may not be the same agent');
    }

    const round = thread.rounds.find((r) => sameAgent(r.id, round_id));
    if (!round) return fail(res, 404, 'round_not_found', 'That round is not on this bid');
    if (bid.current_round_id !== null && !sameAgent(bid.current_round_id, round.id)) {
      return fail(
        res,
        409,
        'not_current_round',
        'Only the CURRENT offer on a thread may be accepted — a superseded round is not a live commitment.',
        { current_round_id: bid.current_round_id },
      );
    }
    if (Date.parse(round.expires_at) <= now.getTime()) {
      return fail(res, 410, 'round_expired', 'That offer has expired');
    }
    if (!verifyStoredOfferHash(round)) {
      return fail(
        res,
        409,
        'offer_tampered',
        'The stored offer does not match its offer_hash. The award is refused; no contract was created.',
      );
    }

    const price = Number(round.price_usdc_raw);
    const eta = Number(round.eta_seconds);

    const priceCheck = validatePrice(price, rfq, cfg);
    if (!priceCheck.ok) return fail(res, 400, priceCheck.error ?? 'invalid_price', priceCheck.message ?? 'invalid price');

    // Re-run the global value caps against the ROUND price (the accept path
    // inserts service_contracts directly and would otherwise skip them).
    const caps = checkValueCaps(price, await settledTodayRaw(todayPT()));
    if (!caps.allowed) {
      return fail(res, 402, caps.error ?? 'value_cap_exceeded', `Value cap exceeded: ${caps.error}`, {
        cap: caps.cap,
        requested: caps.requested,
      });
    }

    // Re-assert the service row at accept time — it can be deactivated, or its
    // min_repid_to_purchase raised, between bid and award. Mirrors
    // contracts.ts:76-89 rather than approximating it.
    const { data: service } = await db
      .from('agent_services')
      .select('id, provider_agent_id, service_type, active, min_repid_to_purchase, base_price_usdc_raw')
      .eq('id', bid.service_id)
      .maybeSingle();
    if (!service) return fail(res, 404, 'service_not_found', 'The bid service_id no longer resolves');
    if (!service.active) return fail(res, 409, 'service_inactive', 'That service was deactivated after the bid');
    if (!sameAgent(service.provider_agent_id, bid.provider_agent_id)) {
      return fail(res, 409, 'service_owner_changed', 'The service is no longer owned by the bidding provider');
    }

    const buyer = await loadAgent(rfq.buyer_agent_id);
    if (!buyer) return fail(res, 404, 'buyer_not_found', 'Buyer agent not found');
    const buyerRepid = Number(buyer.current_repid ?? 0);
    if (buyerRepid < Number(service.min_repid_to_purchase ?? 0)) {
      return fail(res, 403, 'buyer_repid_below_service_minimum', 'Buyer RepID below the service minimum requirement');
    }

    const provider = await loadAgent(bid.provider_agent_id);

    // Lowest-price / uncontested gate — validated BEFORE any write, so a bad
    // rationale can never leave a contract behind. The DB CHECKs are the
    // backstop for callers that bypass this router.
    const competing = validCompetingBids(all);
    const lowest = lowestValidPrice(all);
    const wasLowest = lowest === null ? true : price <= lowest;
    const isUncontested = competing.length <= 1;

    let reasonCode: string | null = null;
    let rationale: string | null = null;
    if (!wasLowest || isUncontested) {
      const check = validateAwardRationale(award_reason_code, award_rationale);
      if (!check.ok) {
        return fail(res, 400, check.error, check.message, {
          why: isUncontested
            ? 'This award is UNCONTESTED (one valid bid). An uncontested award is not evidence of a competitive ' +
              'process, so it carries a permanent written reason.'
            : 'This is not the lowest valid bid, so it carries a permanent written reason.',
          lowest_valid_price_usdc_raw: lowest,
          awarded_price_usdc_raw: price,
          competing_bid_count: competing.length,
          valid_reason_codes: AWARD_REASON_CODES,
        });
      }
      reasonCode = check.reason_code;
      rationale = check.rationale;
    } else if (typeof award_reason_code === 'string' && typeof award_rationale === 'string') {
      const check = validateAwardRationale(award_reason_code, award_rationale);
      if (check.ok) {
        reasonCode = check.reason_code;
        rationale = check.rationale;
      }
    }

    const edges = await loadAwardEdges(rfq.buyer_agent_id, bid.provider_agent_id);
    const concentration = computeConcentration(edges, rfq.buyer_agent_id, bid.provider_agent_id);
    const agents = await loadAgents(all.map((b) => b.bid.provider_agent_id));
    const snapshot = buildDecisionSnapshot({
      rfq,
      buyer,
      bids: all,
      winnerBidId: bid.id,
      winnerRound: round,
      agents,
      concentration,
      now,
    });

    const basePrice = service.base_price_usdc_raw === null || service.base_price_usdc_raw === undefined
      ? null
      : Number(service.base_price_usdc_raw);
    const underbidRatio = basePrice && basePrice > 0 ? price / basePrice : null;
    const buyerProviderRelated = provider !== null && isRelated(provider, buyer);

    const contractExpiresAt = rfq.deadline_at ?? new Date(now.getTime() + eta * 1000).toISOString();

    const outcome = await acceptAndAward({
      p_rfq_id: rfq.id,
      p_bid_id: bid.id,
      p_round_id: round.id,
      p_buyer_agent_id: rfq.buyer_agent_id,
      p_provider_agent_id: bid.provider_agent_id,
      p_service_id: bid.service_id,
      // Read from the round. Never from the request.
      p_price_usdc_raw: price,
      p_eta_seconds: eta,
      p_payload: rfq.scope,
      p_contract_metadata: {
        negotiation: {
          rfq_id: rfq.id,
          bid_id: bid.id,
          round_id: round.id,
          offer_hash: round.offer_hash,
          attestation_level: round.attestation_level,
          award_mode: rfq.award_mode,
          competing_bid_count: competing.length,
          is_uncontested: isUncontested,
          was_lowest_price: wasLowest,
          repid_reward_price_coupled: false,
          post_award_validation: POST_AWARD_VALIDATION_NOTE,
        },
      },
      p_contract_expires_at: contractExpiresAt,
      p_was_lowest_price: wasLowest,
      p_is_uncontested: isUncontested,
      p_award_reason_code: reasonCode,
      p_award_rationale: rationale,
      p_competing_bid_count: competing.length,
      p_decision_snapshot: snapshot,
      p_offer_hash_verified: true,
      p_base_price_usdc_raw: basePrice,
      p_underbid_ratio: underbidRatio,
      p_attestation_level: round.attestation_level,
      p_buyer_provider_related: buyerProviderRelated,
      p_buyer_provider_prior_awards: concentration.awards_from_this_buyer,
      p_provider_award_share_from_this_buyer: concentration.provider_award_share_from_this_buyer,
    });

    if (!outcome.ok) return fail(res, outcome.status, outcome.error, outcome.message);

    return res.status(201).json({
      award_id: outcome.award_id,
      contract_id: outcome.contract_id,
      rfq_id: rfq.id,
      winning_bid_id: bid.id,
      winning_round_id: round.id,
      awarded_price_usdc_raw: price,
      price_source: 'a2a_bid_rounds.price_usdc_raw of winning_round_id — no price was read from the request body',
      promised_eta_seconds: eta,
      contract_expires_at: contractExpiresAt,
      was_lowest_price: wasLowest,
      is_uncontested: isUncontested,
      competing_bid_count: competing.length,
      award_reason_code: reasonCode,
      award_rationale: rationale,
      attestation_level: round.attestation_level,
      buyer_provider_related: buyerProviderRelated,
      concentration,
      disclosures: DISCLOSURES,
    });
  } catch (err: unknown) {
    console.error('[negotiation] POST /rfqs/:id/accept failed:', err);
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /rfqs/:id/cancel
// ─────────────────────────────────────────────────────────────────────────────

router.post('/rfqs/:id/cancel', async (req: Request, res: Response) => {
  try {
    const bound = requireBoundAgent(req, res);
    if (!bound) return;
    const rfqId = pathParam(req, 'id');
    if (!rfqId) return fail(res, 400, 'rfq_id_required', 'rfq id is required');

    const rfq = await loadRfq(rfqId);
    if (!rfq) return fail(res, 404, 'rfq_not_found', 'RFQ not found');
    if (!sameAgent(rfq.buyer_agent_id, bound)) {
      return fail(res, 403, 'not_the_buyer', 'Only the RFQ buyer may cancel it');
    }
    if (rfq.status === 'awarded') return fail(res, 409, 'already_awarded', 'An awarded RFQ cannot be cancelled');

    const { data, error } = await db
      .from('a2a_rfqs')
      .update({ status: 'cancelled', outcome: 'cancelled_by_buyer', closed_at: new Date().toISOString() })
      .eq('id', rfq.id)
      .in('status', ['open', 'closed'])
      .select()
      .maybeSingle();
    if (error) return fail(res, 400, 'cancel_failed', error.message);
    if (!data) return fail(res, 409, 'rfq_not_cancellable', 'The RFQ changed state before the cancel landed');

    await db.from('a2a_bids').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('rfq_id', rfq.id).in('status', ['open', 'countered']);

    return res.json({
      rfq: data,
      note:
        'cancelled_by_buyer counts against your award ratio exactly as a lapse does. Cancelling is not a cheaper ' +
        'exit than abandoning, and abandoning is not cheaper than cancelling — the ratio is computed from ' +
        'expires_at, not from status.',
      disclosures: DISCLOSURES,
    });
  } catch (err: unknown) {
    console.error('[negotiation] POST /rfqs/:id/cancel failed:', err);
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /awards/by-contract/:contractId — the auditor's reverse traversal
// ─────────────────────────────────────────────────────────────────────────────

router.get('/awards/by-contract/:contractId', async (req: Request, res: Response) => {
  try {
    const bound = requireBoundAgent(req, res);
    if (!bound) return;
    const contractId = pathParam(req, 'contractId');
    if (!contractId) return fail(res, 400, 'contract_id_required', 'contract id is required');

    const { data: contract } = await db
      .from('service_contracts')
      .select('id, buyer_agent_id, provider_agent_id, agreed_price_usdc_raw, status, metadata')
      .eq('id', contractId)
      .maybeSingle();
    if (!contract) return fail(res, 404, 'contract_not_found', 'Contract not found');

    if (!sameAgent(contract.buyer_agent_id, bound) && !sameAgent(contract.provider_agent_id, bound)) {
      return fail(res, 403, 'not_a_party', 'Only a party to this contract may read its award record');
    }

    const { data: award } = await db.from('a2a_awards').select('*').eq('contract_id', contractId).maybeSingle();
    if (!award) {
      return fail(
        res,
        404,
        'award_not_found',
        'This contract has no a2a_awards row — it was not created through the negotiation path (or it is an ' +
          'orphan, which the reconciliation query in the proposed SQL is designed to surface).',
      );
    }

    const rfq = await loadRfq(String(award.rfq_id));
    const all = rfq ? await loadBidsWithRounds(rfq.id) : [];

    const losing = all
      .filter((b) => !sameAgent(b.bid.id, String(award.winning_bid_id)))
      .map((b) => ({
        bid_id: b.bid.id,
        provider_agent_id: b.bid.provider_agent_id,
        status: b.bid.status,
        related_bidder_flag: b.bid.related_bidder_flag,
        related_to_buyer_flag: b.bid.related_to_buyer_flag,
        provider_repid_at_bid: b.bid.provider_repid_at_bid,
        rounds: b.rounds.map((r) => ({
          id: r.id,
          round_no: r.round_no,
          offered_by: r.offered_by,
          price_usdc_raw: Number(r.price_usdc_raw),
          eta_seconds: Number(r.eta_seconds),
          terms: r.terms,
          accepts_round_id: r.accepts_round_id,
          offer_hash: r.offer_hash,
          offer_hash_verified: verifyStoredOfferHash(r),
          attestation_level: r.attestation_level,
          expires_at: r.expires_at,
          created_at: r.created_at,
        })),
      }));

    const { data: winningRound } = await db
      .from('a2a_bid_rounds')
      .select('*')
      .eq('id', award.winning_round_id)
      .maybeSingle();
    const wr = winningRound as unknown as RoundRow | null;

    const priceMatches =
      wr !== null &&
      Number(wr.price_usdc_raw) === Number(award.awarded_price_usdc_raw) &&
      Number(wr.price_usdc_raw) === Number(contract.agreed_price_usdc_raw);

    return res.json({
      contract: {
        id: contract.id,
        status: contract.status,
        agreed_price_usdc_raw: Number(contract.agreed_price_usdc_raw),
        buyer_agent_id: contract.buyer_agent_id,
        provider_agent_id: contract.provider_agent_id,
        metadata: contract.metadata,
      },
      award,
      winning_round: wr
        ? {
            ...wr,
            price_usdc_raw: Number(wr.price_usdc_raw),
            offer_hash_verified: verifyStoredOfferHash(wr),
          }
        : null,
      rfq,
      losing_bids: losing,
      losing_bid_count: losing.length,
      price_reconciliation: {
        contract_price: Number(contract.agreed_price_usdc_raw),
        award_price: Number(award.awarded_price_usdc_raw),
        winning_round_price: wr === null ? null : Number(wr.price_usdc_raw),
        all_three_match: priceMatches,
      },
      decision_snapshot: award.decision_snapshot,
      disclosures: DISCLOSURES,
    });
  } catch (err: unknown) {
    console.error('[negotiation] GET /awards/by-contract/:contractId failed:', err);
    return fail(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
  }
});

export default router;
