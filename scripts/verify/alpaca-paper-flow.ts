#!/usr/bin/env ts-node
/**
 * Alpaca paper-trading verification script.
 *
 * No one has actually walked the full Alpaca paper flow end-to-end —
 * MVP2 wired the REST adapter (src/services/trading-bridge/alpaca-rest.ts)
 * but the credentials, market hours, and small-order behavior have not
 * been confirmed against the real API. This script does that:
 *
 *   1. Validate creds via GET /v2/account
 *   2. Place a small market order (default: 1 share AAPL, day TIF, paper)
 *   3. Poll GET /v2/orders/<id> until filled or 30s timeout
 *   4. If not filled, DELETE /v2/orders/<id> to cancel
 *   5. Print a structured PASS / PARTIAL / FAIL summary and exit non-zero
 *      on FAIL so it can gate CI.
 *
 * Environment:
 *   ALPACA_API_KEY     paper API key id     (required)
 *   ALPACA_SECRET_KEY  paper API secret key (required)
 *   ALPACA_PAPER_BASE_URL  override base URL (default https://paper-api.alpaca.markets/v2)
 *   VERIFY_SYMBOL      override symbol      (default AAPL)
 *   VERIFY_QTY         override quantity    (default 1)
 *
 * Run: npm run verify:alpaca
 *
 * The script writes a timestamped log to scripts/verify/alpaca-verify-output-YYYY-MM-DD.log
 * in addition to stdout, so the artifact lives with the code.
 */

import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = process.env.ALPACA_PAPER_BASE_URL || 'https://paper-api.alpaca.markets/v2';
const API_KEY = process.env.ALPACA_API_KEY ?? '';
const SECRET = process.env.ALPACA_SECRET_KEY ?? '';
const SYMBOL = process.env.VERIFY_SYMBOL || 'AAPL';
const QTY = Number(process.env.VERIFY_QTY ?? '1');

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;

const todayIso = new Date().toISOString().slice(0, 10);
const logPath = path.resolve(__dirname, `alpaca-verify-output-${todayIso}.log`);
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  logStream.write(stamped + '\n');
}

function authHeaders(): Record<string, string> {
  return {
    'APCA-API-KEY-ID': API_KEY,
    'APCA-API-SECRET-KEY': SECRET,
    'Content-Type': 'application/json',
  };
}

interface AccountResp {
  id: string;
  status: string;
  buying_power: string;
  equity: string;
  currency: string;
  pattern_day_trader: boolean;
  trading_blocked: boolean;
}

interface OrderResp {
  id: string;
  status: string;
  symbol: string;
  qty: string;
  filled_qty: string;
  filled_avg_price: string | null;
  side: string;
  type: string;
  time_in_force: string;
}

async function alpacaGet<T>(path: string): Promise<{ status: number; body: T | null; raw: string }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  const raw = await res.text();
  let body: T | null = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  return { status: res.status, body, raw };
}

async function alpacaPost<T>(path: string, payload: unknown): Promise<{ status: number; body: T | null; raw: string }> {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
  const raw = await res.text();
  let body: T | null = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  return { status: res.status, body, raw };
}

async function alpacaDelete(path: string): Promise<{ status: number; raw: string }> {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE', headers: authHeaders() });
  const raw = await res.text();
  return { status: res.status, raw };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main(): Promise<number> {
  log(`=== Alpaca paper verification — target ${BASE_URL} ===`);

  if (!API_KEY || !SECRET) {
    log('FAIL: ALPACA_API_KEY and/or ALPACA_SECRET_KEY are not set in env.');
    log('Set them locally or run via Railway env injection. Aborting.');
    return 2;
  }

  // Step 1 — credentials
  log('Step 1/4 — validating credentials via GET /v2/account ...');
  const acct = await alpacaGet<AccountResp>('/account');
  if (acct.status !== 200 || !acct.body) {
    log(`FAIL: GET /account returned ${acct.status}. Body: ${acct.raw.slice(0, 400)}`);
    return 1;
  }
  log(`  account_id=${acct.body.id} status=${acct.body.status} buying_power=${acct.body.buying_power} equity=${acct.body.equity} currency=${acct.body.currency}`);
  if (acct.body.trading_blocked) {
    log('FAIL: trading_blocked=true on this paper account. Cannot place orders.');
    return 1;
  }

  // Step 2 — place a small market order
  log(`Step 2/4 — placing market BUY ${QTY} ${SYMBOL} (day) ...`);
  const order = await alpacaPost<OrderResp>('/orders', {
    symbol: SYMBOL,
    qty: QTY,
    side: 'buy',
    type: 'market',
    time_in_force: 'day',
  });
  if (order.status !== 200 && order.status !== 201) {
    log(`FAIL: POST /orders returned ${order.status}. Body: ${order.raw.slice(0, 400)}`);
    return 1;
  }
  if (!order.body?.id) {
    log(`FAIL: order placed but no id returned. Body: ${order.raw.slice(0, 400)}`);
    return 1;
  }
  const orderId = order.body.id;
  log(`  order_id=${orderId} initial_status=${order.body.status}`);

  // Step 3 — poll for fill
  log('Step 3/4 — polling for fill (up to 30s) ...');
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = order.body.status;
  let filled: OrderResp | null = null;
  while (Date.now() < deadline) {
    const o = await alpacaGet<OrderResp>(`/orders/${orderId}`);
    if (o.status !== 200 || !o.body) {
      log(`  WARN: poll returned ${o.status}; will retry.`);
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (o.body.status !== lastStatus) {
      log(`  status: ${lastStatus} → ${o.body.status} (filled_qty=${o.body.filled_qty})`);
      lastStatus = o.body.status;
    }
    if (o.body.status === 'filled') {
      filled = o.body;
      break;
    }
    if (o.body.status === 'rejected' || o.body.status === 'canceled' || o.body.status === 'expired') {
      log(`FAIL: order entered terminal non-fill state: ${o.body.status}`);
      return 1;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Step 4 — cancel if not filled
  if (!filled) {
    log(`Step 4/4 — order did not fill in ${POLL_TIMEOUT_MS / 1000}s (last status=${lastStatus}); canceling ...`);
    const cancel = await alpacaDelete(`/orders/${orderId}`);
    log(`  DELETE /orders/${orderId} → ${cancel.status}`);
    if (cancel.status !== 204 && cancel.status !== 200 && cancel.status !== 207) {
      log(`PARTIAL: cancel call returned ${cancel.status}. Order may still be open — check Alpaca UI.`);
      return 1;
    }
    log('PARTIAL: credentials valid, order placement valid, but no fill in window. Likely off-hours or low liquidity. Order canceled cleanly.');
    return 0; // partial success — still useful signal
  }

  log(`Step 4/4 — order filled. filled_qty=${filled.filled_qty} avg_price=${filled.filled_avg_price}`);
  log('PASS: credentials valid, order placed, order filled. Alpaca paper flow is wired correctly.');
  return 0;
}

main()
  .then(code => {
    logStream.end(() => process.exit(code));
  })
  .catch(err => {
    log(`UNCAUGHT: ${err?.stack ?? err}`);
    logStream.end(() => process.exit(1));
  });
