import { getFreeProviderCallsToday } from '../../src/billing/free-provider-call-count';
import { db } from '../../src/db';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn(),
  },
}));

describe('getFreeProviderCallsToday', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the exact count for the queried provider', async () => {
    (db.gte as jest.Mock).mockResolvedValue({ count: 42, error: null });
    const result = await getFreeProviderCallsToday('groq');
    expect(result).toBe(42);
    expect(db.from).toHaveBeenCalledWith('llm_call_log');
    expect(db.eq).toHaveBeenCalledWith('provider', 'groq');
  });

  it('returns 0 when count is null', async () => {
    (db.gte as jest.Mock).mockResolvedValue({ count: null, error: null });
    const result = await getFreeProviderCallsToday('cerebras');
    expect(result).toBe(0);
  });

  it('throws on a query error rather than silently returning 0', async () => {
    (db.gte as jest.Mock).mockResolvedValue({ count: null, error: { message: 'boom' } });
    await expect(getFreeProviderCallsToday('sambanova')).rejects.toThrow('boom');
  });
});
