jest.mock('@xenova/transformers', () => ({
  env: {},
  pipeline: jest.fn(),
}));

import request from 'supertest';
import app from '../../../src/index';
import { db } from '../../../src/db';

jest.mock('../../../src/db', () => {
  const mockFrom = jest.fn();
  const mockSelect = jest.fn();
  const mockInsert = jest.fn();
  const mockUpdate = jest.fn();
  const mockUpsert = jest.fn();
  const mockEq = jest.fn();
  const mockNot = jest.fn();
  const mockOrder = jest.fn();
  const mockLimit = jest.fn();
  const mockMaybeSingle = jest.fn();
  const mockSingle = jest.fn();
  const mockRpc = jest.fn();

  const dbMock = {
    from: mockFrom,
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    upsert: mockUpsert,
    eq: mockEq,
    // claimNextContract's pass-1 filter (non-NULL work_statement_hash).
    not: mockNot,
    order: mockOrder,
    limit: mockLimit,
    maybeSingle: mockMaybeSingle,
    single: mockSingle,
    rpc: mockRpc,
    storage: {
      from: jest.fn().mockReturnThis(),
      upload: jest.fn(),
    },
  };

  mockFrom.mockReturnValue(dbMock);
  mockSelect.mockReturnValue(dbMock);
  mockInsert.mockReturnValue(dbMock);
  mockUpdate.mockReturnValue(dbMock);
  mockEq.mockReturnValue(dbMock);
  mockNot.mockReturnValue(dbMock);
  mockOrder.mockReturnValue(dbMock);
  mockLimit.mockReturnValue(dbMock);

  // Default mock resolutions to avoid unhandled crashes
  mockRpc.mockResolvedValue({ data: null, error: null });
  mockUpsert.mockResolvedValue({ data: null, error: null });

  return { db: dbMock };
});

// Mock authentication middleware
jest.mock('../../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
    next();
  }
}));

describe('Agent Process Contracts Route with all handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('successfully processes request but finds no contracts for any handler', async () => {
    // 1. Mock agent lookup (repid_agents table)
    // 2. Mock each handler's claimNextContract (service_contracts table)
    
    (db.maybeSingle as jest.Mock)
      .mockResolvedValueOnce({ data: { id: 'agent-123' }, error: null }) // agent lookup
      .mockResolvedValue({ data: null, error: null }); // all handlers claimNextContract returns null

    const res = await request(app)
      .post('/api/v1/agent/process-contracts')
      .send({ agent_name: 'test-agent' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ processed: false });
  });

  it('fails if agent lookup fails', async () => {
    (db.maybeSingle as jest.Mock).mockResolvedValueOnce({ data: null, error: { message: 'DB Error' } });

    const res = await request(app)
      .post('/api/v1/agent/process-contracts')
      .send({ agent_name: 'unknown-agent' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ processed: false, error: 'agent lookup failed' });
  });
});
