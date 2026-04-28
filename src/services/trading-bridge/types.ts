/**
 * Trading bridge — the strategic abstraction.
 *
 * All trading callers go through getTradingBridge(provider) → TradingBridge
 * interface → either alpaca-rest.ts (today) or alpaca-mcp.ts (v0.2 stub
 * today, real MCP wiring in v0.2). v0.2 swap is a one-line factory change;
 * no caller code changes.
 */

export type TradingProviderName = 'alpaca_rest' | 'alpaca_mcp';

export interface TradingCredentials {
  api_key: string;
  secret_key: string;
}

export interface ValidateResult {
  ok: boolean;
  account_id?: string;
  buying_power?: string;
  error?: string;
}

export interface PlaceOrderArgs {
  agent_id: string;
  symbol: string;
  qty: number;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  limit_price?: number;
  credentials: TradingCredentials;
}

export interface PlaceOrderResult {
  ok: boolean;
  order_id?: string;
  filled_qty?: number;
  filled_price?: number;
  status?: string;
  is_simulated: boolean;
  error?: string;
}

export interface AccountResult {
  ok: boolean;
  buying_power?: string;
  portfolio_value?: string;
  account_id?: string;
  error?: string;
}

export interface OrderStatusArgs {
  order_id: string;
  credentials: TradingCredentials;
}

export interface OrderStatusResult {
  ok: boolean;
  order_id: string;
  status?: string;                 // 'new' | 'partially_filled' | 'filled' | 'canceled' | 'expired' | etc.
  filled_qty?: number;
  filled_avg_price?: number;
  symbol?: string;
  side?: 'buy' | 'sell';
  is_simulated: boolean;
  error?: string;
}

export interface TradingBridge {
  validateCredentials(creds: TradingCredentials): Promise<ValidateResult>;
  placeOrder(args: PlaceOrderArgs): Promise<PlaceOrderResult>;
  getAccount(creds: TradingCredentials): Promise<AccountResult>;
  getOrderStatus(args: OrderStatusArgs): Promise<OrderStatusResult>;
  getProviderName(): TradingProviderName;
}
