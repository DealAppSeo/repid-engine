import { GroqAdapter } from '../../src/providers/groq';
import { AuthError, RateLimitError } from '../../src/providers/types';

describe('GroqAdapter', () => {
  let adapter: GroqAdapter;

  beforeEach(() => {
    adapter = new GroqAdapter();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('completes request successfully', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'test response' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      })
    });

    const res = await adapter.complete({ prompt: 'hello', apiKey: 'test-key' });
    expect(res.answer).toBe('test response');
    expect(res.tokensIn).toBe(10);
    expect(res.provider).toBe('groq');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Authorization': 'Bearer test-key', 'Content-Type': 'application/json' }
      })
    );
  });

  it('handles auth error', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401 });
    await expect(adapter.complete({ prompt: 'test', apiKey: 'bad' })).rejects.toThrow(AuthError);
  });

  it('handles rate limit error', async () => {
    const headers = new Headers();
    headers.set('retry-after', '5');
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 429,
      headers
    });
    await expect(adapter.complete({ prompt: 'test', apiKey: 'key' })).rejects.toThrow(RateLimitError);
  });
});
