/**
 * Alpaca MCP adapter — STUB. v0.2 will replace this with a real
 * MCP-server-backed implementation. Same TradingBridge interface so the
 * factory swap is one line; no caller code changes.
 *
 * Calling any method on this returns ok=false with a 501-style error
 * message. The route layer surfaces this as HTTP 501 to make it obvious
 * to clients that MCP is not yet wired.
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

const NOT_IMPLEMENTED_MSG = 'MCP path not yet implemented (v0.2)';

export class AlpacaMcpBridge implements TradingBridge {
  getProviderName(): TradingProviderName {
    return 'alpaca_mcp';
  }

  async validateCredentials(_creds: TradingCredentials): Promise<ValidateResult> {
    return { ok: false, error: NOT_IMPLEMENTED_MSG };
  }

  async getAccount(_creds: TradingCredentials): Promise<AccountResult> {
    return { ok: false, error: NOT_IMPLEMENTED_MSG };
  }

  async placeOrder(_args: PlaceOrderArgs): Promise<PlaceOrderResult> {
    return { ok: false, is_simulated: false, error: NOT_IMPLEMENTED_MSG };
  }

  async getOrderStatus(args: OrderStatusArgs): Promise<OrderStatusResult> {
    return { ok: false, order_id: args.order_id, is_simulated: false, error: NOT_IMPLEMENTED_MSG };
  }
}
