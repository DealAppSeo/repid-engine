/**
 * S-HARDEN Phase 5 — concurrent HAL evaluation load test.
 * Fires N concurrent HAL extractor evaluations and reports throughput, errors, and latency
 * p50/p95/p99. In-process (no server) — exercises the HAL pipeline under concurrency.
 *
 *   npx ts-node scripts/stress/hal-load-test.ts [N=50]
 */
import { evaluate } from '../../src/hal/lib/evaluate';

const N = Number(process.argv[2] ?? 50);
const PROMPT = 'What is the capital of France?';
const RESPONSE = 'The capital of France is Paris, a major European city.';

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i]!;
}

(async () => {
  console.log(`\n=== HAL load test: ${N} concurrent evaluations ===`);
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: N }, async () => {
      const s = Date.now();
      const r: any = await evaluate(RESPONSE, RESPONSE, { domain: 'general', certainty: 0.8, strictness: 1 } as any);
      return { ms: Date.now() - s, score: r.hal_score };
    }),
  );
  const wall = Date.now() - t0;

  const ok = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ ms: number; score: number }>[];
  const errors = results.filter(r => r.status === 'rejected') as PromiseRejectedResult[];
  const lat = ok.map(r => r.value.ms).sort((a, b) => a - b);
  const scores = new Set(ok.map(r => r.value.score.toFixed(3)));

  console.log(`completed: ${ok.length}/${N}   errors: ${errors.length}   wall: ${wall}ms   throughput: ${Math.round((ok.length / wall) * 1000)}/s`);
  console.log(`latency ms — p50: ${pct(lat, 50)}  p95: ${pct(lat, 95)}  p99: ${pct(lat, 99)}  max: ${lat[lat.length - 1] ?? 0}`);
  console.log(`distinct scores: ${scores.size} (same input → expect 1; >1 = non-deterministic/corruption under load)`);
  if (errors.length) console.log(`first error: ${(errors[0]!.reason as any)?.message ?? errors[0]!.reason}`);
  console.log(errors.length === 0 && scores.size === 1
    ? '→ PASS: no errors, deterministic under concurrency.'
    : `→ CHECK: ${errors.length} errors / ${scores.size} distinct scores.`);
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
