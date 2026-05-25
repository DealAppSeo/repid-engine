import { getProvider, resetProviderCache } from '../../src/clients/rpc-with-failover';
import { getActiveNetwork } from '../../src/config/network';
import { ethers } from 'ethers';

jest.mock('../../src/config/network', () => {
  const original = jest.requireActual('../../src/config/network');
  return {
    ...original,
    getActiveNetwork: jest.fn(),
  };
});

describe('rpc-with-failover provider resolver', () => {
  const mockGetActiveNetwork = getActiveNetwork as jest.MockedFunction<typeof getActiveNetwork>;

  beforeEach(() => {
    jest.clearAllMocks();
    resetProviderCache();
  });

  it('throws an error if no RPC URLs are configured', () => {
    mockGetActiveNetwork.mockReturnValue({
      name: 'Test Network No RPC',
      chainId: 1234,
      rpcUrl: '',
      rpcUrls: [],
      contracts: {} as any,
      x402: {} as any,
    });

    expect(() => getProvider()).toThrow('No RPC URLs configured for network: Test Network No RPC');
  });

  it('returns a standard JsonRpcProvider when only one RPC URL is configured', () => {
    mockGetActiveNetwork.mockReturnValue({
      name: 'Single RPC Net',
      chainId: 1234,
      rpcUrl: 'https://single-rpc.test',
      rpcUrls: ['https://single-rpc.test'],
      contracts: {} as any,
      x402: {} as any,
    });

    const provider = getProvider();
    expect(provider).toBeInstanceOf(ethers.JsonRpcProvider);
    
    // Check caching works
    const provider2 = getProvider();
    expect(provider2).toBe(provider);
  });

  it('returns a FallbackProvider when multiple RPC URLs are configured', () => {
    mockGetActiveNetwork.mockReturnValue({
      name: 'Multi RPC Net',
      chainId: 1234,
      rpcUrl: 'https://rpc1.test',
      rpcUrls: ['https://rpc1.test', 'https://rpc2.test'],
      contracts: {} as any,
      x402: {} as any,
    });

    const provider = getProvider();
    expect(provider).toBeInstanceOf(ethers.FallbackProvider);
  });

  it('bypasses cache when forceNew is true or network changes', () => {
    mockGetActiveNetwork.mockReturnValue({
      name: 'Single RPC Net',
      chainId: 1234,
      rpcUrl: 'https://single-rpc.test',
      rpcUrls: ['https://single-rpc.test'],
      contracts: {} as any,
      x402: {} as any,
    });

    const provider1 = getProvider();
    const provider2 = getProvider(true);
    expect(provider1).toBeInstanceOf(ethers.JsonRpcProvider);
    expect(provider2).toBeInstanceOf(ethers.JsonRpcProvider);
    expect(provider1).not.toBe(provider2);

    mockGetActiveNetwork.mockReturnValue({
      name: 'Another RPC Net',
      chainId: 5678,
      rpcUrl: 'https://another-rpc.test',
      rpcUrls: ['https://another-rpc.test'],
      contracts: {} as any,
      x402: {} as any,
    });

    const provider3 = getProvider();
    expect(provider3).not.toBe(provider2);
  });
});
