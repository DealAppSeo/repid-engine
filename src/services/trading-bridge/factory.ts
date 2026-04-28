/**
 * Trading bridge factory.
 *
 * The single point of construction for all callers. Switching from
 * REST → MCP in v0.2 is a one-line change here (plus the alpaca-mcp.ts
 * stub becomes a real implementation). No caller code changes.
 */

import { TradingBridge, TradingProviderName } from './types';
import { AlpacaRestBridge } from './alpaca-rest';
import { AlpacaMcpBridge } from './alpaca-mcp';

export function getTradingBridge(provider: TradingProviderName): TradingBridge {
  if (provider === 'alpaca_rest') return new AlpacaRestBridge();
  if (provider === 'alpaca_mcp') return new AlpacaMcpBridge();
  throw new Error(`unknown trading provider: ${provider}`);
}

export function isMcpNotImplemented(err: string | undefined): boolean {
  return !!err && err.includes('MCP path not yet implemented');
}
