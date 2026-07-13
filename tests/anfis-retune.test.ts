/**
 * anfis-retune.test.ts — task 21. Locks (1) the weight-continuity formula against the
 * orphaned sync_routing_weight trigger, and (2) the dry-run vs persist behaviour of the
 * re-tune (dry-run computes but writes nothing; persist upserts weights + history + params).
 *
 * No real Supabase: a tiny in-memory fake records every table write so we can assert the
 * exact row shapes hit the routing tables.
 */
import {
  computeWeight,
  retuneAnfisRouting,
  type ProviderHealthRollup,
} from '../src/services/anfis-retune';

const HEALTH: ProviderHealthRollup[] = [
  { provider: 'groq', success: 10612, failed: 8932, rate_limited: 0, samples: 19544, avg_latency_ms: 730 },
  { provider: 'mistral', success: 13392, failed: 3, rate_limited: 0, samples: 13395, avg_latency_ms: 576 },
  { provider: 'deepseek', success: 523, failed: 5213, rate_limited: 0, samples: 5736, avg_latency_ms: 333 },
  { provider: 'fireworks', success: 100, failed: 0, rate_limited: 0, samples: 100, avg_latency_ms: 200 }, // denylisted
  { provider: 'rare', success: 3, failed: 0, rate_limited: 0, samples: 3, avg_latency_ms: 100 }, // below min samples
];

/** Fake supabase client: rpc returns HEALTH; from() records inserts/upserts per table. */
function makeFakeSb(beforeWeights: Record<string, number>) {
  const writes: Record<string, any[]> = { routing_weights: [], anfis_weight_history: [], anfis_params: [], ecosystem_loop_snapshots: [] };
  const sb: any = {
    rpc: async (_fn: string, _args: any) => ({ data: HEALTH, error: null }),
    from: (table: string) => ({
      select: async (_cols: string) => {
        if (table === 'routing_weights') {
          return { data: Object.entries(beforeWeights).map(([provider, weight]) => ({ provider, weight })), error: null };
        }
        return { data: [], error: null };
      },
      upsert: async (row: any, _opts: any) => { writes[table]!.push(row); return { error: null }; },
      insert: async (rows: any) => { (Array.isArray(rows) ? rows : [rows]).forEach((r) => writes[table]!.push(r)); return { error: null }; },
    }),
  };
  return { sb, writes };
}

describe('computeWeight — continuity with the orphaned sync_routing_weight trigger', () => {
  test('clamps to [0.1, 1.0]', () => {
    expect(computeWeight(1, 0)).toBe(1.0);
    expect(computeWeight(0, 0)).toBe(0.1);   // 0 * anything → clamp floor
    expect(computeWeight(1, 60_000)).toBe(0.1); // latency >= 30s → full penalty → floor
  });
  test('latency penalty is linear to 30s', () => {
    // successRate 1, 15s latency → 1 * (1 - 0.5) = 0.5
    expect(computeWeight(1, 15_000)).toBeCloseTo(0.5, 6);
  });
  test('a fast, reliable provider outweighs a fast, unreliable one', () => {
    const mistral = computeWeight(13392 / 13395, 576);
    const deepseek = computeWeight(523 / 5736, 333);
    expect(mistral).toBeGreaterThan(deepseek);
  });
});

describe('retuneAnfisRouting — dry-run', () => {
  test('computes providers but writes NOTHING to routing tables when persist=false', async () => {
    const { sb, writes } = makeFakeSb({ groq: 0.92, mistral: 0.5, deepseek: 0.7 });
    const r = await retuneAnfisRouting(sb, { persist: false });

    expect(r.persisted).toBe(false);
    expect(writes.routing_weights).toHaveLength(0);
    expect(writes.anfis_weight_history).toHaveLength(0);
    expect(writes.anfis_params).toHaveLength(0);
    // still computed the retune for the 3 eligible providers
    expect(r.providers.map((p) => p.provider).sort()).toEqual(['deepseek', 'groq', 'mistral']);
    // fireworks denylisted, rare below-min-samples
    expect(r.skipped.map((s) => s.provider).sort()).toEqual(['fireworks', 'rare']);
    // no snapshot when persist explicitly false
    expect(writes.ecosystem_loop_snapshots).toHaveLength(0);
    expect(r.wrote.snapshot).toBe(false);
  });
});

describe('retuneAnfisRouting — persist', () => {
  test('upserts weights, appends history with before/after, writes one params row + a snapshot', async () => {
    const { sb, writes } = makeFakeSb({ groq: 0.92, mistral: 0.5, deepseek: 0.7 });
    const r = await retuneAnfisRouting(sb, { persist: true });

    expect(r.persisted).toBe(true);
    // 3 eligible providers upserted
    expect(writes.routing_weights).toHaveLength(3);
    for (const row of writes.routing_weights) {
      expect(typeof row.provider).toBe('string');
      expect(row.weight).toBeGreaterThanOrEqual(0.1);
      expect(row.weight).toBeLessThanOrEqual(1.0);
    }
    // history: one row per provider, carrying the routing regime + before/after
    expect(writes.anfis_weight_history.length).toBe(3);
    const mistralHist = writes.anfis_weight_history.find((h) => h.agent_id === 'mistral');
    expect(mistralHist.regime_type).toBe('provider_routing');
    expect(mistralHist.trigger_reason).toBe('anfis_retune_cron');
    expect(mistralHist.weight_before).toBe(0.5);
    expect(mistralHist.weight_after).toBeGreaterThan(0.5); // mistral is reliable+fast → weight up
    expect(mistralHist.delta).toBeCloseTo(mistralHist.weight_after - 0.5, 6);
    // exactly one anfis_params row
    expect(writes.anfis_params).toHaveLength(1);
    expect(writes.anfis_params[0].training_samples).toBe(19544 + 13395 + 5736);
    expect(writes.anfis_params[0].routing_accuracy).toBeGreaterThan(0);
    // one ecosystem_loop_snapshots report with before/after
    expect(writes.ecosystem_loop_snapshots).toHaveLength(1);
    const snap = writes.ecosystem_loop_snapshots[0];
    expect(snap.created_by).toBe('cc-anfis-retune');
    expect(snap.metrics.loop).toBe('anfis_routing_retune');
    expect(snap.metrics.before_weights.mistral).toBe(0.5);
    expect(snap.metrics.after_weights.mistral).toBeGreaterThan(0.5);
  });

  test('a never-before-seen provider gets a history row with weight_before=null', async () => {
    const { sb, writes } = makeFakeSb({}); // no prior weights
    await retuneAnfisRouting(sb, { persist: true });
    const groqHist = writes.anfis_weight_history.find((h) => h.agent_id === 'groq');
    expect(groqHist.weight_before).toBeNull();
    expect(groqHist.weight_after).toBeGreaterThan(0);
  });
});
