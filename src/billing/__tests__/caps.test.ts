import { checkCap, incrementSpend } from '../caps';
import { db } from '../../db';

jest.mock('../../db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn(),
    update: jest.fn().mockReturnThis(),
    rpc: jest.fn()
  }
}));

describe('Caps', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('checkCap with limit=0 returns allowed', async () => {
    (db.from('x').select('x').eq('x').single as jest.Mock).mockResolvedValue({
      data: { monthly_limit_usd: 0, current_month_spent_usd: 10, hard_disabled: false },
      error: null
    });
    const res = await checkCap('groq');
    expect(res.allowed).toBe(true);
  });

  it('checkCap exceeded returns !allowed and marks disabled', async () => {
    (db.from('x').select('x').eq('x').single as jest.Mock).mockResolvedValue({
      data: { monthly_limit_usd: 10, current_month_spent_usd: 11, hard_disabled: false },
      error: null
    });
    const res = await checkCap('openai');
    expect(res.allowed).toBe(false);
    expect(res.hard_disabled).toBe(true);
    expect(db.from('x').update).toHaveBeenCalledWith({ hard_disabled: true });
  });

  it('incrementSpend calls rpc', async () => {
    await incrementSpend('groq', 0.5);
    expect(db.rpc).toHaveBeenCalledWith('increment_provider_spend', { p_name: 'groq', amount: 0.5 });
  });
});
