/**
 * BFT ANTI-SPOOF — audit item #4.
 *
 * Two hardenings, both proven here:
 *   (1) The registry-hard-fail disjointness module now has a LIVE entry point, selectDisjointQuorum(),
 *       that excludes unmapped (spoofable) judges instead of assigning them a regex-guessed family, and
 *       collapses same-family hosts to one independent vote.
 *   (2) That entry point is wired into the live HAL quorum (factCheck) behind BFT_DISJOINT_ENFORCE
 *       (default OFF): an excluded judge never makes a request and never votes.
 *
 * REQUIRED CHECKS (from the task): a spoofed/unmapped family is REJECTED; a genuinely disjoint quorum
 * PASSES; a non-disjoint set is CAUGHT. All three are covered — first on the pure selector, then
 * end-to-end through factCheck with a mocked fetch (no network).
 */

import {
  selectDisjointQuorum,
  assertDisjoint,
  checkDisjoint,
  type DisjointViolation,
} from '../src/decisioning/disjointness';
import { factCheck, type FactCheckProviderCfg } from '../src/hal/fact-check';

// Registry-mapped models (verified in src/decisioning/family-registry.ts seed).
const M = {
  llamaGroq: 'llama-3.1-8b-instant', // family: llama
  llamaCerebras: 'llama3.1-8b', // family: llama (same family as llamaGroq)
  gemini: 'gemini-2.0-flash', // family: gemini
  deepseek: 'deepseek-chat', // family: deepseek
  glm: 'zai-glm-4.7', // family: glm
  mistral: 'mistral-small-latest', // family: mistral
};
// NOT in the registry — the spoofable / unmapped case. familyOf() would regex-guess a family for these.
const UNMAPPED = 'test-model';

describe('selectDisjointQuorum — registry-hard-fail disjointness (the live entry point)', () => {
  it('a genuinely disjoint quorum PASSES unchanged', () => {
    const judges = [
      { provider: 'groq', model: M.llamaGroq },
      { provider: 'gemini', model: M.gemini },
      { provider: 'deepseek', model: M.deepseek },
    ];
    const sel = selectDisjointQuorum(judges, { seed: 'req-1' });
    expect(sel.ok).toBe(true);
    expect(sel.kept.length).toBe(3);
    expect(sel.keptFamilies).toEqual(['deepseek', 'gemini', 'llama']);
    expect(sel.excludedUnmapped).toEqual([]);
    expect(sel.excludedSameFamily).toEqual([]);
  });

  it('REJECTS a spoofed/unmapped model — excluded, never assigned a guessed family', () => {
    const judges = [
      { provider: 'groq', model: M.llamaGroq },
      { provider: 'gemini', model: M.gemini },
      { provider: 'spoofer', model: UNMAPPED }, // unmapped — must NOT vote under a regex guess
    ];
    const sel = selectDisjointQuorum(judges, { seed: 'req-2' });
    expect(sel.excludedUnmapped.map((j) => j.model)).toEqual([UNMAPPED]);
    // the unmapped judge is NOT in kept and its (guessed) family never enters the family set
    expect(sel.kept.map((j) => j.model)).toEqual([M.llamaGroq, M.gemini]);
    expect(sel.keptFamilies).not.toContain('test');
    expect(sel.keptFamilies).toEqual(['gemini', 'llama']);
  });

  it('CATCHES a non-disjoint set — two same-family hosts collapse to one independent vote', () => {
    const judges = [
      { provider: 'groq', model: M.llamaGroq }, // llama
      { provider: 'cerebras', model: M.llamaCerebras }, // llama (fake-independent second vote)
      { provider: 'gemini', model: M.gemini }, // gemini
    ];
    const sel = selectDisjointQuorum(judges, { seed: 'req-3' });
    // exactly one llama survives; the other is flagged as a same-family exclusion
    expect(sel.keptFamilies).toEqual(['gemini', 'llama']);
    expect(sel.kept.length).toBe(2);
    expect(sel.excludedSameFamily.length).toBe(1);
    expect(sel.excludedSameFamily[0]!.family).toBe('llama');
  });

  it('PRODUCER DISJOINTNESS — a judge sharing the producer family is dropped as self-grading', () => {
    const captured: DisjointViolation[] = [];
    const judges = [
      { provider: 'groq', model: M.llamaGroq }, // llama — SAME family as the producer
      { provider: 'gemini', model: M.gemini }, // gemini
      { provider: 'deepseek', model: M.deepseek }, // deepseek
    ];
    // producer is a Llama model → the Llama judge is marking its own homework.
    const sel = selectDisjointQuorum(judges, { seed: 'req-4', producerModel: M.llamaCerebras, sink: (v) => captured.push(v) });
    expect(sel.excludedProducerFamily.map((e) => e.family)).toEqual(['llama']);
    expect(sel.keptFamilies).toEqual(['deepseek', 'gemini']);
    // survivors are genuinely disjoint from the producer → the assertDisjoint sink did NOT fire
    expect(captured.length).toBe(0);
    expect(checkDisjoint([{ model: M.llamaCerebras }], sel.kept).disjoint).toBe(true);
  });

  it('is deterministic for a fixed seed (same kept families across runs)', () => {
    const judges = [
      { provider: 'a', model: M.llamaGroq },
      { provider: 'b', model: M.llamaCerebras },
      { provider: 'c', model: M.gemini },
      { provider: 'd', model: M.deepseek },
    ];
    const a = selectDisjointQuorum(judges, { seed: 'fixed' });
    const b = selectDisjointQuorum(judges, { seed: 'fixed' });
    expect(b.kept.map((j) => j.model)).toEqual(a.kept.map((j) => j.model));
  });

  it('assertDisjoint still hard-catches a same-family violation via a REAL sink (no silent swallow)', () => {
    const captured: DisjointViolation[] = [];
    const res = assertDisjoint(
      [{ model: M.llamaGroq }],
      [{ model: M.llamaCerebras }],
      { sink: (v) => captured.push(v), context: 'unit' },
    );
    expect(res.disjoint).toBe(false);
    expect(captured.length).toBe(1);
    expect(captured[0]!.shared_families).toEqual(['llama']);
  });
});

// -----------------------------------------------------------------------------------------------------
// LIVE WIRING — factCheck() under BFT_DISJOINT_ENFORCE (mocked fetch, no network).
// -----------------------------------------------------------------------------------------------------
describe('factCheck — BFT_DISJOINT_ENFORCE live wiring', () => {
  const originalFetch = global.fetch;
  let calledModels: string[] = [];

  beforeEach(() => {
    calledModels = [];
    // Every provider returns a confident TRUE so the quorum is well-formed; we assert on WHICH models
    // were actually called (an excluded judge must never make a request).
    (global as any).fetch = jest.fn(async (_url: string, init: any) => {
      // Count PROVIDER calls only. This mock intercepts *every* fetch in the
      // process, and several non-provider requests also carry a `model` field
      // in their body — notably the fire-and-forget `llm_call_log` telemetry
      // insert, which echoes the model it is logging. Counting those inflated
      // calledModels with exact duplicates of each provider.
      //
      // It passed by luck: those writes are not awaited, so they normally
      // landed after the assertion. Anything that adds latency inside
      // factCheck() lets them land inside the measured window instead —
      // which is exactly what the ground-truth gate's corpus read did.
      // The endpoint, not the body, is what identifies a provider.
      const url = String(_url);
      const isProviderCall = /^http:\/\/x\//.test(url);
      if (isProviderCall) {
        const model = JSON.parse(init.body).model;
        calledModels.push(model);
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: 'TRUE', confidence: 90 }) } }] }) } as any;
    });
    // Call every provider in parallel (no cheapest-first short-circuit) so exclusion is the only reason a
    // model is not called.
    process.env.HAL_QUORUM_COST_ORDERED = 'false';
    // Keep weight-dedup + auto-backfill out of this test's way.
    delete process.env.HAL_QUORUM_WEIGHT_DEDUP;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.BFT_DISJOINT_ENFORCE;
    delete process.env.HAL_QUORUM_COST_ORDERED;
  });

  it('flag OFF (default): an unmapped provider STILL votes (current behavior preserved)', async () => {
    const providers: FactCheckProviderCfg[] = [
      { name: 'groq', endpoint: 'http://x/1', apiKey: 'k', model: M.llamaGroq },
      { name: 'gemini', endpoint: 'http://x/2', apiKey: 'k', model: M.gemini },
      { name: 'spoofer', endpoint: 'http://x/3', apiKey: 'k', model: UNMAPPED },
    ];
    const r = await factCheck('the sky is blue', providers);
    // all three called, including the unmapped one (regex-guessed family) — proves the flag is inert
    expect(calledModels.sort()).toEqual([M.gemini, M.llamaGroq, UNMAPPED].sort());
    expect(r.providers_used).toBe(3);
    // and the unmapped model is surfaced as regex-guessed (spoofable) via families_unmapped
    expect(r.families_unmapped).toContain(UNMAPPED);
  });

  it('flag ON: the unmapped provider is EXCLUDED — never called, never votes', async () => {
    process.env.BFT_DISJOINT_ENFORCE = 'true';
    const providers: FactCheckProviderCfg[] = [
      { name: 'groq', endpoint: 'http://x/1', apiKey: 'k', model: M.llamaGroq },
      { name: 'gemini', endpoint: 'http://x/2', apiKey: 'k', model: M.gemini },
      { name: 'spoofer', endpoint: 'http://x/3', apiKey: 'k', model: UNMAPPED },
    ];
    const r = await factCheck('the sky is blue', providers);
    expect(calledModels).not.toContain(UNMAPPED);
    expect(calledModels.sort()).toEqual([M.gemini, M.llamaGroq].sort());
    expect(r.providers_used).toBe(2);
    expect((r.families ?? []).sort()).toEqual(['gemini', 'llama']);
    // no spoofable family leaked into the result
    expect(r.families_unmapped ?? []).not.toContain(UNMAPPED);
  });

  it('flag ON: two same-family hosts collapse to one independent vote', async () => {
    process.env.BFT_DISJOINT_ENFORCE = 'true';
    const providers: FactCheckProviderCfg[] = [
      { name: 'groq', endpoint: 'http://x/1', apiKey: 'k', model: M.llamaGroq }, // llama
      { name: 'cerebras', endpoint: 'http://x/2', apiKey: 'k', model: M.llamaCerebras }, // llama (dup)
      { name: 'gemini', endpoint: 'http://x/3', apiKey: 'k', model: M.gemini }, // gemini
    ];
    const r = await factCheck('the sky is blue', providers);
    // exactly two calls: one llama + gemini
    expect(calledModels.length).toBe(2);
    expect(calledModels).toContain(M.gemini);
    const llamaCalls = calledModels.filter((m) => m === M.llamaGroq || m === M.llamaCerebras);
    expect(llamaCalls.length).toBe(1);
    expect((r.families ?? []).sort()).toEqual(['gemini', 'llama']);
  });
});
