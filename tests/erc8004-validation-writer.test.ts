import { submitValidation } from '../src/services/erc8004-validation-writer';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

jest.mock('ethers');
jest.mock('@supabase/supabase-js');

describe('erc8004-validation-writer', () => {
  const mockFrom = jest.fn();
  const mockInsert = jest.fn();
  const mockSelect = jest.fn();
  const mockEq = jest.fn();
  const mockLimit = jest.fn();

  beforeEach(() => {
    process.env.APM_PRIVATE_KEY = '0x123';
    
    (createClient as jest.Mock).mockReturnValue({
      from: mockFrom
    });

    mockFrom.mockReturnValue({
      select: mockSelect,
      insert: mockInsert
    });

    mockSelect.mockReturnValue({
      eq: mockEq
    });

    mockEq.mockReturnValue({
      limit: mockLimit
    });

    mockLimit.mockResolvedValue({
      data: [{ canonical_agent_id: '123' }],
      error: null
    });

    mockInsert.mockResolvedValue({
      error: null
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('handles happy path correctly', async () => {
    const mockWait = jest.fn().mockResolvedValue({});
    const mockSubmit = jest.fn().mockResolvedValue({
      hash: '0xabc',
      wait: mockWait
    });

    (ethers.Contract as jest.Mock).mockImplementation(() => ({
      submitValidationTask: mockSubmit
    }));

    const result = await submitValidation('APM', '456', '0xresponsehash', 'ipfs://data');
    
    expect(result.status).toBe('success');
    expect(result.tx_hash).toBe('0xabc');
    expect(result.basescan_url).toContain('0xabc');
    expect(mockInsert).toHaveBeenCalled();
  });

  it('returns pending_retry on network failure', async () => {
    const mockSubmit = jest.fn().mockRejectedValue({ code: 'NETWORK_ERROR', message: 'network down' });

    (ethers.Contract as jest.Mock).mockImplementation(() => ({
      submitValidationTask: mockSubmit
    }));

    const result = await submitValidation('APM', '456', '0xresponsehash', 'ipfs://data');
    
    expect(result.status).toBe('pending_retry');
    expect(result.error).toContain('network down');
  });

  it('returns failed on contract revert', async () => {
    const mockSubmit = jest.fn().mockRejectedValue(new Error('execution reverted'));

    (ethers.Contract as jest.Mock).mockImplementation(() => ({
      submitValidationTask: mockSubmit
    }));

    const result = await submitValidation('APM', '456', '0xresponsehash', 'ipfs://data');
    
    expect(result.status).toBe('failed');
    expect(result.error).toContain('execution reverted');
  });

  it('handles missing private key gracefully', async () => {
    delete process.env.APM_PRIVATE_KEY;
    const result = await submitValidation('APM', '456', '0xresponsehash', 'ipfs://data');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Missing private key');
  });
});
