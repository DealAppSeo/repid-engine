import { logLlmCall } from '../log-call';
import { db } from '../../db';

jest.mock('../../db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    insert: jest.fn().mockResolvedValue({ error: null })
  }
}));

describe('Log LLM Call', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('Successful call writes row', async () => {
    await logLlmCall({
      call_id: '123',
      provider: 'groq',
      tier: '0a',
      model: 'model',
      prompt_tokens: 10,
      completion_tokens: 20,
      cost_usd: 0,
      latency_ms: 100,
      status: 'success'
    });
    expect(db.from).toHaveBeenCalledWith('llm_call_log');
    expect(db.from('llm_call_log').insert).toHaveBeenCalled();
  });

  it('Failed call writes row with status=failed', async () => {
    await logLlmCall({
      call_id: '124',
      provider: 'openai',
      tier: '1',
      model: 'gpt',
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      latency_ms: 0,
      status: 'failed',
      error_message: 'AuthError'
    });
    expect(db.from('llm_call_log').insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('Logging failure doesnt propagate', async () => {
    (db.from('llm_call_log').insert as jest.Mock).mockRejectedValueOnce(new Error('DB down'));
    await expect(logLlmCall({
      call_id: '125',
      provider: 'groq',
      tier: '0a',
      model: 'model',
      prompt_tokens: 10,
      completion_tokens: 20,
      cost_usd: 0,
      latency_ms: 100,
      status: 'success'
    })).resolves.not.toThrow();
  });
});
