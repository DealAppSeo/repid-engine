/**
 * OUTPUT_PATH: src/services/anfis-litellm-test-hook.ts
 *
 * Phase 0 — LiteLLM ADVISORY TEST HOOK (PROMOTION-GATED, default OFF).
 * Bound spec: PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md §3 (advisory-not-blocking) + R3 (advisory purity).
 *
 * PURPOSE: measure the round-trip overhead of consulting the ANFIS decisioning core from the request path,
 * WITHOUT ever routing live traffic. The hook:
 *   - is DISABLED by default. It fires ONLY when BOTH:
 *       (a) process.env.ANFIS_DECISIONING_HOOK_ENABLED === 'true'  (kill-switch, default OFF), AND
 *       (b) a NON-PROD key is supplied: process.env.NODE_ENV !== 'production'
 *           AND process.env.ANFIS_HOOK_TEST_KEY is set and matches the caller-supplied testKey.
 *   - returns ONLY an ADVISORY suggestion object (recommended provider/tier/confidence). It NEVER mutates a
 *     request, never selects a provider for a real call, never writes to any table. PROMOTION-GATED.
 *   - is provably inert with the flag OFF: `hookEnabled()` returns false and `consult()` returns
 *     { fired:false, ... } with no ANFIS call performed.
 *
 * This is a MEASUREMENT hook for Phase 0 only. Promotion to an advisory wire-up (P1) is a separate, gated step.
 */

import { anfisRecommendProvider, type AnfisRouterOutput } from './anfis-router';

export interface HookConsultInput {
  prompt: string;
  taskHint?: string;
  providerState?: { cost: number; rate: number; qual: number };
  /** Caller-supplied NON-PROD test key; must match ANFIS_HOOK_TEST_KEY. Absence => hook cannot fire. */
  testKey?: string;
}

export interface HookConsultResult {
  fired: boolean;
  reason: string;
  suggestion: AnfisRouterOutput | null;
  /** Round-trip overhead of the hook itself, in ms (0 when not fired). */
  overheadMs: number;
  /** true iff this result routed anything live (ALWAYS false — advisory purity, R3). */
  routedLive: false;
}

/**
 * Kill-switch. Default OFF. Both conditions required:
 *  - explicit env flag ANFIS_DECISIONING_HOOK_ENABLED === 'true'
 *  - NOT running in production (non-prod key requirement, R3 + prompt step 4)
 */
export function hookEnabled(): boolean {
  return (
    process.env.ANFIS_DECISIONING_HOOK_ENABLED === 'true' &&
    process.env.NODE_ENV !== 'production'
  );
}

/** Non-prod test key check: env var must be set AND match the supplied key. */
function testKeyValid(testKey?: string): boolean {
  const expected = process.env.ANFIS_HOOK_TEST_KEY;
  return !!expected && !!testKey && expected === testKey;
}

/**
 * Consult the ANFIS core. Returns an advisory suggestion + measured overhead.
 * With the flag OFF (default), this performs NO ANFIS call and returns { fired:false }.
 */
export function consult(input: HookConsultInput): HookConsultResult {
  if (!hookEnabled()) {
    return {
      fired: false,
      reason: 'hook disabled (ANFIS_DECISIONING_HOOK_ENABLED!=true or NODE_ENV=production)',
      suggestion: null,
      overheadMs: 0,
      routedLive: false,
    };
  }
  if (!testKeyValid(input.testKey)) {
    return {
      fired: false,
      reason: 'non-prod test key missing or mismatched (ANFIS_HOOK_TEST_KEY)',
      suggestion: null,
      overheadMs: 0,
      routedLive: false,
    };
  }

  const t0 = process.hrtime.bigint();
  const suggestion = anfisRecommendProvider(
    input.prompt,
    input.taskHint,
    input.providerState ?? { cost: 0.5, rate: 0.2, qual: 0.8 }
  );
  const t1 = process.hrtime.bigint();

  return {
    fired: true,
    reason: 'advisory suggestion computed (PROMOTION-GATED, no live routing)',
    suggestion,
    overheadMs: Number(t1 - t0) / 1e6,
    routedLive: false,
  };
}

/**
 * Measure hook round-trip overhead over N iterations under the CURRENTLY-ENABLED state.
 * Returns per-call overhead percentiles. If the hook is disabled, every call returns fired:false
 * with 0 overhead — which is itself the proof the hook cannot fire when OFF.
 */
export function measureHookOverhead(
  iterations: number,
  sampleInput: HookConsultInput
): { fired: boolean; iterations: number; p50Ms: number; p95Ms: number; p99Ms: number } {
  const times: number[] = [];
  let anyFired = false;
  for (let i = 0; i < iterations; i++) {
    const r = consult(sampleInput);
    anyFired = anyFired || r.fired;
    times.push(r.overheadMs);
  }
  const sorted = times.sort((a, b) => a - b);
  const pct = (p: number) => {
    if (sorted.length === 0) return NaN;
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
  };
  return { fired: anyFired, iterations, p50Ms: pct(50), p95Ms: pct(95), p99Ms: pct(99) };
}
