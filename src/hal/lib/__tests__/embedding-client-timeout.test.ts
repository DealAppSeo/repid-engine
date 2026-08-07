/**
 * Regression: remote embedding fetches must carry a timeout so one unresponsive
 * provider cannot hang the HAL semantic-similarity layer. Before this, embedMany
 * awaited fetch() with no signal and could wait forever.
 */
import { OpenAIEmbeddingClient, VoyageEmbeddingClient } from '../cross-llm/embedding-client';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('embedding client timeouts', () => {
  it('OpenAIEmbeddingClient passes an AbortSignal to fetch', async () => {
    let seenSignal: unknown = null;
    global.fetch = (async (_url: any, init: any) => {
      seenSignal = init?.signal;
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) } as any;
    }) as any;

    const client = new OpenAIEmbeddingClient('https://api.openai.com/v1/embeddings', 'k', 'text-embedding-3-small', 5000);
    const out = await client.embed('hello');
    expect(out).toEqual([0.1, 0.2]);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects (never hangs) when a provider stalls past the timeout', async () => {
    // A fetch that only settles when the request signal aborts — i.e. it hangs
    // until the timeout fires. With no timeout this would wait forever.
    global.fetch = ((_url: any, init: any) => new Promise((_resolve, reject) => {
      const sig: AbortSignal = init.signal;
      sig.addEventListener('abort', () => reject(new DOMException('The operation timed out.', 'TimeoutError')));
    })) as any;

    const client = new VoyageEmbeddingClient('k', 'voyage-3', 25);
    await expect(client.embed('hello')).rejects.toThrow(/timed out|abort/i);
  });
});
