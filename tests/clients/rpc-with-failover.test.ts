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

  it('fails over from failing primary RPC to succeeding backup RPC without manual intervention', async () => {
    // In ethers v6, FallbackProvider orchestrates over standard JsonRpcProviders.
    // We mock the send method on JsonRpcProvider to simulate failure on primary and success on backup.
    
    // We stub getNetwork and send to simulate failing primary
    const mockPrimary = new ethers.JsonRpcProvider('https://failing-rpc.test', undefined, { staticNetwork: true });
    jest.spyOn(mockPrimary, 'send').mockRejectedValue(new Error('primary RPC failed'));
    jest.spyOn(mockPrimary, 'getNetwork').mockRejectedValue(new Error('primary RPC network failure'));

    // We stub getNetwork and send to simulate succeeding backup
    const mockBackup = new ethers.JsonRpcProvider('https://succeeding-rpc.test', undefined, { staticNetwork: true });
    jest.spyOn(mockBackup, 'send').mockImplementation(async (method: string) => {
      if (method === 'eth_blockNumber') {
        return '0x64'; // block 100 in hex
      }
      if (method === 'eth_chainId') {
        return '0x3039'; // chainId 12345 in hex
      }
      throw new Error(`unmocked send method: ${method}`);
    });
    jest.spyOn(mockBackup, 'getNetwork').mockResolvedValue(new ethers.Network('backup-net', 12345n));

    // Instantiate FallbackProvider with mock providers
    const fallbackProvider = new ethers.FallbackProvider([mockPrimary, mockBackup]);
    
    // Call getBlockNumber, which triggers eth_blockNumber call
    const blockNumber = await fallbackProvider.getBlockNumber();
    expect(blockNumber).toBe(100);
  });
});
