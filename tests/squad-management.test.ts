import request from 'supertest';

// Mock authMiddleware to bypass authentication in tests
jest.mock('../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'mock-key', tier: 'ops' };
    next();
  }
}));

import app from '../src/index';
import { db } from '../src/db';
import { shouldAttestOnChain } from '../src/services/repid-attestation';

// Mock DB
jest.mock('../src/db', () => {
  const mockFrom = jest.fn();
  const mockRpc = jest.fn().mockResolvedValue({ data: null, error: null });
  return {
    db: {
      from: mockFrom,
      rpc: mockRpc
    }
  };
});

describe('Squad Management API & Attestation Gating Integration Tests', () => {
  let mockDbQuery: any;

  beforeEach(() => {
    (db.from as jest.Mock).mockReset();
    (db.rpc as jest.Mock).mockReset();
    (db.rpc as jest.Mock).mockResolvedValue({ data: null, error: null });
    jest.clearAllMocks();
    mockDbQuery = {
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      upsert: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      in: jest.fn().mockReturnThis(),
    };
    (db.from as jest.Mock).mockReturnValue(mockDbQuery);
  });

  describe('REST API Endpoint Tests', () => {
    test('POST /api/v1/squads - Success', async () => {
      // Mock SBT validation
      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: { token_id: 'SBT-HUMAN-CEO-001' }, error: null });
      // Mock squad insert
      mockDbQuery.single.mockResolvedValueOnce({
        data: { id: 'squad-uuid-1', name: 'Test Squad', owner_human_sbt_id: 'SBT-HUMAN-CEO-001', license_tier: 'free_federated' },
        error: null
      });

      const res = await request(app)
        .post('/api/v1/squads')
        .send({ name: 'Test Squad', owner_human_sbt_id: 'SBT-HUMAN-CEO-001' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Test Squad');
      expect(res.body.owner_human_sbt_id).toBe('SBT-HUMAN-CEO-001');
    });

    test('POST /api/v1/squads - Missing Name (400)', async () => {
      const res = await request(app)
        .post('/api/v1/squads')
        .send({ owner_human_sbt_id: 'SBT-HUMAN-CEO-001' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    test('GET /api/v1/squads/:id - Success', async () => {
      // Mock squad fetch
      mockDbQuery.maybeSingle.mockResolvedValueOnce({
        data: { id: 'squad-uuid-1', name: 'Test Squad', owner_human_sbt_id: 'SBT-HUMAN-CEO-001' },
        error: null
      });
      // Mock members fetch
      (db.from as jest.Mock).mockReturnValueOnce(mockDbQuery); // squad call
      (db.from as jest.Mock).mockReturnValueOnce(mockDbQuery); // squad_membership call
      mockDbQuery.is.mockResolvedValueOnce({
        data: [
          { agent_id: 'agent-uuid-1', role: 'primary', is_delegate: true },
          { agent_id: 'agent-uuid-2', role: 'member', is_delegate: false }
        ],
        error: null
      });

      const res = await request(app).get('/api/v1/squads/squad-uuid-1');

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Test Squad');
      expect(res.body.members).toHaveLength(2);
      expect(res.body.members[0].agent_id).toBe('agent-uuid-1');
    });

    test('POST /api/v1/squads/:id/members - Success', async () => {
      // Mock ownership check
      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: { owner_human_sbt_id: 'SBT-HUMAN-CEO-001' }, error: null });
      // Mock agent check
      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: { id: 'agent-uuid-1' }, error: null });
      // Mock active squad check (none)
      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
      // Mock insert member
      mockDbQuery.single.mockResolvedValueOnce({
        data: { squad_id: 'squad-uuid-1', agent_id: 'agent-uuid-1', role: 'primary' },
        error: null
      });

      const res = await request(app)
        .post('/api/v1/squads/squad-uuid-1/members')
        .send({ agent_id: 'agent-uuid-1', role: 'primary', owner_human_sbt_id: 'SBT-HUMAN-CEO-001' });

      expect(res.status).toBe(201);
      expect(res.body.agent_id).toBe('agent-uuid-1');
      expect(res.body.role).toBe('primary');
    });

    test('POST /api/v1/squads/:id/members - Not Owner (403)', async () => {
      // Mock ownership check (different owner)
      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: { owner_human_sbt_id: 'SBT-HUMAN-CFO-001' }, error: null });

      const res = await request(app)
        .post('/api/v1/squads/squad-uuid-1/members')
        .send({ agent_id: 'agent-uuid-1', owner_human_sbt_id: 'SBT-HUMAN-CEO-001' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('owner');
    });

    test('DELETE /api/v1/squads/:id/members/:agent_id - Voluntary Leave Success', async () => {
      // Mock update to set left_at
      mockDbQuery.select.mockResolvedValueOnce({
        data: [{ squad_id: 'squad-uuid-1', agent_id: 'agent-uuid-1' }],
        error: null
      });

      const res = await request(app)
        .delete('/api/v1/squads/squad-uuid-1/members/agent-uuid-1')
        .send({ agent_voluntary: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('POST /api/v1/squads/:id/delegate - Success', async () => {
      // Mock ownership check
      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: { owner_human_sbt_id: 'SBT-HUMAN-CEO-001' }, error: null });
      // Mock active member check
      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: { id: 'membership-uuid-1' }, error: null });
      // Mock clear delegates and update delegate
      mockDbQuery.single.mockResolvedValueOnce({
        data: { squad_id: 'squad-uuid-1', agent_id: 'agent-uuid-2', is_delegate: true },
        error: null
      });

      const res = await request(app)
        .post('/api/v1/squads/squad-uuid-1/delegate')
        .send({ agent_id: 'agent-uuid-2', owner_human_sbt_id: 'SBT-HUMAN-CEO-001' });

      expect(res.status).toBe(200);
      expect(res.body.is_delegate).toBe(true);
    });
  });

  describe('shouldAttestOnChain Gating Logic Tests', () => {
    test('Unassigned agent returns true (legacy path)', async () => {
      // Mock no squad membership
      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

      const result = await shouldAttestOnChain('agent-uuid-unassigned', 'response-id-1');
      expect(result).toBe(true);
    });

    test('Delegate member returns true', async () => {
      // Mock active membership with is_delegate = true
      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: { squad_id: 'squad-uuid-1', is_delegate: true }, error: null });

      const result = await shouldAttestOnChain('agent-uuid-delegate', 'response-id-1');
      expect(result).toBe(true);
    });

    test('Non-delegate member delegates dynamically based on response_id hash', async () => {
      // Mock active membership with is_delegate = false
      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: { squad_id: 'squad-uuid-1', is_delegate: false }, error: null });
      // Mock squad members list sorted by agent_id
      mockDbQuery.order.mockResolvedValueOnce({
        data: [
          { agent_id: 'agent-uuid-1' },
          { agent_id: 'agent-uuid-2' },
          { agent_id: 'agent-uuid-3' }
        ],
        error: null
      });

      // The selected delegate is deterministic based on hash of 'response-id-1' % 3
      // Let's call shouldAttestOnChain for each member to ensure exactly one returns true
      const r1 = await shouldAttestOnChain('agent-uuid-1', 'response-id-1');
      
      // Reset mock values for next assertions
      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: { squad_id: 'squad-uuid-1', is_delegate: false }, error: null });
      mockDbQuery.order.mockResolvedValueOnce({
        data: [
          { agent_id: 'agent-uuid-1' },
          { agent_id: 'agent-uuid-2' },
          { agent_id: 'agent-uuid-3' }
        ],
        error: null
      });
      const r2 = await shouldAttestOnChain('agent-uuid-2', 'response-id-1');

      mockDbQuery.maybeSingle.mockResolvedValueOnce({ data: { squad_id: 'squad-uuid-1', is_delegate: false }, error: null });
      mockDbQuery.order.mockResolvedValueOnce({
        data: [
          { agent_id: 'agent-uuid-1' },
          { agent_id: 'agent-uuid-2' },
          { agent_id: 'agent-uuid-3' }
        ],
        error: null
      });
      const r3 = await shouldAttestOnChain('agent-uuid-3', 'response-id-1');

      // Verify that exactly one member is designated as the delegate for this response
      const trueCount = [r1, r2, r3].filter(val => val === true).length;
      expect(trueCount).toBe(1);
    });
  });

  describe('Observability API Endpoint Tests', () => {
    test('GET /api/v1/status/squads - Success', async () => {
      // Setup table-specific mock implementation for db.from
      (db.from as jest.Mock).mockImplementation((table: string) => {
        const builder: any = {
          select: jest.fn().mockReturnThis(),
          insert: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          upsert: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          is: jest.fn().mockReturnThis(),
          order: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({ data: null, error: null }),
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
          in: jest.fn().mockReturnThis(),
        };

        if (table === 'squad_membership') {
          builder.is.mockResolvedValue({
            data: [
              { squad_id: 'squad-uuid-1' },
              { squad_id: 'squad-uuid-2' }
            ],
            error: null
          });
        } else if (table === 'squad_internal_attestations') {
          builder.select.mockResolvedValue({ count: 12, error: null });
        } else if (table === 'repid_score_events') {
          builder.select.mockResolvedValue({ count: 100, error: null });
        } else if (table === 'trinity_tasks') {
          builder.limit.mockResolvedValue({
            data: [
              { assigned_to: 'trinity-shofet', metadata: { source_agent_id: 'agent-uuid-1' } },
              { assigned_to: 'trinity-mel', metadata: { source_agent_id: 'agent-uuid-2' } }
            ],
            error: null
          });
        } else if (table === 'repid_agents') {
          builder.select.mockResolvedValue({
            data: [
              { id: 'agent-uuid-1', agent_name: 'trinity-mel', squad_id: 'squad-uuid-1' },
              { id: 'agent-uuid-2', agent_name: 'trinity-shofet', squad_id: 'squad-uuid-2' }
            ],
            error: null
          });
        } else if (table === 'rep_id_provenance') {
          builder.select.mockResolvedValue({ count: 50, error: null });
        }

        return builder;
      });

      const res = await request(app).get('/api/v1/status/squads');

      if (res.status !== 200) {
        console.error("OBSERVABILITY FAILURE:", res.status, res.text, res.body);
      }

      expect(res.status).toBe(200);
      expect(res.body.data.squads_active_count).toBe(2);
      expect(res.body.data.on_chain_attestation_reduction_rate).toBeCloseTo(12 / (12 + 100));
      expect(res.body.data.cross_squad_verification_rate).toBe(1.0);
      expect(res.body.data.rep_id_provenance_coverage).toBeCloseTo(50 / 100);
    });
  });
});
