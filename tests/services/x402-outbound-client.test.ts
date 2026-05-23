import { resolveAndVerifyDomain, domainCache, computeDomainSeparator } from '../../src/services/x402-outbound-client';
import { ethers } from 'ethers';

jest.mock('ethers', () => {
  const actualEthers = jest.requireActual('ethers');
  const mockContract = jest.fn();
  return {
    ...actualEthers,
    ethers: {
      ...actualEthers.ethers,
      Contract: mockContract
    },
    Contract: mockContract
  };
});

describe('x402-outbound-client domain resolution (P-A)', () => {
  const USDC_ADDRESS = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
  const MAINNET_USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  let mockProvider: any;

  beforeEach(() => {
    domainCache.clear();
    jest.clearAllMocks();

    mockProvider = {};
  });

  it('resolves Base Sepolia USDC to name="USDC"', async () => {
    const mockName = jest.fn().mockResolvedValue('USDC');
    const mockVersion = jest.fn().mockResolvedValue('2');
    const expectedSeparator = computeDomainSeparator('USDC', '2', 84532, USDC_ADDRESS);
    const mockDomainSeparator = jest.fn().mockResolvedValue(expectedSeparator);

    (ethers.Contract as unknown as jest.Mock).mockImplementation(() => ({
      name: mockName,
      version: mockVersion,
      DOMAIN_SEPARATOR: mockDomainSeparator
    }));

    const result = await resolveAndVerifyDomain(USDC_ADDRESS, 84532, mockProvider);
    expect(result.name).toBe('USDC');
    expect(result.version).toBe('2');
    expect(result.domainSeparator.toLowerCase()).toBe(expectedSeparator.toLowerCase());
    expect(mockName).toHaveBeenCalledTimes(1);
  });

  it('resolves mainnet USDC to name="USD Coin"', async () => {
    const mockName = jest.fn().mockResolvedValue('USD Coin');
    const mockVersion = jest.fn().mockResolvedValue('2');
    const expectedSeparator = computeDomainSeparator('USD Coin', '2', 1, MAINNET_USDC_ADDRESS);
    const mockDomainSeparator = jest.fn().mockResolvedValue(expectedSeparator);

    (ethers.Contract as unknown as jest.Mock).mockImplementation(() => ({
      name: mockName,
      version: mockVersion,
      DOMAIN_SEPARATOR: mockDomainSeparator
    }));

    const result = await resolveAndVerifyDomain(MAINNET_USDC_ADDRESS, 1, mockProvider);
    expect(result.name).toBe('USD Coin');
    expect(result.version).toBe('2');
    expect(result.domainSeparator.toLowerCase()).toBe(expectedSeparator.toLowerCase());
  });

  it('throws if domain separator mismatch', async () => {
    const mockName = jest.fn().mockResolvedValue('USDC');
    const mockVersion = jest.fn().mockResolvedValue('2');
    const mockDomainSeparator = jest.fn().mockResolvedValue('0xbadbeef000000000000000000000000000000000000000000000000000000000');

    (ethers.Contract as unknown as jest.Mock).mockImplementation(() => ({
      name: mockName,
      version: mockVersion,
      DOMAIN_SEPARATOR: mockDomainSeparator
    }));

    await expect(resolveAndVerifyDomain(USDC_ADDRESS, 84532, mockProvider)).rejects.toThrow(
      'Domain separator mismatch'
    );
  });

  it('caches per chain+address with TTL', async () => {
    const mockName = jest.fn().mockResolvedValue('USDC');
    const mockVersion = jest.fn().mockResolvedValue('2');
    const expectedSeparator = computeDomainSeparator('USDC', '2', 84532, USDC_ADDRESS);
    const mockDomainSeparator = jest.fn().mockResolvedValue(expectedSeparator);

    (ethers.Contract as unknown as jest.Mock).mockImplementation(() => ({
      name: mockName,
      version: mockVersion,
      DOMAIN_SEPARATOR: mockDomainSeparator
    }));

    // Call first time
    const result1 = await resolveAndVerifyDomain(USDC_ADDRESS, 84532, mockProvider);
    // Call second time (should hit cache)
    const result2 = await resolveAndVerifyDomain(USDC_ADDRESS, 84532, mockProvider);

    expect(result1).toEqual(result2);
    expect(mockName).toHaveBeenCalledTimes(1); // Only called once!
  });
});
