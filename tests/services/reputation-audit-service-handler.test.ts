import { ReputationAuditServiceHandler } from '../../src/services/reputation-audit-service-handler';
import { db } from '../../src/db';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({
      data: {
        id: 'subject-1',
        agent_name: 'test-agent',
        current_repid: 100,
        tier: 'T2',
        validation_count: 10,
        validations_correct: 9,
        vdr_count: 5,
        wisdom_score: 80,
        character_score: 90,
        signing_address: '0x123'
      },
      error: null
    }),
    insert: jest.fn().mockReturnThis()
  }
}));

describe('ReputationAuditServiceHandler', () => {
  let handler: any;

  beforeEach(() => {
    jest.clearAllMocks();
    handler = new ReputationAuditServiceHandler();
  });

  it('generates a snapshot and records the attestation', async () => {
    // Mock insert to return a valid id
    (db.single as jest.Mock).mockResolvedValueOnce({
      data: {
        id: 'subject-1',
        agent_name: 'test-agent',
        current_repid: 100,
        tier: 'T2',
        validation_count: 10,
        validations_correct: 9,
        vdr_count: 5,
        wisdom_score: 80,
        character_score: 90,
        signing_address: '0x123'
      },
      error: null
    }).mockResolvedValueOnce({
      data: { id: 'mock-attestation-id', created_at: new Date().toISOString(), expires_at: new Date().toISOString() },
      error: null
    });

    const contract = {
      id: 'contract-1',
      provider_agent_id: 'provider-1',
      payload: {
        subject_agent_id: 'subject-1'
      }
    };

    const res = await handler.fulfill(contract);
    expect(res.reputation_snapshot.current_repid).toBe(100);
    expect(res.signature).toBe('signing_status=deferred');
    expect(res.patent_marker).toBe('P-001');
  });
});
