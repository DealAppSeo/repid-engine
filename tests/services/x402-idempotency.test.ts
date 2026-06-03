import { X402OutboundClient } from '../../src/services/x402-outbound-client';
import { db } from '../../src/db';
import crypto from 'crypto';
import { repIdAttestationService } from '../../src/services/repid-attestation';
import { ethers } from 'ethers';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn()
  }
}));


describe('X402OutboundClient Idempotency', () => {
  let client: X402OutboundClient;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    client = new X402OutboundClient();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    process.env['SOPHIA_PRIVATE_KEY'] = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    jest.spyOn(repIdAttestationService, 'generateAttestation').mockResolvedValue({ valid: true } as any);
    jest.spyOn(repIdAttestationService, 'verifyAttestation').mockResolvedValue({ valid: true } as any);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  const setupMocks = (existingSettlement: any = null) => {
    mockFetch.mockResolvedValueOnce({
      status: 402,
      json: jest.fn().mockResolvedValue({
        accepts: [{ network: 'base-sepolia', scheme: 'exact', maxAmountRequired: '100', asset: '0x0000000000000000000000000000000000000000', payTo: '0x0000000000000000000000000000000000000000' }]
      })
    });
    
    if (!existingSettlement || existingSettlement.status === 'failed') {
      mockFetch.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: jest.fn().mockResolvedValue({ success: true }),
        headers: new Headers()
      });
    }

    const mockDbFrom = jest.fn((table: string) => {
      if (table === 'repid_agents') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: { agent_name: 'sophia' } })
        };
      }
      if (table === 'repid_config') {
        return {
          select: jest.fn().mockReturnThis(),
          in: jest.fn().mockResolvedValue({ data: [] })
        };
      }
      if (table === 'x402_settlements') {
        const updateMock = jest.fn().mockReturnThis();
        return {
          select: jest.fn().mockReturnThis(),
          update: updateMock,
          eq: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: existingSettlement }),
          upsert: jest.fn().mockResolvedValue({}),
          insert: jest.fn().mockResolvedValue({}),
          _getUpdateMock: () => updateMock
        };
      }
      if (table === 'x402_settlement_failures') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gte: jest.fn().mockResolvedValue({ data: [] })
        };
      }
      if (table === 'repid_events') {
        return { 
          insert: jest.fn().mockResolvedValue({}),
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gte: jest.fn().mockResolvedValue({ data: [] })
        };
      }
      return {};
    });
    (db.from as jest.Mock).mockImplementation(mockDbFrom);
  };

  const getExpectedHash = (req: string, prov: string, tip: string) => {
    const wallet = new ethers.Wallet('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    return crypto.createHash('sha256').update(`${req}:${prov}:${tip}:100:0x0000000000000000000000000000000000000000:${wallet.address}`).digest('hex');
  };

  it('generates the same key for same inputs (deterministic)', async () => {
    setupMocks();
    const res = await client.get('http://test', { agentId: 'req1', providerAgentId: 'prov1', tipId: 'tip1' });
    expect(res.idempotencyKey).toBeDefined();
    expect(res.idempotencyKey).toEqual(getExpectedHash('req1', 'prov1', 'tip1'));
  });

  it('generates different key for different requestor', async () => {
    setupMocks();
    const res = await client.get('http://test', { agentId: 'req2', providerAgentId: 'prov1', tipId: 'tip1' });
    expect(res.idempotencyKey).toEqual(getExpectedHash('req2', 'prov1', 'tip1'));
  });

  it('generates different key for different tip_id', async () => {
    setupMocks();
    const res = await client.get('http://test', { agentId: 'req1', providerAgentId: 'prov1', tipId: 'tip2' });
    expect(res.idempotencyKey).toEqual(getExpectedHash('req1', 'prov1', 'tip2'));
  });

  it('Retry with existing pending settlement returns existing, no double-payment', async () => {
    setupMocks({ id: 'settle1', status: 'pending', tx_hash: '0xabc' });
    const res = await client.get('http://test', { agentId: 'req1', providerAgentId: 'prov1', tipId: 'tip1' });
    expect(res.data).toHaveProperty('status', 'pending');
    expect(res.txHash).toEqual('0xabc');
    expect(mockFetch).toHaveBeenCalledTimes(1); 
  });

  it('Retry with existing failed settlement increments attempt count', async () => {
    setupMocks({ id: 'settle1', status: 'failed', settlement_attempt_count: 1 });
    await client.get('http://test', { agentId: 'req1', providerAgentId: 'prov1', tipId: 'tip1' });
    expect(mockFetch).toHaveBeenCalledTimes(2); 
  });
});
