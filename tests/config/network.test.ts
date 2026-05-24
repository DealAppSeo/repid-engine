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
    expect(config.x402.networkParam).toBe('base-sepolia');
  });

  test('select base mainnet', () => {
    process.env.NETWORK = 'base';
    const config = getActiveNetwork();
    expect(config.chainId).toBe(8453);
    expect(config.x402.networkParam).toBe('base');
  });

  test('throws on unknown network', () => {
    process.env.NETWORK = 'ethereum';
    expect(() => getActiveNetwork()).toThrow(/Unknown network: ethereum/);
  });
});
