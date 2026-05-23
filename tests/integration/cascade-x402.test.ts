import { db } from '../../src/db';
import { processCascadeQueue } from '../../src/index';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis()
  }
}));

describe('processCascadeQueue x402 enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    delete process.env.X402_ENFORCEMENT_ENABLED;
  });

  test('enforcement off: pending contract without payment advances', async () => {
    process.env.X402_ENFORCEMENT_ENABLED = 'false';

    const mockUpdateMaybeSingle = jest.fn().mockResolvedValue({ data: { id: 'contract-123' }, error: null });

    jest.spyOn(db, 'from').mockImplementation((table) => {
      if (table === 'service_contracts') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gt: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          // Mock return list of pending contracts
          then: (resolve: any) => resolve({
            data: [
              {
                id: 'contract-123',
                service_id: 'service-123',
                buyer_agent_id: 'buyer-123',
                agreed_price_usdc_raw: 10000,
                payload: { service_type: 'test-service' },
                expires_at: new Date(Date.now() + 10000).toISOString(),
                created_at: new Date().toISOString(),
                agent_services: {
                  service_type: 'test-service',
                  active: true,
                  min_repid_to_purchase: 0
                }
              }
            ],
            error: null
          }),
          update: jest.fn().mockReturnThis(),
          maybeSingle: mockUpdateMaybeSingle
        } as any;
      }
      return {} as any;
    });

    await processCascadeQueue();

    // Verify update was called to transition status to escrowed
    expect(mockUpdateMaybeSingle).toHaveBeenCalled();
  });

  test('enforcement on: pending contract without payment STAYS pending', async () => {
    process.env.X402_ENFORCEMENT_ENABLED = 'true';

    const mockNot = jest.fn().mockReturnThis();

    jest.spyOn(db, 'from').mockImplementation((table) => {
      if (table === 'service_contracts') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gt: jest.fn().mockReturnThis(),
          not: mockNot,
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          then: (resolve: any) => resolve({ data: [], error: null }),
          is: jest.fn().mockReturnThis()
        } as any;
      }
      return {} as any;
    });

    await processCascadeQueue();

    // Verify query applied .not('x402_payment_id', 'is', null)
    expect(mockNot).toHaveBeenCalledWith('x402_payment_id', 'is', null);
  });

  test('enforcement on: pending contract WITH payment advances', async () => {
    process.env.X402_ENFORCEMENT_ENABLED = 'true';

    const mockUpdateMaybeSingle = jest.fn().mockResolvedValue({ data: { id: 'contract-123' }, error: null });

    jest.spyOn(db, 'from').mockImplementation((table) => {
      if (table === 'service_contracts') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          gt: jest.fn().mockReturnThis(),
          not: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          then: (resolve: any) => resolve({
            data: [
              {
                id: 'contract-123',
                service_id: 'service-123',
                buyer_agent_id: 'buyer-123',
                agreed_price_usdc_raw: 10000,
                payload: { service_type: 'test-service' },
                expires_at: new Date(Date.now() + 10000).toISOString(),
                created_at: new Date().toISOString(),
                x402_payment_id: 'settlement-123',
                agent_services: {
                  service_type: 'test-service',
                  active: true,
                  min_repid_to_purchase: 0
                }
              }
            ],
            error: null
          }),
          update: jest.fn().mockReturnThis(),
          maybeSingle: mockUpdateMaybeSingle,
          is: jest.fn().mockReturnThis()
        } as any;
      }
      return {} as any;
    });

    await processCascadeQueue();

    expect(mockUpdateMaybeSingle).toHaveBeenCalled();
  });
});
