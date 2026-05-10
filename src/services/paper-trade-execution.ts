/**
 * Stake-bounded agent paper trade execution.
 *
 * Cap progression: each agent starts at 50% of the builder's authority.
 * Each successful resolved trade bumps the cap by +5%, up to 90%.
 * The cap percentage per agent lives at
 *   builders.notification_prefs.agent_trade_caps[agent_id]
 *
 * Authority is computed via stake-vault.computeAuthority. The trade
 * notional (qty × estimated_price) must fit under (authority * cap%).
 *
 * Estimated price for the cap check: market orders use last trade
 * fetched from Alpaca; limit orders use the limit_price. If we can't
 * fetch a quote we fall back to a conservative $1000/share assumption
 * so users can't sneak around the gate by quoting an unknown ticker.
 */

import { db } from '../db';
import { emitAuditEvent } from './audit-emit';
import { computeAuthority } from './stake-vault';
import { getBuilderForAgent } from './builder-registry';
import { getTradingBridge, isMcpNotImplemented } from './trading-bridge/factory';
import { decryptCredentials, EncryptedCreds } from './trading-creds-crypto';
import { TradingProviderName } from './trading-bridge/types';

export const STARTING_CAP_PCT = 50;
export const CAP_BUMP_PCT = 5;
export const MAX_CAP_PCT = 90;
const FALLBACK_PRICE = 1000; // conservative cap-check fallback for unknown tickers

export interface ExecutePaperTradeInput {
  builderId: string;
  agentId: string;
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  rationale?: string;
  type?: 'market' | 'limit';
  limit_price?: number;
}

export interface ExecutePaperTradeResult {
  ok: boolean;
  order_id?: string;
  filled?: boolean;
  filled_qty?: number;
  filled_price?: number;
  linked_bet_id?: string;
  authority?: string;
  cap_pct?: number;
  notional_estimate?: number;
  is_simulated: boolean;
  mcp_not_implemented?: boolean;
  error?: string;
}

export async function getAgentCapPct(builderId: string, agentId: string): Promise<number> {
  const { data: builder } = await db
    .from('builders')
    .select('notification_prefs')
    .eq('id', builderId)
    .maybeSingle();
  const caps = (builder?.notification_prefs as any)?.agent_trade_caps ?? {};
  const stored = Number(caps[agentId]);
  if (Number.isFinite(stored) && stored > 0) return Math.min(MAX_CAP_PCT, Math.max(0, stored));
  return STARTING_CAP_PCT;
}

export async function bumpAgentCapPct(builderId: string, agentId: string): Promise<number> {
  const { data: builder } = await db
    .from('builders')
    .select('notification_prefs')
    .eq('id', builderId)
    .maybeSingle();
  const prefs = (builder?.notification_prefs as Record<string, any>) ?? {};
  const caps = (prefs.agent_trade_caps as Record<string, number>) ?? {};
  const current = Number(caps[agentId]) || STARTING_CAP_PCT;
  const next = Math.min(MAX_CAP_PCT, current + CAP_BUMP_PCT);
  caps[agentId] = next;
  prefs.agent_trade_caps = caps;
  await db.from('builders').update({ notification_prefs: prefs }).eq('id', builderId);
  return next;
}

async function getEstimatedPrice(
  bridge: ReturnType<typeof getTradingBridge>,
  symbol: string,
  creds: { api_key: string; secret_key: string },
  fallback: number,
): Promise<number> {
  // Best-effort: Alpaca paper /v2 doesn't expose market data directly,
  // so we use the last close from the data API if env is wired. Fail
  // open to fallback to keep the demo flow snappy.
  try {
    const dataUrl = process.env.ALPACA_DATA_BASE_URL;
    if (!dataUrl) return fallback;
    const r = await fetch(`${dataUrl}/stocks/${encodeURIComponent(symbol)}/trades/latest`, {
      headers: {
        'APCA-API-KEY-ID': creds.api_key,
        'APCA-API-SECRET-KEY': creds.secret_key,
      },
    });
    const j: any = await r.json();
    const p = Number(j?.trade?.p);
    if (Number.isFinite(p) && p > 0) return p;
    return fallback;
  } catch {
    return fallback;
  }
}

export async function executePaperTrade(input: ExecutePaperTradeInput): Promise<ExecutePaperTradeResult> {
  // Load builder + creds
  const { data: builder } = await db
    .from('builders')
    .select('id, trading_provider, trading_credentials_encrypted')
    .eq('id', input.builderId)
    .maybeSingle();
  if (!builder) return { ok: false, is_simulated: false, error: 'builder not found' };
  if (!builder.trading_provider || !builder.trading_credentials_encrypted) {
    return { ok: false, is_simulated: false, error: 'builder has no linked trading account — call /link-trading-account first' };
  }

  // Confirm agent ownership
  const { data: agent } = await db
    .from('repid_agents')
    .select('id, builder_id')
    .eq('id', input.agentId)
    .maybeSingle();
  if (!agent || agent.builder_id !== input.builderId) {
    return { ok: false, is_simulated: false, error: 'agent does not belong to this builder' };
  }

  // Authority + cap
  const builderCtx = await getBuilderForAgent(input.agentId);
  if (!builderCtx) return { ok: false, is_simulated: false, error: 'agent context lookup failed' };
  const auth = computeAuthority({
    stakeAmount: builderCtx.stake,
    agentRepId: builderCtx.agentRepId,
    agentWisdom: builderCtx.agentWisdom,
    agentCharacter: builderCtx.agentCharacter,
    builderRepId: builderCtx.builderRepId,
  });
  if (auth.authority === 0n) {
    return { ok: false, is_simulated: false, authority: '0', error: 'authority is zero — deposit stake or boost RepID first' };
  }
  const capPct = await getAgentCapPct(input.builderId, input.agentId);

  // Decrypt creds and estimate price for cap check
  let creds: { api_key: string; secret_key: string };
  try {
    creds = decryptCredentials(builder.trading_credentials_encrypted as EncryptedCreds);
  } catch (e: any) {
    return { ok: false, is_simulated: false, error: `cred decrypt failed: ${e?.message ?? 'unknown'}` };
  }
  const provider = builder.trading_provider as TradingProviderName;
  const bridge = getTradingBridge(provider);

  const estPrice = input.type === 'limit' && input.limit_price !== undefined
    ? input.limit_price
    : await getEstimatedPrice(bridge, input.symbol, creds, FALLBACK_PRICE);
  const notional = input.qty * estPrice;
  const allowedNotional = Number(auth.authority) * (capPct / 100);

  if (notional > allowedNotional) {
    // Paper trade gated by stake authority cap; record as BLOCK in unified eval table.
    try {
      const { writeHalEvaluation } = require('./hal-evaluations-writer');
      void writeHalEvaluation({
        mode: 'production',
        prompt_text: input.rationale,
        prompt_source: 'production_traffic',
        agent_id: input.agentId,
        decision: 'BLOCK',
        notes: `Paper trade BLOCKED by stake-authority cap: ${input.side} ${input.qty} ${input.symbol} via TrustTrader (notional≈${notional.toFixed(2)}, allowed≈${allowedNotional.toFixed(2)}, authority=${auth.authority.toString()}, cap=${capPct}%)`,
      });
    } catch (e) {
      console.warn('[paper-trade-execution] hal_evaluations write failed:', e);
    }
    return {
      ok: false,
      authority: auth.authority.toString(),
      cap_pct: capPct,
      notional_estimate: notional,
      is_simulated: false,
      error: `notional ${notional.toFixed(2)} exceeds cap ${allowedNotional.toFixed(2)} (${capPct}% of authority ${auth.authority.toString()})`,
    };
  }

  // Place order
  const orderResult = await bridge.placeOrder({
    agent_id: input.agentId,
    symbol: input.symbol,
    qty: input.qty,
    side: input.side,
    type: input.type ?? 'market',
    limit_price: input.limit_price,
    credentials: creds,
  });
  if (!orderResult.ok) {
    if (isMcpNotImplemented(orderResult.error)) {
      return { ok: false, mcp_not_implemented: true, is_simulated: false, error: orderResult.error };
    }
    return { ok: false, is_simulated: orderResult.is_simulated, error: orderResult.error };
  }

  // Insert linked_bet directly (we already passed the authority check above
  // and want our own oracle endpoint string for the resolver to recognize).
  const betId = `bet_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  const betAmount = BigInt(Math.max(1, Math.floor(notional)));
  // Confidence basis points proxy — derived from cap_pct (more authorized
  // = more confident posture). 50% cap → 5000 bp, 90% cap → 9000 bp.
  const confBp = Math.min(10000, Math.max(0, capPct * 100));

  const safeRationale = (input.rationale ?? '').slice(0, 500);
  const { error: betErr } = await db.from('linked_bets').insert({
    id: betId,
    agent_id: input.agentId,
    bet_amount: betAmount.toString(),
    claimed_confidence: confBp,
    prediction_payload: {
      trade: {
        symbol: input.symbol,
        qty: input.qty,
        side: input.side,
        rationale: safeRationale,
        type: input.type ?? 'market',
        limit_price: input.limit_price,
      },
      predicted_outcome: input.side === 'buy', // buy = bet that price goes up; sell = bet it goes down
      builder_id: input.builderId,
      cap_pct_at_open: capPct,
    },
    oracle_endpoint: 'paper-trade-resolution',
    expected_resolution_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    status: 'open',
    plonky3_proof_bytes: '',
    is_simulated: false,
  });
  if (betErr) {
    return { ok: true, order_id: orderResult.order_id, filled: false, is_simulated: false, error: `linked_bets insert failed: ${betErr.message}` };
  }

  // Persist alpaca order id alongside the bet for the resolver. Best-effort:
  // if the table is missing the resolver still has the alpaca_order_id in
  // the audit chain, so the demo doesn't break.
  try {
    await db.from('paper_trade_orders').insert({
      bet_id: betId,
      builder_id: input.builderId,
      agent_id: input.agentId,
      provider,
      alpaca_order_id: orderResult.order_id,
      symbol: input.symbol,
      qty: input.qty,
      side: input.side,
      type: input.type ?? 'market',
      limit_price: input.limit_price ?? null,
      notional_estimate: notional,
      cap_pct_at_open: capPct,
      status: 'open',
    });
  } catch (e: any) {
    console.warn('[paper-trade-execution] paper_trade_orders insert failed:', e?.message);
  }

  await emitAuditEvent({
    event_type: 'paper_trade_placed',
    source_table: 'linked_bets',
    source_id: betId,
    payload: {
      bet_id: betId,
      builder_id: input.builderId,
      agent_id: input.agentId,
      symbol: input.symbol,
      qty: input.qty,
      side: input.side,
      notional_estimate: notional,
      cap_pct: capPct,
      authority: auth.authority.toString(),
      alpaca_order_id: orderResult.order_id,
      provider,
    },
  });

  // Paper trade APPROVED by stake-authority cap; record in unified eval table.
  // Note: paper trades are not HAL-evaluated (no signals, no comma_gap, no
  // cross-LLM agreement). The "decision" captured here is the cap-gate
  // verdict, not a HAL veto verdict.
  try {
    const { writeHalEvaluation } = require('./hal-evaluations-writer');
    void writeHalEvaluation({
      mode: 'production',
      prompt_text: input.rationale,
      prompt_source: 'production_traffic',
      agent_id: input.agentId,
      decision: 'APPROVE',
      notes: `Paper trade APPROVED: ${input.side} ${input.qty} ${input.symbol} via TrustTrader (notional≈${notional.toFixed(2)}, authority=${auth.authority.toString()}, cap=${capPct}%, bet_id=${betId})`,
    });
  } catch (e) {
    console.warn('[paper-trade-execution] hal_evaluations write failed:', e);
  }

  return {
    ok: true,
    order_id: orderResult.order_id,
    filled: orderResult.status === 'filled',
    filled_qty: orderResult.filled_qty,
    filled_price: orderResult.filled_price,
    linked_bet_id: betId,
    authority: auth.authority.toString(),
    cap_pct: capPct,
    notional_estimate: notional,
    is_simulated: false,
  };
}
