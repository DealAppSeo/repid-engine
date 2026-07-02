import { Router, Request, Response } from 'express';
import { checkTransactionAuthority } from '../services/x402-gate';
import { settleX402Payment } from '../services/x402-real-settler';
import { db } from '../db';

/**
 * Generic agent ↔ agent trade surface (golden-loop E2E).
 *
 *   POST /api/v1/agent/:agentId/trade   { target_agent_id, amount_usdc }
 *
 * Flow: self-dealing guard → tier-ceiling authority check (x402-gate) → settlement
 * (x402-real-settler) → emit a RepID `repid_events` row for BOTH agents. The payer
 * (`:agentId`) earns a small +delta for successful settlement; the payee
 * (`target_agent_id`) earns a delivery +delta. All money-moving is delegated to the
 * settler, which is honest about mock vs real via `is_real_settlement`.
 *
 * Denials return 402 with a `denial_reason` + `next_step`/`recommended` fallback and a
 * PERMANENT vs RECOVERABLE `failure_class`.
 */
const router = Router();

// Recoverable failures the caller can retry after changing state (stake up / wait for
// daily reset). Everything else from the gate is a policy PERMANENT deny.
const RECOVERABLE_DENIALS = new Set(['insufficient_stake', 'exceeds_daily_limit']);

router.post('/agent/:agentId/trade', async (req: Request, res: Response) => {
  const payerId = String(req.params.agentId);
  const { target_agent_id, amount_usdc } = req.body ?? {};

  // ---- input validation ----
  if (!target_agent_id || typeof target_agent_id !== 'string') {
    return res.status(400).json({ error: 'target_agent_id (string) is required' });
  }
  const amount = Number(amount_usdc);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount_usdc must be a positive number' });
  }

  // ---- self-dealing guard (PERMANENT) ----
  if (payerId === target_agent_id) {
    return res.status(402).json({
      error: 'self_dealing_forbidden',
      denial_reason: 'self_dealing_forbidden',
      failure_class: 'PERMANENT',
      next_step: 'Choose a distinct target_agent_id; an agent cannot trade with itself.',
    });
  }

  // ---- resolve both agents (need agent_name for the gate + settler) ----
  const [payerRes, payeeRes] = await Promise.all([
    db.from('repid_agents').select('id, agent_name, current_repid, tier').eq('id', payerId).maybeSingle(),
    db.from('repid_agents').select('id, agent_name, current_repid, tier').eq('id', target_agent_id).maybeSingle(),
  ]);
  const payer: any = payerRes.data;
  const payee: any = payeeRes.data;
  if (!payer) return res.status(404).json({ error: 'payer_agent_not_found', agent_id: payerId });
  if (!payee) return res.status(404).json({ error: 'target_agent_not_found', agent_id: target_agent_id });

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
    return res.status(402).json({
      error: 'tier_authority_denied',
      denial_reason: authority.denial_reason,
      failure_class: failureClass,
      tier: authority.tier,
      per_tx_limit: authority.per_tx_limit,
      daily_limit: authority.daily_limit,
      daily_remaining: authority.daily_remaining,
      recommended: nextStep,
      next_step: nextStep,
    });
  }

  // ---- settlement ----
  const idempotencyKey = `trade_${payer.id}_${payee.id}_${Date.now()}`;
  const settlement = await settleX402Payment(payer.agent_name, payee.agent_name, amount, idempotencyKey);

  if (settlement.settlement_source !== 'onchain_x402') {
    // Settlement failed / no funds. insufficient balance is PERMANENT; a transient
    // facilitator/RPC error is RECOVERABLE. We infer from the error text conservatively.
    const err = settlement.error ?? 'settlement_pending_funding';
    const permanent = /balance|insufficient|Governor limit|Cannot determine destination/i.test(err);
    return res.status(402).json({
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
    });
  }

  // ---- emit RepID score events for BOTH agents ----
  // Payer earns for a successful settled spend; payee earns for delivery. Deltas are
  // intentionally small and non-blocking (a logging failure must not fail the trade).
  const settledAt = new Date().toISOString();
  const baseEventData = {
    tx_hash: settlement.tx_hash ?? null,
    amount_usdc: amount,
    is_real_settlement: settlement.is_real_settlement,
    idempotency_key: idempotencyKey,
    settled_at: settledAt,
  };
  try {
    await db.from('repid_events').insert([
      {
        subject_id: payer.id,
        subject_type: 'agent',
        event_type: 'agent_trade_settled_payer',
        reputation_delta: 3,
        event_data: { ...baseEventData, role: 'payer', counterparty_id: payee.id },
      },
      {
        subject_id: payee.id,
        subject_type: 'agent',
        event_type: 'agent_trade_settled_payee',
        reputation_delta: 5,
        event_data: { ...baseEventData, role: 'payee', counterparty_id: payer.id },
      },
    ]);
  } catch (e: any) {
    // Non-blocking: settlement already happened; a ledger-write failure is logged, not fatal.
    console.error('[agent-trade] repid_events insert failed (settlement stands):', e?.message ?? e);
  }

  return res.status(200).json({
    status: 'settled',
    payer_agent_id: payer.id,
    target_agent_id: payee.id,
    amount_usdc: amount,
    tx_hash: settlement.tx_hash ?? null,
    basescan_url: settlement.basescan_url ?? null,
    is_real_settlement: settlement.is_real_settlement,
    tier: authority.tier,
    repid_events_emitted: 2,
  });
});

export default router;
