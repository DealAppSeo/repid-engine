/**
 * HAL WEIGHT-DEDUP (2026-07-09, reports/2026-07-09 HAL eval).
 *
 * Proves the checkpoint registry + weight-dedup selection:
 *   1. two hosts serving the SAME weights (Groq + DeepInfra Llama-3.1-8B, eval corr 0.881) resolve to
 *      the SAME checkpoint and dedup to ONE vote;
 *   2. same brand, DIFFERENT checkpoint (qwen-2.5-72b vs qwen-2.5-7b) are NOT merged;
 *   3. an unmapped host is a LOUD FLAG + its OWN singleton checkpoint — never silently merged;
 *   4. stochastic selection is checkpoint-diverse and deterministic under a fixed seed;
 *   5. the HAL_QUORUM_WEIGHT_DEDUP flag gates factCheck: off = no change, shadow = reports but does
 *      not mutate the quorum, on = actually dedups the assembled set.
 */
// Mock the DB so importing fact-check (→ billing/log-call → db → config) doesn't need live Supabase.
jest.mock('../src/db', () => ({ db: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) } }));

import {
  resolveCheckpoint,
  isCheckpointMapped,
  dedupByCheckpoint,
  stochasticCheckpointDiverseSubset,
  weightDedupMode,
  stochasticK,
  unmappedCheckpointId,
  type CheckpointRef,
} from '../src/hal/checkpoint-registry';
import { factCheck, type FactCheckProviderCfg } from '../src/hal/fact-check';

describe('resolveCheckpoint — weights identity, not brand', () => {
  it('Groq + DeepInfra + Cerebras Llama-3.1-8B all map to the SAME checkpoint (the 0.881 pair)', () => {
    const groq = resolveCheckpoint('groq', 'llama-3.1-8b-instant');
    const deepinfra = resolveCheckpoint('deepinfra', 'llama-3.1-8b');
    const cerebras = resolveCheckpoint('cerebras', 'llama3.1-8b');
    expect(groq.mapped).toBe(true);
    expect(deepinfra.mapped).toBe(true);
    expect(cerebras.mapped).toBe(true);
    expect(groq.checkpoint).toBe('llama-3.1-8b-instruct');
    expect(deepinfra.checkpoint).toBe(groq.checkpoint);
    expect(cerebras.checkpoint).toBe(groq.checkpoint);
  });

  it('same brand, DIFFERENT weights map to DIFFERENT checkpoints (llama 8B vs 70B; qwen 72B vs 7B)', () => {
    expect(resolveCheckpoint('groq', 'llama-3.1-8b-instant').checkpoint)
      .not.toBe(resolveCheckpoint('groq', 'llama-3.3-70b-versatile').checkpoint);
    expect(resolveCheckpoint('openrouter', 'qwen/qwen-2.5-72b-instruct').checkpoint)
      .not.toBe(resolveCheckpoint('openrouter', 'qwen/qwen-2.5-7b-instruct').checkpoint);
  });

  it('litellm + openrouter Qwen-2.5-72B are the SAME weights → same checkpoint', () => {
    expect(resolveCheckpoint('litellm', 'hf/qwen-2.5-72b').checkpoint)
      .toBe(resolveCheckpoint('openrouter', 'qwen/qwen-2.5-72b-instruct').checkpoint);
  });

  it('an unmapped host is NOT mapped and gets its OWN singleton checkpoint (never merged)', () => {
    const r = resolveCheckpoint('roguehost', 'brand-new-model-v9');
    expect(r.mapped).toBe(false);
    expect(r.checkpoint).toBe(unmappedCheckpointId('roguehost', 'brand-new-model-v9'));
    // two DIFFERENT unmapped hosts never collide, even on the same model string
    expect(resolveCheckpoint('hostA', 'x').checkpoint).not.toBe(resolveCheckpoint('hostB', 'x').checkpoint);
    expect(isCheckpointMapped('roguehost', 'brand-new-model-v9')).toBe(false);
  });
});

describe('dedupByCheckpoint — one host per weights identity', () => {
  const refs: CheckpointRef[] = [
    { provider: 'groq', model: 'llama-3.1-8b-instant' },       // llama-3.1-8b-instruct
    { provider: 'deepinfra', model: 'llama-3.1-8b' },          // SAME checkpoint → dedup
    { provider: 'deepseek', model: 'deepseek-chat' },          // deepseek-v3-chat
    { provider: 'mistral', model: 'mistral-small-latest' },    // mistral-small
  ];

  it('drops the duplicate-weights host and keeps distinct checkpoints', () => {
    const r = dedupByCheckpoint(refs, 'fixed-seed');
    const keptCks = new Set(r.kept.map((k) => resolveCheckpoint(k.provider, k.model).checkpoint));
    expect(keptCks.size).toBe(3); // llama-8b, deepseek-v3, mistral-small
    expect(r.kept).toHaveLength(3);
    expect(r.dropped).toHaveLength(1);
    const dropped = resolveCheckpoint(r.dropped[0]!.provider, r.dropped[0]!.model).checkpoint;
    expect(dropped).toBe('llama-3.1-8b-instruct'); // one of the two 8B hosts removed
  });

  it('is deterministic given a fixed seed (same survivor each run)', () => {
    const a = dedupByCheckpoint(refs, 'seed-A');
    const b = dedupByCheckpoint(refs, 'seed-A');
    expect(a.kept.map((k) => k.provider)).toEqual(b.kept.map((k) => k.provider));
  });

  it('surfaces unmapped hosts (each a kept singleton) for registration', () => {
    const withUnmapped: CheckpointRef[] = [...refs, { provider: 'rogue', model: 'brand-new-v9' }];
    const r = dedupByCheckpoint(withUnmapped, 'seed');
    expect(r.unmapped).toHaveLength(1);
    expect(r.unmapped[0]!.model).toBe('brand-new-v9');
    // unmapped singleton is KEPT (never dropped/merged)
    expect(r.kept.some((k) => k.model === 'brand-new-v9')).toBe(true);
  });
});

describe('stochasticCheckpointDiverseSubset — randomized but checkpoint-diverse + deterministic', () => {
  const pool: CheckpointRef[] = [
    { provider: 'groq', model: 'llama-3.1-8b-instant' },
    { provider: 'deepinfra', model: 'llama-3.1-8b' },       // dup of groq weights
    { provider: 'deepseek', model: 'deepseek-chat' },
    { provider: 'mistral', model: 'mistral-small-latest' },
    { provider: 'cerebras', model: 'zai-glm-4.7' },
  ];

  it('never selects two hosts sharing a checkpoint and returns k distinct checkpoints', () => {
    const r = stochasticCheckpointDiverseSubset(pool, 2, 'seed-1');
    expect(r.selected).toHaveLength(2);
    expect(new Set(r.selectedCheckpoints).size).toBe(2); // all distinct weights
  });

  it('is deterministic for a fixed seed and varies across seeds', () => {
    const a = stochasticCheckpointDiverseSubset(pool, 3, 'seed-X');
    const b = stochasticCheckpointDiverseSubset(pool, 3, 'seed-X');
    expect(a.selected.map((s) => s.provider)).toEqual(b.selected.map((s) => s.provider));
    // at least one of several other seeds should differ (anti-gaming: not a fixed roster)
    const seeds = ['s1', 's2', 's3', 's4', 's5'];
    const rosters = seeds.map((s) => stochasticCheckpointDiverseSubset(pool, 2, s).selected.map((x) => x.provider).join(','));
    expect(new Set(rosters).size).toBeGreaterThan(1);
  });

  it('returns all distinct checkpoints when k exceeds availability (never pads with a duplicate)', () => {
    const r = stochasticCheckpointDiverseSubset(pool, 99, 'seed');
    // 5 hosts, but 2 share a checkpoint → 4 distinct
    expect(r.selected).toHaveLength(4);
    expect(new Set(r.selectedCheckpoints).size).toBe(4);
  });
});

describe('flag readers', () => {
  const save = process.env.HAL_QUORUM_WEIGHT_DEDUP;
  const saveK = process.env.HAL_QUORUM_STOCHASTIC_K;
  afterEach(() => {
    if (save === undefined) delete process.env.HAL_QUORUM_WEIGHT_DEDUP; else process.env.HAL_QUORUM_WEIGHT_DEDUP = save;
    if (saveK === undefined) delete process.env.HAL_QUORUM_STOCHASTIC_K; else process.env.HAL_QUORUM_STOCHASTIC_K = saveK;
  });

  it('defaults to off and fails closed on garbage', () => {
    delete process.env.HAL_QUORUM_WEIGHT_DEDUP;
    expect(weightDedupMode()).toBe('off');
    expect(weightDedupMode('nonsense')).toBe('off');
    expect(weightDedupMode('shadow')).toBe('shadow');
    expect(weightDedupMode('on')).toBe('on');
  });

  it('stochasticK defaults to 0 (dedup-only) and parses a positive int', () => {
    delete process.env.HAL_QUORUM_STOCHASTIC_K;
    expect(stochasticK()).toBe(0);
    expect(stochasticK('3')).toBe(3);
    expect(stochasticK('-1')).toBe(0);
    expect(stochasticK('abc')).toBe(0);
  });
});

describe('factCheck integration — flag-gated, shadow-first', () => {
  const originalFetch = global.fetch;
  const saveMode = process.env.HAL_QUORUM_WEIGHT_DEDUP;
  const saveOrder = process.env.HAL_QUORUM_COST_ORDERED;
  beforeEach(() => {
    // Every provider returns a clean TRUE verdict so factCheck reaches the real return path.
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: 'TRUE', confidence: 90 }) } }] }),
    }));
    process.env.HAL_QUORUM_COST_ORDERED = 'false'; // call all providers in parallel (simpler assertions)
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (saveMode === undefined) delete process.env.HAL_QUORUM_WEIGHT_DEDUP; else process.env.HAL_QUORUM_WEIGHT_DEDUP = saveMode;
    if (saveOrder === undefined) delete process.env.HAL_QUORUM_COST_ORDERED; else process.env.HAL_QUORUM_COST_ORDERED = saveOrder;
  });

  // Two hosts serving the SAME 8B weights + one distinct family.
  const dupPool: FactCheckProviderCfg[] = [
    { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'llama-3.1-8b-instant' },
    { name: 'deepinfra', endpoint: 'y', apiKey: 'k', model: 'llama-3.1-8b' }, // same checkpoint as groq
    { name: 'deepseek', endpoint: 'z', apiKey: 'k', model: 'deepseek-chat' },
  ];

  it('off (default) — no weight_dedup field, all 3 hosts attempted (live unchanged)', async () => {
    delete process.env.HAL_QUORUM_WEIGHT_DEDUP;
    const r = await factCheck('the sky is blue', dupPool);
    expect(r.weight_dedup).toBeUndefined();
    expect(r.provider_health?.attempted).toBe(3);
  });

  it('shadow — reports the would-be dedup but does NOT mutate the quorum (all 3 still attempted)', async () => {
    process.env.HAL_QUORUM_WEIGHT_DEDUP = 'shadow';
    const r = await factCheck('the sky is blue', dupPool);
    expect(r.weight_dedup).toBeDefined();
    expect(r.weight_dedup!.mode).toBe('shadow');
    expect(r.weight_dedup!.mutated).toBe(false);
    expect(r.weight_dedup!.checkpoints_before).toBe(2);       // llama-8b + deepseek
    expect(r.weight_dedup!.checkpoints_after).toBe(2);
    expect(r.weight_dedup!.dropped_duplicates).toHaveLength(1); // one 8B host would be dropped
    expect(r.provider_health?.attempted).toBe(3);             // BUT nothing mutated — all 3 called
  });

  it('on — actually dedups: only 2 distinct-weights hosts are attempted', async () => {
    process.env.HAL_QUORUM_WEIGHT_DEDUP = 'on';
    const r = await factCheck('the sky is blue', dupPool);
    expect(r.weight_dedup).toBeDefined();
    expect(r.weight_dedup!.mutated).toBe(true);
    expect(r.provider_health?.attempted).toBe(2);             // duplicate-weights host removed
    // the surviving providers are on distinct checkpoints
    expect(new Set(r.weight_dedup!.selected_checkpoints).size).toBe(2);
  });
});
