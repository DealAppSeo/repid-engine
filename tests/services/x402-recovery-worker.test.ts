import { processRecoveryQueue } from '../../src/services/x402-recovery-worker';
import { db } from '../../src/db';
import { x402Facilitator } from '../../src/services/x402-facilitator';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn()
  }
}));

jest.mock('../../src/services/x402-facilitator', () => ({
  x402Facilitator: {
    settlePayment: jest.fn()
  }
}));

describe('x402-recovery-worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockDbFrom = (tableName: string, mockedMethods: any) => {
    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === tableName) return mockedMethods;
      // return dummy chain for others
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        lt: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null }),
        insert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockReturnThis()
      };
    });
  };

  test('Circuit breaker tripped -> 0 rows processed', async () => {
    mockDbFrom('repid_config', {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { value: 'true' } })
    });
    // mock runs table insert
    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'repid_config') return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: { value: 'true' } })
      };
      if (table === 'x402_recovery_worker_runs') return {
        insert: jest.fn().mockResolvedValue({})
      };
      return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        lt: jest.fn().mockResolvedValue({ data: [] })
      };
    });

    const result = await processRecoveryQueue();
    expect(result.circuitBreakerTripped).toBe(true);
    expect(result.rowsProcessed).toBe(0);
  });

  test('Empty failures table -> returns 0 processed', async () => {
    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'repid_config') return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: { value: 'false' } })
      };
      if (table === 'x402_settlement_failures') return {
        select: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        lt: jest.fn().mockResolvedValue({ data: [] }) // Empty
      };
      if (table === 'x402_recovery_worker_runs') return {
        insert: jest.fn().mockResolvedValue({})
      };
      return {};
    });

    const result = await processRecoveryQueue();
    expect(result.rowsProcessed).toBe(0);
  });

  test('One row in backoff window -> skipped', async () => {
    const row = {
      id: 1,
      attempt_count: 1,
      last_attempted_at: new Date().toISOString() // just now
    };
    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'repid_config') return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: { value: 'false' } })
      };
      if (table === 'x402_settlement_failures') return {
        select: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        lt: jest.fn().mockResolvedValue({ data: [row] }) 
      };
      if (table === 'x402_recovery_worker_runs') return {
        insert: jest.fn().mockResolvedValue({})
      };
      return {};
    });

    const result = await processRecoveryQueue();
    expect(result.rowsProcessed).toBe(0); // skipped due to backoff
  });

  test('One row eligible, settle succeeds -> marked resolved, row in x402_settlements', async () => {
    const row = {
      id: 1,
      attempt_count: 1,
      last_attempted_at: new Date(Date.now() - 60000).toISOString(), // 60s ago
      payment_payload_b64: 'base64',
      payment_requirements: [],
      agent_id: '123',
      idempotency_key: 'idem_key'
    };

    const updateMock = jest.fn().mockReturnThis();
    const updateEqMock = jest.fn().mockResolvedValue({});
    const insertSettlementMock = jest.fn().mockResolvedValue({});
    
    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'repid_config') return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null })
      };
      if (table === 'x402_settlement_failures') {
        // Return a chain that either resolves to the row (for select) or allows update
        return {
          select: jest.fn().mockReturnThis(),
          is: jest.fn().mockReturnThis(),
          lt: jest.fn().mockResolvedValue({ data: [row] }),
          update: jest.fn().mockReturnValue({ eq: updateEqMock })
        };
      }
      if (table === 'x402_settlements') return {
        insert: insertSettlementMock
      };
      if (table === 'x402_recovery_worker_runs') return {
        insert: jest.fn().mockResolvedValue({})
      };
      return {};
    });

    (x402Facilitator.settlePayment as jest.Mock).mockResolvedValue({ txHash: '0xabc' });

    const result = await processRecoveryQueue();
    
    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsRecovered).toBe(1);
    expect(insertSettlementMock).toHaveBeenCalled();
    expect(updateEqMock).toHaveBeenCalledWith('id', 1); // resolved_at update
  });

  test('One row eligible, settle fails -> attempt_count incremented', async () => {
    const row = {
      id: 2,
      attempt_count: 1,
      last_attempted_at: new Date(Date.now() - 60000).toISOString(), // 60s ago
      payment_payload_b64: 'base64',
      payment_requirements: []
    };

    const updateEqMock = jest.fn().mockResolvedValue({});
    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'repid_config') return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null })
      };
      if (table === 'x402_settlement_failures') return {
        select: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        lt: jest.fn().mockResolvedValue({ data: [row] }),
        update: jest.fn().mockReturnValue({ eq: updateEqMock })
      };
      if (table === 'x402_recovery_worker_runs') return {
        insert: jest.fn().mockResolvedValue({})
      };
      return {};
    });

    (x402Facilitator.settlePayment as jest.Mock).mockRejectedValue(new Error('Network error'));

    const result = await processRecoveryQueue();
    
    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsRecovered).toBe(0);
    expect(result.rowsStillFailing).toBe(1);
  });

  test('One row at attempt_count=4 fails -> marked abandoned', async () => {
    const row = {
      id: 3,
      attempt_count: 4,
      last_attempted_at: new Date(Date.now() - 3600001).toISOString(), // > 1h ago
      payment_payload_b64: 'base64',
      payment_requirements: []
    };

    const updateEqMock = jest.fn().mockResolvedValue({});
    (db.from as jest.Mock).mockImplementation((table: string) => {
      if (table === 'repid_config') return {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        single: jest.fn().mockResolvedValue({ data: null })
      };
      if (table === 'x402_settlement_failures') return {
        select: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        lt: jest.fn().mockResolvedValue({ data: [row] }),
        update: jest.fn().mockReturnValue({ eq: updateEqMock })
      };
      if (table === 'x402_recovery_worker_runs') return {
        insert: jest.fn().mockResolvedValue({})
      };
      return {};
    });

    (x402Facilitator.settlePayment as jest.Mock).mockRejectedValue(new Error('Network error'));

    const result = await processRecoveryQueue();
    
    expect(result.rowsProcessed).toBe(1);
    expect(result.rowsRecovered).toBe(0);
    expect(result.rowsStillFailing).toBe(0);
    expect(result.rowsAbandoned).toBe(1);
  });
});
