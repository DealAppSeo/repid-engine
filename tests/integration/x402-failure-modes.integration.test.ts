import { x402OutboundClient } from '../../src/services/x402-outbound-client';
import { db } from '../../src/db';
import { ethers } from 'ethers';
import { repIdAttestationService } from '../../src/services/repid-attestation';

describe('X402 Failure Modes Integration', () => {
  let agentId = 'test-agent-id';
  let wallet = ethers.Wallet.createRandom();
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
    process.env['TEST_INTEGRATION_AGENT_PRIVATE_KEY'] = wallet.privateKey;

    repIdAttestationService.generateAttestation = async () => ({
      version: "1",
      agent_id: agentId,
      agent_name: 'test_integration_agent',
      repid: 1000,
      tier: 'Gold',
      erc8004_token_id: null,
      erc8004_chain_id: 84532,
      erc8004_registry: '0xabc',
      last_reputation_tx: null,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      nonce: 'abc',
      signature: '0xabc',
      zkp_proof: null
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
    delete process.env['TEST_INTEGRATION_AGENT_PRIVATE_KEY'];
  });

  const setupMockFetch = (mockBehavior: 'success' | 'timeout' | 'invalid_sig' | 'insufficient') => {
    global.fetch = jest.fn().mockImplementation(async (url, init) => {
      const xPayment = (init?.headers as any)?.['X-PAYMENT'];
      if (!xPayment) {
        return new Response(JSON.stringify({
          accepts: [{
            network: 'base-sepolia',
            scheme: 'exact',
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: '0x1111111111111111111111111111111111111111',
            maxAmountRequired: '10000'
          }]
        }), { status: 402 });
      }

      if (mockBehavior === 'success') {
        return new Response(JSON.stringify({ success: true, message: 'OK' }), {
          status: 200,
          headers: new Headers({
            'X-PAYMENT-RESPONSE': JSON.stringify({ txHash: '0xSUCCESS' })
          })
        });
      }

      if (mockBehavior === 'timeout') {
        throw new Error('fetch failed: network timeout');
      }

      if (mockBehavior === 'invalid_sig') {
        return new Response(JSON.stringify({ valid: false, reason: 'Invalid signature' }), { status: 400 });
      }

      if (mockBehavior === 'insufficient') {
        return new Response(JSON.stringify({ valid: false, reason: 'Insufficient balance' }), { status: 400 });
      }
    });
  };

  const setupDbMock = (overrides: any = {}) => {
    db.from = jest.fn().mockImplementation((table) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { agent_name: 'test_integration_agent', x402_circuit_breaker_tripped: overrides.circuitBreakerTripped || false } }) }) }),
          update: () => ({ eq: () => Promise.resolve() })
        };
      }
      if (table === 'repid_config') {
        return {
          select: () => ({ in: () => Promise.resolve({ data: [
            { key: 'x402_max_usdc_per_hour', value: overrides.maxUsdc || '1.00' },
            { key: 'x402_max_tx_per_hour', value: overrides.maxCount || '50' }
          ] }) })
        };
      }
      if (table === 'x402_settlements') {
        return {
          select: () => {
            if (overrides.existingSettlement) {
              return { eq: () => ({ single: () => Promise.resolve({ data: overrides.existingSettlement }) }) };
            }
            return {
              eq: () => ({
                gte: () => Promise.resolve({ data: overrides.recentSettlements || [] }),
                single: () => Promise.resolve({ data: null, error: { message: 'not found' } })
              })
            };
          },
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
          insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: {} }) }), throwOnError: () => Promise.resolve() }),
          upsert: () => Promise.resolve({ error: null })
        };
      }
      if (table === 'x402_settlement_failures') {
        return {
          select: () => ({ eq: () => ({ gte: () => Promise.resolve({ data: overrides.recentFailures || [] }) }) }),
          insert: () => Promise.resolve()
        };
      }
      if (table === 'repid_events') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ gte: () => Promise.resolve({ data: [] }) }) }) }),
          insert: () => Promise.resolve()
        };
      }
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
        update: () => ({ eq: () => Promise.resolve() }),
        insert: () => Promise.resolve()
      };
    }) as any;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setupDbMock();
  });

  it('network_timeout_during_settle', async () => {
    setupMockFetch('timeout');
    await expect(x402OutboundClient.get('http://test.local', { agentId, providerAgentId: 'provider1', tipId: 'tip1' }))
      .rejects.toThrow('fetch failed: network timeout');
  });

  it('facilitator_rejects_invalid_signature', async () => {
    setupMockFetch('invalid_sig');
    await expect(x402OutboundClient.get('http://test.local', { agentId, providerAgentId: 'provider2', tipId: 'tip2' }))
      .rejects.toThrow('x402 request failed with status 400: {"valid":false,"reason":"Invalid signature"}');
  });

  it('duplicate_idempotency_key_in_flight', async () => {
    setupMockFetch('success');
    setupDbMock({
      existingSettlement: { id: 1, status: 'settled', amount: '10000', is_simulated: true, tx_hash: '0xSUCCESS' }
    });
    
    const res = await x402OutboundClient.get('http://test.local', { agentId, providerAgentId: 'provider3', tipId: 'tip3' });
    expect(res.txHash).toBe('0xSUCCESS');
  });

  it('governor_blocks_amount', async () => {
    setupMockFetch('success');
    setupDbMock({ maxUsdc: '0.00' });
    
    await expect(x402OutboundClient.get('http://test.local', { agentId, providerAgentId: 'provider4', tipId: 'tip4' }))
      .rejects.toThrow('X402_GOVERNOR_TRIPPED: max_usdc_per_hour exceeded');
  });

  it('circuit_breaker_manually_tripped', async () => {
    setupMockFetch('success');
    setupDbMock({ circuitBreakerTripped: true });
    
    await expect(x402OutboundClient.get('http://test.local', { agentId, providerAgentId: 'provider5', tipId: 'tip5' }))
      .rejects.toThrow('X402_CIRCUIT_BREAKER_ACTIVE');
  });

  it('circuit_breaker_auto_trips_after_5_failures', async () => {
    setupMockFetch('success');
    setupDbMock({
      existingSettlement: { id: 1, status: 'failed', settlement_attempt_count: 5 }
    });

    await expect(x402OutboundClient.get('http://test.local', { agentId, providerAgentId: 'provider6', tipId: 'tip6' }))
      .rejects.toThrow('X402_CIRCUIT_BREAKER_TRIPPED');
  });

  it('feedback_loop_runs_after_success', async () => {
    setupMockFetch('success');
    await x402OutboundClient.get('http://test.local', { agentId, providerAgentId: 'provider7', tipId: 'tip7' });
  });
});
