import { X402OutboundClient } from '../../src/services/x402-outbound-client';
import { db } from '../../src/db';
import { repIdAttestationService } from '../../src/services/repid-attestation';
import { ethers } from 'ethers';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn()
  }
}));

jest.mock('../../src/services/repid-attestation', () => ({
  repIdAttestationService: {
    generateAttestation: jest.fn().mockResolvedValue({
      agent_id: 'test-agent',
      repid: 1000,
      tier: 'Gold',
      signature: '0xabc'
    }),
    verifyAttestation: jest.fn().mockResolvedValue({ valid: true })
  }
}));

describe('X402OutboundClient Governor', () => {
  let client: X402OutboundClient;
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    client = new X402OutboundClient();
    originalFetch = global.fetch;
    process.env.TEST_AGENT_PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  });

  afterAll(() => {
    global.fetch = originalFetch;
    delete process.env.TEST_AGENT_PRIVATE_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    
    global.fetch = jest.fn().mockImplementation((url, init) => {
      if (!init?.headers?.['X-PAYMENT']) {
        // Initial 402
        return Promise.resolve(new Response(JSON.stringify({
          accepts: [{
            // CAIP-2 (2026-07-22): offer.network must equal netConfig.x402.networkParam
            // (eip155:84532), else the client rejects it as "no compatible offer".
            network: 'eip155:84532',
            scheme: 'exact',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: '0x1111111111111111111111111111111111111111',
            maxAmountRequired: '50000' // 0.05 USDC
          }]
        }), { status: 402 }));
      } else {
        // Payment accepted
        return Promise.resolve(new Response(JSON.stringify({
          success: true,
          data: 'secret'
        }), { 
          status: 200,
          headers: new Headers({
            'X-PAYMENT-RESPONSE': JSON.stringify({ txHash: '0x123' })
          })
        }));
      }
    });
  });

  it('should throw X402_GOVERNOR_TRIPPED when tx count exceeds max_tx_per_hour', async () => {
    (db.from as jest.Mock).mockImplementation((table) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { agent_name: 'test_agent' } })
            })
          })
        };
      }
      if (table === 'repid_config') {
        return {
          select: () => ({
            in: () => Promise.resolve({
              data: [
                { key: 'x402_max_usdc_per_hour', value: '1.00' },
                { key: 'x402_max_tx_per_hour', value: '2' } // Limit of 2
              ]
            })
          })
        };
      }
      if (table === 'repid_events') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => Promise.resolve({
                  data: [
                    { event_data: { amount: '100000' } },
                    { event_data: { amount: '100000' } }
                  ]
                })
              })
            })
          })
        };
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) };
    });

    await expect(client.get('http://example.com/api', {
      agentId: 'test-agent',
      providerAgentId: 'provider-agent',
      tipId: 'tip-1'
    })).rejects.toThrow('X402_GOVERNOR_TRIPPED: max_tx_per_hour exceeded');
  });

  it('should throw X402_GOVERNOR_TRIPPED when amount exceeds max_usdc_per_hour', async () => {
    (db.from as jest.Mock).mockImplementation((table) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { agent_name: 'test_agent' } })
            })
          })
        };
      }
      if (table === 'repid_config') {
        return {
          select: () => ({
            in: () => Promise.resolve({
              data: [
                { key: 'x402_max_usdc_per_hour', value: '1.00' }, // Limit 1.00
                { key: 'x402_max_tx_per_hour', value: '50' }
              ]
            })
          })
        };
      }
      if (table === 'repid_events') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => Promise.resolve({
                  data: [
                    { event_data: { amount: '960000' } } // 0.96 USDC already spent + 0.05 current = 1.01 USDC (exceeds 1.00)
                  ]
                })
              })
            })
          })
        };
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) };
    });

    await expect(client.get('http://example.com/api', {
      agentId: 'test-agent',
      providerAgentId: 'provider-agent',
      tipId: 'tip-2'
    })).rejects.toThrow('X402_GOVERNOR_TRIPPED: max_usdc_per_hour exceeded');
  });

  it('should pass if within governor limits', async () => {
    (db.from as jest.Mock).mockImplementation((table) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { agent_name: 'test_agent' } })
            })
          })
        };
      }
      if (table === 'repid_config') {
        return {
          select: () => ({
            in: () => Promise.resolve({
              data: [
                { key: 'x402_max_usdc_per_hour', value: '1.00' },
                { key: 'x402_max_tx_per_hour', value: '50' }
              ]
            })
          })
        };
      }
      if (table === 'repid_events') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => Promise.resolve({
                  data: [
                    { event_data: { amount: '100000' } } // 0.1 USDC already spent + 0.05 current = 0.15 USDC (within 1.00)
                  ]
                })
              })
            })
          }),
          insert: () => Promise.resolve({ data: null })
        };
      }
      if (table === 'x402_settlements') {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
          insert: () => ({}),
          upsert: () => Promise.resolve({ data: null })
        };
      }
      return { insert: () => ({}) }; // repid_events insert
    });

    const res = await client.get('http://example.com/api', {
      agentId: 'test-agent',
      providerAgentId: 'provider-agent',
      tipId: 'tip-3'
    });

    expect(res.data).toEqual({ success: true, data: 'secret' });
    expect(res.txHash).toBe('0x123');
  });
});
