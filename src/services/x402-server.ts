/**
 * x402 server — HTTP 402 Payment Required for tip distribution.
 *
 * Per Coinbase x402 spec: a "402 Payment Required" response carries an
 * `accepts` array describing payment terms. The client retries the same
 * URL with an `X-PAYMENT` header containing the on-chain settlement
 * proof.
 *
 * v0.1: real on-chain verification is gated behind X402_REAL_RPC=true.
 * Default is simulated success (the X-PAYMENT header is present and
 * accepted as-is). Every response is tagged `is_simulated`.
 */

import { db } from '../db';
import { emitAuditEvent } from './audit-emit';

const USDC_BASE_SEPOLIA = process.env.USDC_BASE_SEPOLIA_ADDRESS ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PROVIDER_WALLET = process.env.PROVIDER_AGENT_WALLET ?? '0x0000000000000000000000000000000000000000';

export interface TipRequestInput {
  requestor_agent_id: string;
  provider_agent_id: string;
  prediction_topic: string;
}

export interface TipRequestResult {
  status: 402;
  body: {
    x402Version: 1;
    accepts: Array<{
      scheme: 'exact';
      network: 'base-sepolia';
      asset: string;
      amount: string;
      payTo: string;
      resource: string;
      description: string;
    }>;
    error: 'Payment required';
    is_simulated: boolean;
    tip_id: string;
  };
}

function newTipId(): string {
  return `tip_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export async function createTipRequest(input: TipRequestInput): Promise<TipRequestResult> {
  // Provider price = 1 USDC base + premium scaled by their RepID (every 1000
  // RepID adds 0.1 USDC).
  const { data: provider } = await db
    .from('repid_agents')
    .select('current_repid, character_score')
    .eq('id', input.provider_agent_id)
    .maybeSingle();
  const providerRepId = Number(provider?.current_repid ?? 5000);
  const basePriceUSDC = 1_000_000n;                                   // 1.0 USDC
  const premium = (BigInt(Math.floor(providerRepId / 1000)) * 100_000n);
  const priceTotal = basePriceUSDC + premium;

  const tipId = newTipId();

  await db.from('linked_bets').insert({
    id: tipId,
    agent_id: input.provider_agent_id,
    bet_amount: priceTotal.toString(),
    claimed_confidence: 0,
    prediction_payload: {
      topic: input.prediction_topic,
      requestor: input.requestor_agent_id,
    },
    oracle_endpoint: '',
    expected_resolution_time: null,
    status: 'awaiting_payment',
    is_simulated: !process.env.X402_REAL_RPC,
  });

  await emitAuditEvent({
    event_type: 'x402_tip_requested',
    source_table: 'linked_bets',
    source_id: tipId,
    payload: {
      tip_id: tipId,
      requestor: input.requestor_agent_id,
      provider: input.provider_agent_id,
      topic: input.prediction_topic,
      amount: priceTotal.toString(),
      is_simulated: !process.env.X402_REAL_RPC,
    },
  });

  return {
    status: 402,
    body: {
      x402Version: 1,
      accepts: [
        {
          scheme: 'exact',
          network: 'base-sepolia',
          asset: USDC_BASE_SEPOLIA,
          amount: priceTotal.toString(),
          payTo: PROVIDER_WALLET,
          resource: `/api/v1/tip/deliver/${tipId}`,
          description: `Prediction tip on: ${input.prediction_topic}`,
        },
      ],
      error: 'Payment required',
      is_simulated: !process.env.X402_REAL_RPC,
      tip_id: tipId,
    },
  };
}

export interface TipDeliveryInput {
  tipId: string;
  xPaymentHeader: string;
  payerAddress?: string;
}

export interface TipDeliveryResult {
  ok: boolean;
  tip_id: string;
  content?: string;
  is_simulated: boolean;
  audit_chain_id: number | null;
  error?: string;
}

async function verifyPaymentOnChain(_xPayment: string): Promise<boolean> {
  // v0.2 hook: parse X-PAYMENT, query Base Sepolia for the underlying
  // USDC transfer event, confirm amount + payee match the 402 challenge.
  // For v0.1 with X402_REAL_RPC unset, this code path is unreachable.
  return false;
}

function generateTipContent(predictionPayload: Record<string, unknown>): string {
  // Deterministic mock — v0.2 wires the HAL-validated tip generator.
  const topic = String(predictionPayload?.topic ?? 'unknown topic');
  return `[mock tip] Prediction guidance for "${topic}". HAL-validated content goes here in v0.2.`;
}

export async function deliverTip(input: TipDeliveryInput): Promise<TipDeliveryResult> {
  if (!input.xPaymentHeader) {
    return { ok: false, tip_id: input.tipId, is_simulated: false, audit_chain_id: null, error: 'X-PAYMENT header required' };
  }

  const { data: tip } = await db.from('linked_bets').select('*').eq('id', input.tipId).maybeSingle();
  if (!tip || tip.status !== 'awaiting_payment') {
    return { ok: false, tip_id: input.tipId, is_simulated: false, audit_chain_id: null, error: 'tip not found or already delivered' };
  }

  const isSimulated = !process.env.X402_REAL_RPC;
  const verified = isSimulated ? true : await verifyPaymentOnChain(input.xPaymentHeader);
  if (!verified) {
    return { ok: false, tip_id: input.tipId, is_simulated: isSimulated, audit_chain_id: null, error: 'payment verification failed' };
  }

  const content = generateTipContent(tip.prediction_payload || {});

  await db.from('linked_bets').update({ status: 'delivered' }).eq('id', input.tipId);
  // Schema-drift fix (2026-05-22): the prior insert used columns that do not
  // exist on x402_settlements (payee_address / settlement_tx_hash /
  // http_402_challenge), so this write errored silently. Map to the real
  // generated-schema columns (verified via src/types/database.types.ts):
  // required = amount, prediction_topic, tip_id. The X-PAYMENT header lives in
  // x_payment_header; the provider/requestor are agent ids, not wallet strings.
  await db.from('x402_settlements').insert({
    tip_id: input.tipId,
    prediction_topic: String((tip.prediction_payload as any)?.topic ?? 'unknown'),
    amount: Number(tip.bet_amount),
    asset: 'USDC',
    status: 'settled',
    payer_address: input.payerAddress ?? null,
    provider_agent_id: tip.agent_id ?? null,
    requestor_agent_id: (tip.prediction_payload as any)?.requestor ?? null,
    x_payment_header: input.xPaymentHeader,
    is_simulated: isSimulated,
    delivered_at: new Date().toISOString(),
  });

  const audit = await emitAuditEvent({
    event_type: 'x402_tip_delivered',
    source_table: 'linked_bets',
    source_id: input.tipId,
    payload: {
      tip_id: input.tipId,
      provider: tip.agent_id,
      amount: tip.bet_amount,
      is_simulated: isSimulated,
    },
  });

  return {
    ok: true,
    tip_id: input.tipId,
    content,
    is_simulated: isSimulated,
    audit_chain_id: audit.audit_chain_id,
  };
}
