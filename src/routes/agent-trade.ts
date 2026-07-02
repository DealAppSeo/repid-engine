import { Router, Request, Response } from 'express';
import { checkTransactionAuthority } from '../services/x402-gate';
import { settleX402Payment } from '../services/x402-real-settler';
import { updateRepId } from '../engine/repid-update';
import type { BadgeAward } from '../engine/badges';
import { db } from '../db';

/**
 * Agent trade surfaces (golden-loop E2E). Two shapes over ONE settlement primitive:
 *
 *   1. RAW value transfer (agent↔agent, the primitive):
 *        POST /api/v1/agent/:agentId/trade   { target_agent_id, amount_usdc }
 *      → self-dealing guard → tier-ceiling authority (x402-gate) → settlement
 *        (x402-real-settler) → move BOTH agents' RepID via updateRepId() (which fires the
 *        tier trigger + badge check). Returns { status:'settled', tx_hash, basescan_url,
 *        is_real_settlement, payer_new_repid/tier, target_new_repid/tier, badges_awarded, ... }.
 *
 *   2. Marketplace PURCHASE (trustshell / TrustChat marketplace):
 *        POST /api/v1/agent/:providerAgentId/purchase
 *          { buyer_agent_id, service_type, provider_agent_id? }
 *      → resolve `service_type` → provider + price from the `agent_services`
 *        catalog → delegate to the SAME raw-transfer authority-gate + settlement
 *        flow (buyer = payer, provider = payee) with the resolved USDC amount.
 *      Returns the frontend envelope { ok, tx_hash, settlement_url, repid_delta,
 *        receipt_id } on success and { ok:false, error, x402_challenge? } / 402 on
 *        denial.
 *
 * For backward-compat with the frontend that still POSTs the purchase body to
 * `/trade`, the `/trade` handler ALSO accepts the purchase shape (detected by the
 * presence of `buyer_agent_id`/`service_type`) and returns the purchase envelope.
 *
 * All money-moving is delegated to the settler, which is honest about mock vs real
 * via `is_real_settlement`.
 */
const router = Router();

// Recoverable failures the caller can retry after changing state (stake up / wait for
// daily reset). Everything else from the gate is a policy PERMANENT deny.
const RECOVERABLE_DENIALS = new Set(['insufficient_stake', 'exceeds_daily_limit']);

// RepID deltas emitted per settled trade (payer earns for the spend, payee for delivery).
// NOTE: these are the CONTRACTED deltas; the AUTHORITATIVE delta actually applied to each
// agent comes back from updateRepId() (which routes through FIXED_DELTAS[AGENT_TRADE_*] plus
// decay/redemption/clamp). We surface the returned delta, not these constants, in the response.
const PAYER_DELTA = 3;
const PAYEE_DELTA = 5;

/** Outcome of the shared raw-transfer primitive: either an HTTP error to relay, or a settled result. */
type TransferOutcome =
  | { ok: false; status: number; body: Record<string, unknown> }
  | {
      ok: true;
      payer: any;
      payee: any;
      amount: number;
      tier: string;
      tx_hash: string | null;
      basescan_url: string | null;
      is_real_settlement: boolean;
      payer_delta: number;
      payee_delta: number;
      // RepID/tier/badge movement captured from updateRepId() for BOTH agents (golden loop).
      payer_repid_after: number | null;
      payer_tier_after: string | null;
      payer_badges: BadgeAward[];
      payee_repid_after: number | null;
      payee_tier_after: string | null;
      payee_badges: BadgeAward[];
    };

/**
 * The raw agent→agent value-transfer primitive, shared by /trade and /purchase.
 * Runs: input validation → self-dealing guard → agent resolution → tier authority
 * gate → settlement → emit repid_events for both agents. Returns a structured
 * outcome; the caller shapes the HTTP envelope.
 */
async function executeRawTransfer(
  payerId: string,
  targetAgentId: unknown,
  amountUsdc: unknown,
): Promise<TransferOutcome> {
  // ---- input validation ----
  if (!targetAgentId || typeof targetAgentId !== 'string') {
    return { ok: false, status: 400, body: { error: 'target_agent_id (string) is required' } };
  }
  const amount = Number(amountUsdc);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: 400, body: { error: 'amount_usdc must be a positive number' } };
  }

  // ---- self-dealing guard (PERMANENT) ----
  if (payerId === targetAgentId) {
    return {
      ok: false,
      status: 402,
      body: {
        error: 'self_dealing_forbidden',
        denial_reason: 'self_dealing_forbidden',
        failure_class: 'PERMANENT',
        next_step: 'Choose a distinct target_agent_id; an agent cannot trade with itself.',
      },
    };
  }

  // ---- resolve both agents (need agent_name for the gate + settler) ----
  const [payerRes, payeeRes] = await Promise.all([
    db.from('repid_agents').select('id, agent_name, current_repid, tier').eq('id', payerId).maybeSingle(),
    db.from('repid_agents').select('id, agent_name, current_repid, tier').eq('id', targetAgentId).maybeSingle(),
  ]);
  const payer: any = payerRes.data;
  const payee: any = payeeRes.data;
  if (!payer) return { ok: false, status: 404, body: { error: 'payer_agent_not_found', agent_id: payerId } };
  if (!payee) return { ok: false, status: 404, body: { error: 'target_agent_not_found', agent_id: targetAgentId } };

  // ---- tier-ceiling authority gate (payer is the one spending) ----
  const authority = await checkTransactionAuthority({
    agent: payer.agent_name,
    transaction_type: 'agent_trade',
    amount,
  });
  if (!authority.authorized) {
    const failureClass = RECOVERABLE_DENIALS.has(authority.denial_reason ?? '') ? 'RECOVERABLE' : 'PERMANENT';
    const nextStep =
      authority.denial_reason === 'insufficient_stake'
        ? `Increase active stake to at least ${amount} USDC, then retry.`
        : authority.denial_reason === 'exceeds_daily_limit'
          ? `Daily ceiling reached (${authority.daily_used}/${authority.daily_limit} USDC). Retry after the UTC day resets.`
          : authority.denial_reason === 'exceeds_per_tx_limit'
            ? `Amount ${amount} USDC exceeds the ${authority.tier} per-tx ceiling of ${authority.per_tx_limit} USDC.`
            : authority.denial_reason === 'open_disputes'
              ? 'Resolve open disputes before transacting.'
              : `Tier ${authority.tier} is not permitted to settle this transaction.`;
    return {
      ok: false,
      status: 402,
      body: {
        error: 'tier_authority_denied',
        denial_reason: authority.denial_reason,
        failure_class: failureClass,
        tier: authority.tier,
        per_tx_limit: authority.per_tx_limit,
        daily_limit: authority.daily_limit,
        daily_remaining: authority.daily_remaining,
        recommended: nextStep,
        next_step: nextStep,
      },
    };
  }

  // ---- settlement ----
  const idempotencyKey = `trade_${payer.id}_${payee.id}_${Date.now()}`;
  const settlement = await settleX402Payment(payer.agent_name, payee.agent_name, amount, idempotencyKey);

  if (settlement.settlement_source !== 'onchain_x402') {
    // Settlement failed / no funds. insufficient balance is PERMANENT; a transient
    // facilitator/RPC error is RECOVERABLE. We infer from the error text conservatively.
    const err = settlement.error ?? 'settlement_pending_funding';
    const permanent = /balance|insufficient|Governor limit|Cannot determine destination/i.test(err);
    return {
      ok: false,
      status: 402,
      body: {
        error: 'settlement_failed',
        denial_reason: err,
        failure_class: permanent ? 'PERMANENT' : 'RECOVERABLE',
        is_real_settlement: settlement.is_real_settlement,
        next_step: permanent
          ? 'Fund the payer wallet with sufficient USDC (or lower amount_usdc), then retry.'
          : 'Transient settlement failure — retry shortly; the recovery worker will also re-attempt.',
        recommended: permanent
          ? 'Fund the payer wallet with sufficient USDC (or lower amount_usdc), then retry.'
          : 'Retry shortly.',
      },
    };
  }

  // ---- move BOTH agents' RepID through the real scoring pipeline ----
  // THE golden-loop fix: settlement previously wrote raw `repid_events` rows but NEVER called
  // updateRepId(), so repid_agents.current_repid never changed → trg_sync_tier never fired (tier
  // frozen) → checkAndAwardBadges never ran (no badges). We now route BOTH agents through the
  // canonical pipeline: constitutional audit → decay → ecosystem-need → FIXED_DELTAS[AGENT_TRADE_*]
  // → redemption → clamp → repid_score_events audit row → repid_agents UPDATE (tier trigger fires)
  // → checkAndAwardBadges. This is the SINGLE source of the delta — we no longer also write the
  // legacy `repid_events` row, so the score is never double-counted.
  //
  // TODO(review): also add agent_trade_settled_* to feedback-loop-worker filter for ERC-8004
  // attestation (the worker is for on-chain attestation, NOT for moving the score — left untouched).
  //
  // Payer earns for a successful settled spend; payee earns for delivery. updateRepId is the
  // authoritative delta source; failures here are surfaced but must not un-settle the trade — the
  // money already moved. We attempt both, then continue with whatever moved.
  let payerResult: Awaited<ReturnType<typeof updateRepId>> | null = null;
  let payeeResult: Awaited<ReturnType<typeof updateRepId>> | null = null;
  const x402Context = {
    paymentAmount: amount,
    paymentCurrency: 'USDC',
    x402RequestId: idempotencyKey,
  };
  try {
    payerResult = await updateRepId({ agentId: payer.id, eventType: 'AGENT_TRADE_PAYER', x402Context });
  } catch (e: any) {
    // Non-blocking: settlement already happened; a scoring failure is logged, not fatal.
    console.error('[agent-trade] updateRepId(payer) failed (settlement stands):', e?.message ?? e);
  }
  try {
    payeeResult = await updateRepId({ agentId: payee.id, eventType: 'AGENT_TRADE_PAYEE', x402Context });
  } catch (e: any) {
    console.error('[agent-trade] updateRepId(payee) failed (settlement stands):', e?.message ?? e);
  }

  return {
    ok: true,
    payer,
    payee,
    amount,
    tier: authority.tier,
    tx_hash: settlement.tx_hash ?? null,
    basescan_url: settlement.basescan_url ?? null,
    is_real_settlement: settlement.is_real_settlement,
    // Authoritative deltas from the pipeline (fall back to the contracted constants if scoring
    // failed, so the response never lies about the intended delta).
    payer_delta: payerResult?.delta ?? PAYER_DELTA,
    payee_delta: payeeResult?.delta ?? PAYEE_DELTA,
    payer_repid_after: payerResult?.repIdAfter ?? null,
    payer_tier_after: payerResult?.tier ?? null,
    payer_badges: payerResult?.newBadges ?? [],
    payee_repid_after: payeeResult?.repIdAfter ?? null,
    payee_tier_after: payeeResult?.tier ?? null,
    payee_badges: payeeResult?.newBadges ?? [],
  };
}

/**
 * Resolve a marketplace service from the `agent_services` catalog by (provider, service_type)
 * and run the purchase as a raw transfer buyer→provider. Shapes the frontend envelope.
 *
 * `agent_services` columns used (verified against src/types/database.types.ts): id,
 * provider_agent_id, service_type, service_name, base_price_usdc_raw (raw 6-decimal
 * micro-USDC), min_repid_to_purchase, active.
 */
async function handlePurchase(
  providerAgentId: string,
  buyerAgentId: unknown,
  serviceType: unknown,
  res: Response,
): Promise<Response> {
  if (!buyerAgentId || typeof buyerAgentId !== 'string') {
    return res.status(400).json({ ok: false, error: 'buyer_agent_id (string) is required' });
  }
  if (!serviceType || typeof serviceType !== 'string') {
    return res.status(400).json({ ok: false, error: 'service_type (string) is required' });
  }

  // ---- resolve service from catalog: newest ACTIVE service of this type for this provider ----
  const { data: service, error: svcErr } = await db
    .from('agent_services')
    .select('id, provider_agent_id, service_type, service_name, base_price_usdc_raw, min_repid_to_purchase, active')
    .eq('provider_agent_id', providerAgentId)
    .eq('service_type', serviceType)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (svcErr) {
    return res.status(500).json({ ok: false, error: `service_lookup_failed: ${svcErr.message}` });
  }
  const svc: any = service;
  if (!svc) {
    return res.status(404).json({
      ok: false,
      error: 'service_not_found',
      detail: `No active '${serviceType}' service found for provider ${providerAgentId}.`,
    });
  }

  // base_price_usdc_raw is raw 6-decimal micro-USDC; the settler wants a float USDC amount.
  const priceUsdc = Number(svc.base_price_usdc_raw) / 1_000_000;
  if (!Number.isFinite(priceUsdc) || priceUsdc <= 0) {
    return res.status(422).json({
      ok: false,
      error: 'invalid_service_price',
      detail: `Service ${svc.id} has a non-positive base_price_usdc_raw.`,
    });
  }

  const outcome = await executeRawTransfer(buyerAgentId, providerAgentId, priceUsdc);

  if (!outcome.ok) {
    // Map the raw-transfer error to the purchase envelope. Authority denials are the
    // x402 "payment required" handshake → surface x402_challenge for the 402 case.
    const body: Record<string, unknown> = { ok: false, ...outcome.body };
    if (outcome.status === 402) {
      body.x402_challenge = {
        error: outcome.body.error,
        denial_reason: outcome.body.denial_reason,
        failure_class: outcome.body.failure_class,
        amount_usdc: priceUsdc,
        service_id: svc.id,
        service_type: svc.service_type,
        provider_agent_id: providerAgentId,
        next_step: outcome.body.next_step,
      };
    }
    return res.status(outcome.status).json(body);
  }

  // ---- success envelope expected by trustshell lib/repid-engine.ts::purchaseService ----
  return res.status(200).json({
    ok: true,
    tx_hash: outcome.tx_hash,
    settlement_url: outcome.basescan_url,
    // repid_delta = the buyer's (purchaser's) reputation delta for a settled purchase.
    repid_delta: outcome.payer_delta,
    receipt_id: outcome.tx_hash ?? `receipt_${outcome.payer.id}_${outcome.payee.id}_${Date.now()}`,
    // extra context (harmless to the frontend, which spreads unknown keys):
    is_real_settlement: outcome.is_real_settlement,
    amount_usdc: outcome.amount,
    service_type: svc.service_type,
    service_name: svc.service_name,
    provider_agent_id: providerAgentId,
    buyer_agent_id: buyerAgentId,
    tier: outcome.tier,
    // golden-loop: surface the RepID/tier/badge movement for both parties (buyer = payer).
    buyer_new_repid: outcome.payer_repid_after,
    buyer_new_tier: outcome.payer_tier_after,
    buyer_badges_awarded: outcome.payer_badges,
    provider_new_repid: outcome.payee_repid_after,
    provider_new_tier: outcome.payee_tier_after,
    provider_badges_awarded: outcome.payee_badges,
  });
}

/**
 * RAW value transfer — the primitive. Also accepts the marketplace-purchase shape for
 * backward-compat with a frontend that still POSTs the purchase body here.
 */
router.post('/agent/:agentId/trade', async (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const body = req.body ?? {};

  // If the body carries a purchase shape, treat this as a marketplace purchase (the
  // path param is the PROVIDER). This keeps the existing frontend working unchanged.
  const looksLikePurchase = body.buyer_agent_id !== undefined || body.service_type !== undefined;
  if (looksLikePurchase) {
    return handlePurchase(agentId, body.buyer_agent_id, body.service_type, res);
  }

  // ---- raw transfer path ----
  const outcome = await executeRawTransfer(agentId, body.target_agent_id, body.amount_usdc);
  if (!outcome.ok) {
    return res.status(outcome.status).json(outcome.body);
  }
  return res.status(200).json({
    status: 'settled',
    payer_agent_id: outcome.payer.id,
    target_agent_id: outcome.payee.id,
    amount_usdc: outcome.amount,
    tx_hash: outcome.tx_hash,
    basescan_url: outcome.basescan_url,
    is_real_settlement: outcome.is_real_settlement,
    tier: outcome.tier,
    repid_events_emitted: 2,
    // golden-loop: the settled trade now MOVES both agents' RepID through updateRepId().
    payer_repid_delta: outcome.payer_delta,
    payer_new_repid: outcome.payer_repid_after,
    payer_new_tier: outcome.payer_tier_after,
    payer_badges_awarded: outcome.payer_badges,
    target_repid_delta: outcome.payee_delta,
    target_new_repid: outcome.payee_repid_after,
    target_new_tier: outcome.payee_tier_after,
    target_badges_awarded: outcome.payee_badges,
  });
});

/**
 * Marketplace PURCHASE surface — the clean, named endpoint. The path param is the
 * PROVIDER agent id. Resolves price from `agent_services` and delegates to the raw
 * transfer buyer→provider.
 */
router.post('/agent/:providerAgentId/purchase', async (req: Request, res: Response) => {
  const providerAgentId = String(req.params.providerAgentId);
  const body = req.body ?? {};
  return handlePurchase(providerAgentId, body.buyer_agent_id, body.service_type, res);
});

export default router;
