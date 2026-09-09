/**
 * provider-fetch.test.ts — proves the chokepoint is a faithful passthrough and NOTHING more.
 *
 * The only property that matters this slice: `providerFetch(url, init)` reaches the global
 * `fetch` with the SAME url and the SAME init, and returns exactly what `fetch` returned —
 * byte-for-byte, no rewrite, no added header, no dropped option. If a future edit quietly
 * mutates the request here, these assertions go red; that is the point (non-vacuity was shown
 * by breaking the forwarding and watching the init-equality assertion fail — see the PR).
 *
 * No network: the global `fetch` is replaced with a spy. This also documents that the module
 * binds `fetch` lazily (at call time), so the spy is observed.
 */
import { providerFetch } from '../src/egress/provider-fetch';

describe('providerFetch is a 1:1 passthrough to global fetch (no behaviour change)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('forwards url and init unchanged and returns fetch’s own result', async () => {
    const sentinel = { ok: true, marker: 'from-fetch' } as unknown as Response;
    const spy = jest.fn(async () => sentinel);
    globalThis.fetch = spy as unknown as typeof fetch;

    const url = 'https://cloud-llm.example/v1/chat/completions';
    const init: RequestInit = {
      method: 'POST',
      headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    };

    const out = await providerFetch(url, init);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(url, init); // same url, same init object — nothing rewritten
    expect(out).toBe(sentinel); // returns fetch's result unchanged
  });

  it('forwards the no-init call shape too', async () => {
    const spy = jest.fn(async () => ({ ok: true }) as unknown as Response);
    globalThis.fetch = spy as unknown as typeof fetch;

    await providerFetch('https://cloud-llm.example/v1/models');

    expect(spy).toHaveBeenCalledWith('https://cloud-llm.example/v1/models', undefined);
  });
});
