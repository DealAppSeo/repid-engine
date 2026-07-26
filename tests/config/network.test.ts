import { getActiveNetwork, NETWORKS } from '../../src/config/network';

describe('Network Config', () => {
  const originalEnv = process.env.NETWORK;

  afterEach(() => {
    process.env.NETWORK = originalEnv;
  });

  test('default is base-sepolia', () => {
    delete process.env.NETWORK;
    const config = getActiveNetwork();
    expect(config.chainId).toBe(84532);
    // CAIP-2 migration (2026-07-22, PR #178): x402 network param is the CAIP-2
    // chain id, not the human network name (the public x402.org facilitator re-keyed).
    expect(config.x402.networkParam).toBe('eip155:84532');
  });

  test('select base mainnet', () => {
    process.env.NETWORK = 'base';
    const config = getActiveNetwork();
    expect(config.chainId).toBe(8453);
    expect(config.x402.networkParam).toBe('eip155:8453');
  });

  test('throws on unknown network', () => {
    process.env.NETWORK = 'ethereum';
    expect(() => getActiveNetwork()).toThrow(/Unknown network: ethereum/);
  });
});
