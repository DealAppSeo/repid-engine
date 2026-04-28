/**
 * Paper trade outcome resolver.
 *
 * Polls open paper_trade_orders, fetches the latest fill from Alpaca via
 * the trading bridge, computes a P&L proxy, and resolves the linked bet.
 *
 * P&L → outcome mapping (per sprint Phase 9):
 *   profit ≥ 5%   → outcome=true,  large positive RepID delta
 *   0 < profit    → outcome=true,  small positive
 *   profit ≤ 0    → outcome=false, negative delta
 *
 * Uses the existing resolveBet() pipeline (atomic linkage, Wisdom +
 * Character updates, builder RepID recompute). Successful resolutions
 * also bump the cap pct via bumpAgentCapPct().
 *
 * Designed to be called periodically by a cron — exposed via
 * /api/v1/builder/resolve-paper-trades for manual triggering during
 * the demo.
 */

import { db } from '../db';
import { emitAuditEvent } from './audit-emit';
import { resolveBet, signOracleOutcome } from './linked-bet-resolver';
import { getTradingBridge } from './trading-bridge/factory';
import { decryptCredentials, EncryptedCreds } from './trading-creds-crypto';
import { TradingProviderName } from './trading-bridge/types';
import { bumpAgentCapPct } from './paper-trade-execution';
import { dispatchNotificationFor } from './notification-dispatcher';

const PROFIT_THRESHOLD_LARGE = 0.05; // ≥ 5% profit

export interface ResolveBatchResult {
  ok: boolean;
  inspected: number;
  resolved: number;
  errors: Array<{ order_id: string; error: string }>;
  resolutions: Array<{ bet_id: string; outcome: boolean; pnl_pct: number; new_cap_pct?: number }>;
}

interface OrderRow {
  id: string;
  bet_id: string;
  builder_id: string;
  agent_id: string;
  provider: TradingProviderName;
  alpaca_order_id: string | null;
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  limit_price: number | null;
  notional_estimate: number | null;
  cap_pct_at_open: number | null;
  status: string;
}

export async function resolveOpenPaperTrades(opts?: { limit?: number; force?: boolean }): Promise<ResolveBatchResult> {
  const limit = Math.max(1, Math.min(100, opts?.limit ?? 25));
  const result: ResolveBatchResult = { ok: true, inspected: 0, resolved: 0, errors: [], resolutions: [] };

  const { data: orders } = await db
    .from('paper_trade_orders')
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: true })
    .limit(limit);

  const list = (orders ?? []) as OrderRow[];
  result.inspected = list.length;

  for (const o of list) {
    try {
      const r = await resolveOneOrder(o, !!opts?.force);
      if (r.resolved) {
        result.resolved += 1;
        if (r.bet_id) {
          result.resolutions.push({
            bet_id: r.bet_id,
            outcome: !!r.outcome,
            pnl_pct: r.pnl_pct ?? 0,
            new_cap_pct: r.new_cap_pct,
          });
        }
      }
    } catch (e: any) {
      result.errors.push({ order_id: o.alpaca_order_id ?? o.id, error: e?.message ?? 'unknown' });
    }
  }

  return result;
}

interface OneResolveResult {
  resolved: boolean;
  bet_id?: string;
  outcome?: boolean;
  pnl_pct?: number;
  new_cap_pct?: number;
}

async function resolveOneOrder(o: OrderRow, force: boolean): Promise<OneResolveResult> {
  if (!o.alpaca_order_id) return { resolved: false };

  const { data: builder } = await db
    .from('builders')
    .select('trading_credentials_encrypted, trading_provider')
    .eq('id', o.builder_id)
    .maybeSingle();
  if (!builder?.trading_credentials_encrypted) return { resolved: false };

  let creds: { api_key: string; secret_key: string };
  try {
    creds = decryptCredentials(builder.trading_credentials_encrypted as EncryptedCreds);
  } catch {
    return { resolved: false };
  }

  const provider = (builder.trading_provider as TradingProviderName) ?? o.provider;
  const bridge = getTradingBridge(provider);
  const status = await bridge.getOrderStatus({ order_id: o.alpaca_order_id, credentials: creds });
  if (!status.ok || !status.status) return { resolved: false };

  const isClosed = status.status === 'filled' || status.status === 'canceled' || status.status === 'expired';
  if (!isClosed && !force) return { resolved: false };

  const filledQty = Number(status.filled_qty ?? 0);
  const filledAvgPrice = Number(status.filled_avg_price ?? 0);
  const entryNotional = Number(o.notional_estimate ?? 0);
  const exitNotional = filledQty * filledAvgPrice;

  // Simple P&L proxy: for buys, profit if exit > entry; for sells, profit
  // if entry > exit. Using the cap-check entry estimate as the entry price
  // since paper "buy" orders fill near market, and the demo's directional
  // bet is "did the trade go your way."
  let pnl = 0;
  if (entryNotional > 0 && exitNotional > 0) {
    const diff = exitNotional - entryNotional;
    pnl = o.side === 'buy' ? diff : -diff;
  }
  const pnlPct = entryNotional > 0 ? pnl / entryNotional : 0;

  const outcome = pnl > 0;
  const sig = signOracleOutcome(o.bet_id, outcome);
  const resolveResult = await resolveBet(o.bet_id, outcome, sig);
  if (!resolveResult.ok) {
    throw new Error(`resolveBet failed: ${resolveResult.error}`);
  }

  // Bump cap on success
  let newCap: number | undefined;
  if (outcome) {
    newCap = await bumpAgentCapPct(o.builder_id, o.agent_id);
  }

  await db.from('paper_trade_orders').update({
    status: 'resolved',
    filled_qty: filledQty,
    filled_avg_price: filledAvgPrice,
    pnl,
    resolved_at: new Date().toISOString(),
  }).eq('id', o.id);

  await emitAuditEvent({
    event_type: 'paper_trade_resolved',
    source_table: 'paper_trade_orders',
    source_id: o.id,
    payload: {
      bet_id: o.bet_id,
      builder_id: o.builder_id,
      agent_id: o.agent_id,
      symbol: o.symbol,
      side: o.side,
      filled_qty: filledQty,
      filled_avg_price: filledAvgPrice,
      pnl,
      pnl_pct: pnlPct,
      outcome,
      large_winner: pnlPct >= PROFIT_THRESHOLD_LARGE,
      new_cap_pct: newCap,
    },
  });

  // Fire notification (best-effort; failures don't break resolution)
  dispatchNotificationFor(o.builder_id, {
    event_type: 'paper_trade_resolved',
    bet_id: o.bet_id,
    symbol: o.symbol,
    side: o.side,
    pnl,
    pnl_pct: pnlPct,
    outcome,
    new_cap_pct: newCap,
  }).catch(e => console.warn('[resolver] notify failed:', e?.message));

  return { resolved: true, bet_id: o.bet_id, outcome, pnl_pct: pnlPct, new_cap_pct: newCap };
}
