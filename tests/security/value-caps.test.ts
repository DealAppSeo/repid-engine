import request from 'supertest';
import app from '../../src/index';
import { db } from '../../src/db';

// Mock database calls
jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
  }
}));

// Mock authentication middleware
jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
    next();
  }
}));

describe('Mainnet Value Caps Enforcement', () => {
  const originalEnvNetwork = process.env.NETWORK;
  const originalX402Enforcement = process.env.X402_ENFORCEMENT_ENABLED;
  const originalRealRpc = process.env.X402_REAL_RPC;

  beforeAll(() => {
    process.env.X402_ENFORCEMENT_ENABLED = 'true';
    process.env.X402_REAL_RPC = ''; // simulated mode
  });

  afterAll(() => {
    process.env.NETWORK = originalEnvNetwork;
    process.env.X402_ENFORCEMENT_ENABLED = originalX402Enforcement;
    process.env.X402_REAL_RPC = originalRealRpc;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NETWORK = 'base';
    process.env.MAINNET_PER_CONTRACT_USD_CAP = '10';
    process.env.MAINNET_DAILY_VOLUME_USD_CAP = '100';
    process.env.MAINNET_PER_AGENT_DAILY_TX_CAP = '5';
  });

  const mockDbForEscrow = (opts: {
    contractPrice: number;
    contractStatus: string;
    existingSettlement: any;
    settledToday: any[];
    agentTxCount: number;
  }) => {
    let mockSelectCallCount = 0;
    jest.spyOn(db, 'from').mockImplementation((table: string) => {
      if (table === 'service_contracts') {
        return {
          select: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: {
              id: 'test-contract',
              status: opts.contractStatus,
              agreed_price_usdc_raw: opts.contractPrice,
              provider_agent_id: 'provider-123',
              buyer_agent_id: 'buyer-456',
            },
            error: null,
          }),
          single: jest.fn().mockResolvedValue({
            data: {
              id: 'test-contract',
              status: 'escrowed',
              x402_payment_id: 'settlement-123',
            },
            error: null,
          }),
        } as any;
      }
      if (table === 'repid_agents') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: { wallet_address: '0xProviderWallet' },
            error: null,
          }),
        } as any;
      }
      if (table === 'x402_settlements') {
        return {
          select: jest.fn().mockImplementation(() => {
            mockSelectCallCount++;
            return {
              eq: jest.fn().mockReturnThis(),
              maybeSingle: jest.fn().mockResolvedValue({
                data: opts.existingSettlement,
                error: null,
              }),
              single: jest.fn().mockResolvedValue({
                data: { id: 'settlement-123' },
                error: null,
              }),
              gte: jest.fn().mockReturnThis(),
              lte: jest.fn().mockImplementation(() => {
                // If it's the daily volume check
                if (mockSelectCallCount === 2) {
                  return Promise.resolve({ data: opts.settledToday, error: null });
                }
                // If it's the per-agent daily transaction cap check
                return Promise.resolve({ count: opts.agentTxCount, error: null });
              }),
            } as any;
          }),
          insert: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: { id: 'settlement-123' },
            error: null,
          }),
        } as any;
      }
      return {
        upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
        insert: jest.fn().mockResolvedValue({ data: null, error: null }),
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
      } as any;
    });
  };

  it('allows escrow to pass when under all caps', async () => {
    mockDbForEscrow({
      contractPrice: 5000000, // $5
      contractStatus: 'pending',
      existingSettlement: null,
      settledToday: [],
      agentTxCount: 0,
    });

    const res = await request(app)
      .post('/api/v1/contracts/test-contract/escrow')
      .set('X-PAYMENT', 'simulated-payment-header');

    if (res.status !== 200) console.log('ERROR BODY:', res.text);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('escrowed');
  });

  it('rejects escrow (400) when per-contract cap is exceeded', async () => {
    mockDbForEscrow({
      contractPrice: 15000000, // $15 (cap is $10)
      contractStatus: 'pending',
      existingSettlement: null,
      settledToday: [],
      agentTxCount: 0,
    });

    const res = await request(app)
      .post('/api/v1/contracts/test-contract/escrow')
      .set('X-PAYMENT', 'simulated-payment-header');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('per_contract_cap_exceeded');
    expect(res.body.cap).toBe(10);
    expect(res.body.requested).toBe(15);
  });

  it('rejects escrow (429) when daily volume cap is exceeded', async () => {
    mockDbForEscrow({
      contractPrice: 8000000, // $8
      contractStatus: 'pending',
      existingSettlement: null,
      settledToday: [
        { amount: 50000000 }, // $50
        { amount: 45000000 }, // $45 -> Total $95 + $8 = $103 (exceeds $100 cap)
      ],
      agentTxCount: 0,
    });

    const res = await request(app)
      .post('/api/v1/contracts/test-contract/escrow')
      .set('X-PAYMENT', 'simulated-payment-header');

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('daily_volume_cap_exceeded');
    expect(res.body.cap).toBe(100);
    expect(res.body.todays_volume).toBe(95);
    expect(res.body.attempted).toBe(8);
  });

  it('rejects escrow (429) when per-agent daily transaction cap is exceeded', async () => {
    mockDbForEscrow({
      contractPrice: 5000000, // $5
      contractStatus: 'pending',
      existingSettlement: null,
      settledToday: [],
      agentTxCount: 5, // cap is 5
    });

    const res = await request(app)
      .post('/api/v1/contracts/test-contract/escrow')
      .set('X-PAYMENT', 'simulated-payment-header');

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('per_agent_daily_tx_cap_exceeded');
    expect(res.body.cap).toBe(5);
    expect(res.body.todays_count).toBe(5);
  });

  it('bypasses safety caps when network is base-sepolia (testnet)', async () => {
    process.env.NETWORK = 'base-sepolia';

    mockDbForEscrow({
      contractPrice: 999000000, // $999 (should pass since no caps configured for sepolia)
      contractStatus: 'pending',
      existingSettlement: null,
      settledToday: [],
      agentTxCount: 0,
    });

    const res = await request(app)
      .post('/api/v1/contracts/test-contract/escrow')
      .set('X-PAYMENT', 'simulated-payment-header');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('escrowed');
  });
});
