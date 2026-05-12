import { X402OutboundClient } from '../../src/services/x402-outbound-client';
import { db } from '../../src/db';

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

describe('X402OutboundClient Circuit Breaker', () => {
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
        return Promise.resolve(new Response(JSON.stringify({
          accepts: [{
            network: 'base-sepolia',
            scheme: 'exact',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: '0x1111111111111111111111111111111111111111',
            maxAmountRequired: '50000'
          }]
        }), { status: 402 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
    });
  });

  it('should throw X402_CIRCUIT_BREAKER_ACTIVE if agent already tripped', async () => {
    (db.from as jest.Mock).mockImplementation((table) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { agent_name: 'test_agent', x402_circuit_breaker_tripped: true } })
            })
          })
        };
      }
      return {};
    });

    await expect(client.get('http://example.com/api', {
      agentId: 'test-agent',
      providerAgentId: 'provider',
      tipId: 'tip-1'
    })).rejects.toThrow('X402_CIRCUIT_BREAKER_ACTIVE');
  });

  it('should throw X402_CIRCUIT_BREAKER_TRIPPED and update agent when attempt count >= 5', async () => {
    const updateAgentMock = jest.fn().mockReturnValue({ eq: () => Promise.resolve() });
    
    (db.from as jest.Mock).mockImplementation((table) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { agent_name: 'test_agent', x402_circuit_breaker_tripped: false } })
            })
          }),
          update: updateAgentMock
        };
      }
      if (table === 'repid_config') {
        return {
          select: () => ({ in: () => Promise.resolve({ data: [] }) })
        };
      }
      if (table === 'repid_events') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ gte: () => Promise.resolve({ data: [] }) }) }) })
        };
      }
      if (table === 'x402_settlements') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { id: 1, status: 'failed', settlement_attempt_count: 5 } })
            })
          })
        };
      }
      return {};
    });

    await expect(client.get('http://example.com/api', {
      agentId: 'test-agent',
      providerAgentId: 'provider',
      tipId: 'tip-1'
    })).rejects.toThrow('X402_CIRCUIT_BREAKER_TRIPPED');

    expect(updateAgentMock).toHaveBeenCalledWith({
      x402_circuit_breaker_tripped: true,
      x402_circuit_breaker_reason: 'Failed settlement max attempts reached'
    });
  });
});
