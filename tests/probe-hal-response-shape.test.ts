/**
 * The probe that verifies the live HAL response — and its own ability to fail.
 *
 * This exists because the previous verification of a deploy could not fail correctly: it
 * re-sent the same sentence, `/hal/evaluate` served the pre-deploy answer from its
 * (text, strictness) cache, and a working fix was reported broken. A probe that cannot tell
 * "stale" from "wrong" makes its passes worthless too.
 *
 * So every RED path below is exercised. The two GREEN cases are the ones that matter most:
 * MORE hosts than families and MORE families than hosts must BOTH pass, because neither
 * bounds the other and an earlier check asserted an ordering that the live panel violates.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import { probeHalResponseShape } from '../scripts/liveness-probes/probe-hal-response-shape';

const realFetch = global.fetch;
function stub(payload: unknown, ok = true, status = 200) {
  global.fetch = jest.fn(async () => ({ ok, status, json: async () => payload })) as any;
}
function stubThrow(err: Error) {
  global.fetch = jest.fn(async () => { throw err; }) as any;
}
afterEach(() => { global.fetch = realFetch; });

const OK_BODY = {
  mode: 'fact-check',
  signals: { providers_used: 5, families_used: 4, independent_hosts: 5 },
};

describe('probe fails when it must', () => {
  it('RED when the answer came from cache — the bug that started all this', async () => {
    stub({ ...OK_BODY, cached: true });
    const r = await probeHalResponseShape();
    expect(r.status).toBe('RED');
    expect(r.message).toMatch(/cache-bust has stopped working/);
  });

  it('RED when independent_hosts is absent from a fresh evaluation', async () => {
    stub({ mode: 'fact-check', signals: { providers_used: 5, families_used: 4 } });
    const r = await probeHalResponseShape();
    expect(r.status).toBe('RED');
    expect(r.message).toMatch(/not reaching callers/);
  });

  it('RED when a count exceeds the providers that actually answered', async () => {
    stub({ mode: 'fact-check', signals: { providers_used: 3, families_used: 2, independent_hosts: 9 } });
    const r = await probeHalResponseShape();
    expect(r.status).toBe('RED');
    expect(r.message).toMatch(/> providers_used/);
  });

  it('RED on a non-200', async () => {
    stub({}, false, 503);
    expect((await probeHalResponseShape()).status).toBe('RED');
  });
});

describe('unreachable is NOT the same as wrong', () => {
  it('AMBER, not RED, when the endpoint cannot be reached', async () => {
    stubThrow(Object.assign(new Error('boom'), { name: 'TypeError' }));
    const r = await probeHalResponseShape();
    expect(r.status).toBe('AMBER');
    expect(r.message).toMatch(/NOT CHECKED, not failed/);
  });
});

describe('neither hosts nor families bounds the other', () => {
  it('GREEN with MORE hosts than families — two hosts serving one family (the live panel)', async () => {
    stub(OK_BODY); // 5 hosts, 4 families
    const r = await probeHalResponseShape();
    expect(r.status).toBe('GREEN');
    expect(r.metrics.independent_hosts).toBeGreaterThan(r.metrics.families_used);
  });

  it('GREEN with MORE families than hosts — consolidation behind one gateway', async () => {
    stub({ mode: 'fact-check', signals: { providers_used: 4, families_used: 4, independent_hosts: 1 } });
    const r = await probeHalResponseShape();
    expect(r.status).toBe('GREEN');
    // The number consolidation is judged by: 4 voices, 1 outage away from silence.
    expect(r.metrics.families_per_host).toBe(4);
  });
});

describe('the cache-bust itself', () => {
  it('sends a different text on every call', async () => {
    const seen: string[] = [];
    global.fetch = jest.fn(async (_u: any, init: any) => {
      seen.push(JSON.parse(init.body).text);
      return { ok: true, status: 200, json: async () => OK_BODY } as any;
    }) as any;
    await probeHalResponseShape();
    await probeHalResponseShape();
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    // …while still asserting the same claim, so the verdict stays meaningful.
    expect(seen[0]).toContain('The capital of France is Paris.');
    expect(seen[1]).toContain('The capital of France is Paris.');
  });
});
