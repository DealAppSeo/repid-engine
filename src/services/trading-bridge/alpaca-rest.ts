/**
 * Alpaca paper trading — REST adapter.
 *
 * Targets paper-api.alpaca.markets/v2 by default. Set
 * ALPACA_PAPER_BASE_URL to override (e.g. for live trading,
 * "https://api.alpaca.markets/v2" — NOT recommended for the demo).
 *
 * Uses Node 20+ built-in fetch — no extra dep.
 *
 * All credential decryption happens at the caller boundary; this
 * adapter only sees plaintext { api_key, secret_key } and never
 * persists them.
 */

import {
  TradingBridge,
  TradingProviderName,
  TradingCredentials,
  ValidateResult,
  PlaceOrderArgs,
  PlaceOrderResult,
  AccountResult,
  OrderStatusArgs,
  OrderStatusResult,
} from './types';

const DEFAULT_BASE_URL = 'https://paper-api.alpaca.markets/v2';

function baseUrl(): string {
  return process.env.ALPACA_PAPER_BASE_URL || DEFAULT_BASE_URL;
}

function authHeaders(creds: TradingCredentials): Record<string, string> {
  return {
    'APCA-API-KEY-ID': creds.api_key,
    'APCA-API-SECRET-KEY': creds.secret_key,
    'Content-Type': 'application/json',
  };
}

async function alpacaFetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; json?: any; text?: string }> {
  try {
    const r = await fetch(`${baseUrl()}${path}`, init as any);
    const text = await r.text();
    let json: any = undefined;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* not json */ }
    return { ok: r.ok, status: r.status, json, text };
  } catch (e: any) {
    return { ok: false, status: 0, text: e?.message ?? 'fetch failed' };
  }
}

export class AlpacaRestBridge implements TradingBridge {
  getProviderName(): TradingProviderName {
    return 'alpaca_rest';
  }

  async validateCredentials(creds: TradingCredentials): Promise<ValidateResult> {
    const r = await alpacaFetch('/account', { method: 'GET', headers: authHeaders(creds) });
    if (!r.ok || !r.json) {
      return { ok: false, error: r.json?.message ?? `validate failed (status ${r.status})` };
    }
    return {
      ok: true,
      account_id: String(r.json.id ?? r.json.account_number ?? ''),
      buying_power: String(r.json.buying_power ?? '0'),
    };
  }

  async getAccount(creds: TradingCredentials): Promise<AccountResult> {
    const r = await alpacaFetch('/account', { method: 'GET', headers: authHeaders(creds) });
    if (!r.ok || !r.json) {
      return { ok: false, error: r.json?.message ?? `getAccount failed (status ${r.status})` };
    }
    return {
      ok: true,
      account_id: String(r.json.id ?? r.json.account_number ?? ''),
      buying_power: String(r.json.buying_power ?? '0'),
      portfolio_value: String(r.json.portfolio_value ?? '0'),
    };
  }

  async placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult> {
    const body: Record<string, any> = {
      symbol: args.symbol,
      qty: String(args.qty),
      side: args.side,
      type: args.type,
      time_in_force: 'day',
    };
    if (args.type === 'limit' && args.limit_price !== undefined) {
      body.limit_price = String(args.limit_price);
    }
    const r = await alpacaFetch('/orders', {
      method: 'POST',
      headers: authHeaders(args.credentials),
      body: JSON.stringify(body),
    });
    if (!r.ok || !r.json) {
      return { ok: false, is_simulated: false, error: r.json?.message ?? `placeOrder failed (status ${r.status})` };
    }
    return {
      ok: true,
      order_id: String(r.json.id ?? ''),
      status: String(r.json.status ?? 'new'),
      filled_qty: r.json.filled_qty !== undefined ? Number(r.json.filled_qty) : 0,
      filled_price: r.json.filled_avg_price !== undefined ? Number(r.json.filled_avg_price) : undefined,
      is_simulated: false,
    };
  }

  async getOrderStatus(args: OrderStatusArgs): Promise<OrderStatusResult> {
    const r = await alpacaFetch(`/orders/${encodeURIComponent(args.order_id)}`, {
      method: 'GET',
      headers: authHeaders(args.credentials),
    });
    if (!r.ok || !r.json) {
      return { ok: false, order_id: args.order_id, is_simulated: false, error: r.json?.message ?? `getOrderStatus failed (status ${r.status})` };
    }
    return {
      ok: true,
      order_id: args.order_id,
      status: String(r.json.status ?? ''),
      filled_qty: r.json.filled_qty !== undefined ? Number(r.json.filled_qty) : 0,
      filled_avg_price: r.json.filled_avg_price !== undefined ? Number(r.json.filled_avg_price) : undefined,
      symbol: r.json.symbol,
      side: r.json.side,
      is_simulated: false,
    };
  }
}
