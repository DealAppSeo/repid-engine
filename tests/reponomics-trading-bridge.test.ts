/**
 * Reponomics — trading bridge tests.
 *
 * Verifies:
 *   - factory returns the correct adapter per provider name
 *   - alpaca-mcp stub returns ok=false with an MCP-not-implemented error
 *   - alpaca-rest is a thin wrapper over fetch (fetch is mocked)
 *   - encryption round-trips credentials
 */

import { getTradingBridge, isMcpNotImplemented } from '../src/services/trading-bridge/factory';
import { AlpacaRestBridge } from '../src/services/trading-bridge/alpaca-rest';
import { AlpacaMcpBridge } from '../src/services/trading-bridge/alpaca-mcp';
import { encryptCredentials, decryptCredentials } from '../src/services/trading-creds-crypto';

describe('trading-bridge factory', () => {
  it('returns AlpacaRestBridge for alpaca_rest', () => {
    const b = getTradingBridge('alpaca_rest');
    expect(b).toBeInstanceOf(AlpacaRestBridge);
    expect(b.getProviderName()).toBe('alpaca_rest');
  });
  it('returns AlpacaMcpBridge for alpaca_mcp', () => {
    const b = getTradingBridge('alpaca_mcp');
    expect(b).toBeInstanceOf(AlpacaMcpBridge);
    expect(b.getProviderName()).toBe('alpaca_mcp');
  });
  it('throws on unknown provider', () => {
    expect(() => getTradingBridge('alpaca_smart_contract' as any)).toThrow();
  });
});

describe('alpaca-mcp stub', () => {
  const bridge = new AlpacaMcpBridge();
  const creds = { api_key: 'k', secret_key: 's' };

  it('validateCredentials returns ok=false with not-implemented', async () => {
    const r = await bridge.validateCredentials(creds);
    expect(r.ok).toBe(false);
    expect(isMcpNotImplemented(r.error)).toBe(true);
  });
  it('placeOrder returns ok=false with not-implemented', async () => {
    const r = await bridge.placeOrder({ agent_id: 'a', symbol: 'AAPL', qty: 1, side: 'buy', type: 'market', credentials: creds });
    expect(r.ok).toBe(false);
    expect(isMcpNotImplemented(r.error)).toBe(true);
  });
  it('getAccount returns ok=false with not-implemented', async () => {
    const r = await bridge.getAccount(creds);
    expect(r.ok).toBe(false);
    expect(isMcpNotImplemented(r.error)).toBe(true);
  });
});

describe('alpaca-rest bridge (mocked fetch)', () => {
  const bridge = new AlpacaRestBridge();
  const creds = { api_key: 'k', secret_key: 's' };
  const origFetch = (globalThis as any).fetch;

  afterEach(() => { (globalThis as any).fetch = origFetch; });

  it('validateCredentials hits /account and returns account_id + buying_power', async () => {
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'acct-1', buying_power: '100000' }),
    }));
    const r = await bridge.validateCredentials(creds);
    expect(r.ok).toBe(true);
    expect(r.account_id).toBe('acct-1');
    expect(r.buying_power).toBe('100000');
  });

  it('validateCredentials returns ok=false on 401', async () => {
    (globalThis as any).fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'invalid creds' }),
    }));
    const r = await bridge.validateCredentials(creds);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid|401/i);
  });

  it('placeOrder posts a JSON body with symbol/qty/side/type', async () => {
    let captured: any = null;
    (globalThis as any).fetch = jest.fn(async (_url: string, init: any) => {
      captured = init;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'order-1', status: 'new' }),
      };
    });
    const r = await bridge.placeOrder({ agent_id: 'a', symbol: 'AAPL', qty: 5, side: 'buy', type: 'market', credentials: creds });
    expect(r.ok).toBe(true);
    expect(r.order_id).toBe('order-1');
    expect(r.is_simulated).toBe(false);
    const body = JSON.parse(captured.body);
    expect(body.symbol).toBe('AAPL');
    expect(body.qty).toBe('5');
    expect(body.side).toBe('buy');
    expect(body.type).toBe('market');
  });
});

describe('trading credentials encryption', () => {
  it('round-trips via AES-GCM', () => {
    const creds = { api_key: 'AKEY-12345', secret_key: 'SEKRET-67890' };
    const blob = encryptCredentials(creds);
    expect(blob.v).toBe(1);
    expect(blob.iv).toBeTruthy();
    expect(blob.tag).toBeTruthy();
    expect(blob.ciphertext).toBeTruthy();
    const back = decryptCredentials(blob);
    expect(back).toEqual(creds);
  });

  it('two encryptions of the same creds use different IVs', () => {
    const creds = { api_key: 'k', secret_key: 's' };
    const a = encryptCredentials(creds);
    const b = encryptCredentials(creds);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('throws on tampered ciphertext', () => {
    const blob = encryptCredentials({ api_key: 'k', secret_key: 's' });
    const tampered = { ...blob, ciphertext: 'AAAA' + blob.ciphertext.slice(4) };
    expect(() => decryptCredentials(tampered)).toThrow();
  });
});
