import { generateCard } from '../zkp-card-generator';
import { db } from '../../db';

jest.mock('../../db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
    single: jest.fn(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis()
  }
}));

describe('zkp-card-generator', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, ZKP_CARDS_ENABLED: 'true' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should return null if ZKP_CARDS_ENABLED is not true', async () => {
    process.env.ZKP_CARDS_ENABLED = 'false';
    const result = await generateCard({ agent_name: 'test-agent', event_type: 'task_completion' });
    expect(result).toBeNull();
  });

  it('should generate a card successfully', async () => {
    const mockCardId = '123e4567-e89b-12d3-a456-426614174000';
    
    // Mock db.from().maybeSingle() / single() returns based on table
    (db.from as jest.Mock).mockImplementation((table: string) => {
      const builder = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        insert: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn(),
        single: jest.fn()
      };

      if (table === 'repid_agents') {
        builder.maybeSingle.mockResolvedValue({ data: { current_repid: 1000 } });
      } else if (table === 'repid_proof_queue') {
        builder.maybeSingle.mockResolvedValue({ data: { proof_hash: 'abc123hash' } });
      } else if (table === 'trinity_tasks') {
        builder.maybeSingle.mockResolvedValue({ data: { metadata: { test_tier: 'T2a_INTERNAL_REAL_ORGANIC' } } });
      } else if (table === 'zkp_cards') {
        builder.single.mockResolvedValue({ data: { card_id: mockCardId }, error: null });
      }
      
      return builder;
    });

    const result = await generateCard({
      agent_name: 'test-agent',
      task_id: 101,
      task_title: 'Test Task',
      event_type: 'task_completion'
    });

    expect(result).toBe(mockCardId);
    expect(db.from).toHaveBeenCalledWith('zkp_cards');
  });
});
