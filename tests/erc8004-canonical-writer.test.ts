import { writeRepIDCanonical } from '../src/services/erc8004-canonical-writer';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

jest.mock('ethers');
jest.mock('@supabase/supabase-js');

describe('ERC-8004 Canonical Writer', () => {
  let mockDb: any;
  let mockContract: any;
  let mockWait: jest.Mock;
  let originalNodeEnv: string | undefined;
  
  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    process.env.APM_PRIVATE_KEY = '0x1234';
    
    mockWait = jest.fn().mockResolvedValue({ status: 1 });
    
    mockContract = {
      giveFeedback: jest.fn().mockResolvedValue({
        hash: '0xabc123',
        wait: mockWait
      })
    };
    
    (ethers.Contract as unknown as jest.Mock).mockImplementation(() => mockContract);
    
    mockDb = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue({
        data: [{ canonical_agent_id: '1585' }],
        error: null
      })
    };
    
    (createClient as jest.Mock).mockReturnValue(mockDb);
  });
  
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    jest.clearAllMocks();
  });
  
  it('should return success with tx_hash and basescan_url', async () => {
    const result = await writeRepIDCanonical('APM', 85.5);
    
    expect(result.status).toBe('success');
    expect(result.tx_hash).toBe('0xabc123');
    expect(result.basescan_url).toBe('https://sepolia.basescan.org/tx/0xabc123');
    expect(mockContract.giveFeedback).toHaveBeenCalledTimes(1);
  });
  
  it('should return pending_retry on network failure after retry', async () => {
    mockContract.giveFeedback.mockRejectedValue(new Error('network error occurred'));
    
    const result = await writeRepIDCanonical('APM', 85.5);
    
    expect(result.status).toBe('pending_retry');
    expect(result.error).toContain('network error');
    expect(mockContract.giveFeedback).toHaveBeenCalledTimes(2); // Initial + 1 retry
  });
  
  it('should return failed on contract revert after retry', async () => {
    mockContract.giveFeedback.mockRejectedValue(new Error('execution reverted'));
    
    const result = await writeRepIDCanonical('APM', 85.5);
    
    expect(result.status).toBe('failed');
    expect(result.error).toContain('execution reverted');
    expect(mockContract.giveFeedback).toHaveBeenCalledTimes(2); // Initial + 1 retry
  });
});
