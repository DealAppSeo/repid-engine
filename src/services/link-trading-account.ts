/**
 * Link an Alpaca paper account to a builder.
 *
 * Validates the credentials with the bridge, then encrypts and stores
 * them on the builder row. The encrypted blob lives in
 * builders.trading_credentials_encrypted (JSONB). The bridge is
 * constructed via the factory — callers never see REST vs MCP.
 *
 * MCP returns `mcp_not_implemented: true` so the route layer can map
 * it to HTTP 501.
 */

import { db } from '../db';
import { emitAuditEvent } from './audit-emit';
import { getTradingBridge, isMcpNotImplemented } from './trading-bridge/factory';
import { TradingProviderName } from './trading-bridge/types';
import { encryptCredentials } from './trading-creds-crypto';

export interface LinkInput {
  builderId: string;
  provider: TradingProviderName;
  api_key: string;
  secret_key: string;
}

export interface LinkResult {
  ok: boolean;
  provider?: TradingProviderName;
  account_id?: string;
  buying_power?: string;
  status?: 'linked';
  mcp_not_implemented?: boolean;
  error?: string;
}

export async function linkTradingAccount(input: LinkInput): Promise<LinkResult> {
  if (input.provider !== 'alpaca_rest' && input.provider !== 'alpaca_mcp') {
    return { ok: false, error: `unknown provider: ${input.provider}` };
  }
  if (!input.api_key || !input.secret_key) {
    return { ok: false, error: 'api_key and secret_key required' };
  }

  const bridge = getTradingBridge(input.provider);
  const v = await bridge.validateCredentials({ api_key: input.api_key, secret_key: input.secret_key });
  if (!v.ok) {
    if (isMcpNotImplemented(v.error)) {
      return { ok: false, provider: input.provider, mcp_not_implemented: true, error: v.error };
    }
    return { ok: false, provider: input.provider, error: v.error ?? 'validate failed' };
  }

  const encrypted = encryptCredentials({ api_key: input.api_key, secret_key: input.secret_key });

  const { error } = await db
    .from('builders')
    .update({
      trading_provider: input.provider,
      trading_credentials_encrypted: encrypted,
      trading_paper_account_id: v.account_id ?? null,
    })
    .eq('id', input.builderId);

  if (error) {
    return { ok: false, provider: input.provider, error: error.message };
  }

  await emitAuditEvent({
    event_type: 'trading_account_linked',
    source_table: 'builders',
    source_id: input.builderId,
    payload: {
      builder_id: input.builderId,
      provider: input.provider,
      account_id: v.account_id ?? null,
      // Never log credentials.
    },
  });

  return {
    ok: true,
    provider: input.provider,
    account_id: v.account_id,
    buying_power: v.buying_power,
    status: 'linked',
  };
}
