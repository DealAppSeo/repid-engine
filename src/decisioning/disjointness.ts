/**
 * FAMILY-DISJOINTNESS GATE (§7 HARD RULE) — registry-lookup, no ad-hoc string parsing.
 * OUTPUT_PATH: src/decisioning/disjointness.ts
 * SPEC: PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md §7.
 *
 * THE RULE: the quorum that LABELS quality must not share model FAMILIES with the routing
 * CANDIDATES it grades — else labels self-grade (a Llama judge grading a Llama candidate is
 * marking its own homework). This module answers, via REGISTRY LOOKUP only:
 *   isDisjoint(candidates, judges) -> yes/no + the offending shared families.
 *
 * HARD-FAIL on unmapped: any model without a confident registry family throws UnmappedFamilyError
 * ("register family first"). Disjointness NEVER guesses a family from a raw model string.
 *
 * ROTATION: assembleDisjointJudges() does REAL seeded rotation over family pools (deterministic given
 * a seed; no RNG, no fake logs — R4). If it cannot assemble a disjoint judge set it returns a typed
 * failure, it does not fabricate one.
 *
 * ADVISORY PURITY (R3): pure functions + optional violation-sink callback. No DB writes here; the
 * caller supplies a sink (so the alert is REAL and logged, not stubbed). PROMOTION-GATED: nothing
 * this module returns routes live by itself.
 */

import { resolveFamily } from './family-registry';

export interface ModelRef {
  /** provider label (for reporting only; family is resolved from `model`). */
  provider?: string;
  /** model string — the family-determining field (registry lookup key). */
  model: string;
}

export interface DisjointnessResult {
  disjoint: boolean;
  /** families shared between candidates and judges (empty iff disjoint). */
  sharedFamilies: string[];
  candidateFamilies: string[];
  judgeFamilies: string[];
  /** human-readable reason (glass box). */
  reason: string;
}

/** Map a set of model refs to their distinct families (throws on any unmapped model). */
function familiesOf(refs: ModelRef[]): { families: Set<string>; perRef: Array<{ model: string; family: string }> } {
  const perRef = refs.map((r) => ({ model: r.model, family: resolveFamily(r.model) }));
  return { families: new Set(perRef.map((p) => p.family)), perRef };
}

/**
 * Core §7 predicate. Returns disjoint=false if ANY judge family also appears among the candidates.
 * Throws UnmappedFamilyError if any candidate or judge model is not confidently mapped.
 */
export function checkDisjoint(candidates: ModelRef[], judges: ModelRef[]): DisjointnessResult {
  const cand = familiesOf(candidates);
  const jud = familiesOf(judges);
  const shared = [...jud.families].filter((f) => cand.families.has(f));
  const disjoint = shared.length === 0;
  const candidateFamilies = [...cand.families].sort();
  const judgeFamilies = [...jud.families].sort();
  const reason = disjoint
    ? `DISJOINT: judge families [${judgeFamilies.join(', ')}] share none of candidate families [${candidateFamilies.join(', ')}].`
    : `VIOLATION: judge families [${judgeFamilies.join(', ')}] overlap candidate families [${candidateFamilies.join(', ')}] on [${shared.sort().join(', ')}] — quorum would self-grade.`;
  return { disjoint, sharedFamilies: shared.sort(), candidateFamilies, judgeFamilies, reason };
}

/** Violation record shape (mirrors migrations/2026-07-05-disjoint-violations.sql). */
export interface DisjointViolation {
  at: string;               // ISO timestamp
  shared_families: string[];
  candidate_families: string[];
  judge_families: string[];
  context?: string;
  reason: string;
}

/** A REAL sink — the caller wires a DB/log writer. Default logs loudly to stderr (no silent swallow). */
export type ViolationSink = (v: DisjointViolation) => void;
export const defaultViolationSink: ViolationSink = (v) => {
  console.error(`[disjointness] *** FAMILY-DISJOINTNESS VIOLATION *** ${v.reason} (context=${v.context ?? 'n/a'})`);
};

/**
 * Assert disjointness; on violation emit a REAL logged alert via the sink and return the result.
 * `throwOnViolation` (default false) additionally throws — use at the §7 gate where a violation must
 * hard-stop label assembly.
 */
export function assertDisjoint(
  candidates: ModelRef[],
  judges: ModelRef[],
  opts: { sink?: ViolationSink; context?: string; throwOnViolation?: boolean } = {},
): DisjointnessResult {
  const res = checkDisjoint(candidates, judges);
  if (!res.disjoint) {
    const sink = opts.sink ?? defaultViolationSink;
    sink({
      at: new Date().toISOString(),
      shared_families: res.sharedFamilies,
      candidate_families: res.candidateFamilies,
      judge_families: res.judgeFamilies,
      context: opts.context,
      reason: res.reason,
    });
    if (opts.throwOnViolation) throw new Error(res.reason);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------
// REAL seeded rotation over family pools for judge assembly.
// Deterministic: same (seed, pools, candidates, k) -> same judges. No RNG, no fabricated selection.
// ---------------------------------------------------------------------------------------------------

export interface JudgeAssembly {
  ok: boolean;
  judges: ModelRef[];
  judgeFamilies: string[];
  /** set when ok=false: why a disjoint set could not be built. */
  failure?: string;
}

/** Small deterministic hash for seeded, reproducible rotation (FNV-1a 32-bit). */
function seedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Assemble up to `k` judges whose families are disjoint from the candidate families, rotating over the
 * available family pools with a deterministic seed (so successive quorums spread load across families
 * instead of always picking the same one). Every returned judge is registry-mapped; the assembled set
 * is re-checked with checkDisjoint before returning (belt-and-suspenders). Returns ok=false with a
 * reason if fewer than `k` disjoint families are available — it does NOT pad with a same-family judge.
 *
 * @param candidates routing candidates being graded (their families are excluded from judges)
 * @param pool available judge model refs (each must be registry-mapped)
 * @param k number of distinct-family judges desired
 * @param seed rotation seed (e.g. a request id) — deterministic, auditable
 */
export function assembleDisjointJudges(candidates: ModelRef[], pool: ModelRef[], k: number, seed: string): JudgeAssembly {
  const candFamilies = new Set(candidates.map((c) => resolveFamily(c.model)));

  // Group pool by family, excluding candidate families outright.
  const byFamily = new Map<string, ModelRef[]>();
  for (const p of pool) {
    const fam = resolveFamily(p.model); // throws on unmapped — pool must be clean
    if (candFamilies.has(fam)) continue;
    byFamily.set(fam, [...(byFamily.get(fam) ?? []), p]);
  }

  const availableFamilies = [...byFamily.keys()].sort(); // stable order before rotation
  if (availableFamilies.length < k) {
    return {
      ok: false,
      judges: [],
      judgeFamilies: [],
      failure: `only ${availableFamilies.length} disjoint judge family/families available [${availableFamilies.join(', ')}], need ${k}. Register more families or widen the pool — NOT padding with a same-family judge.`,
    };
  }

  // Deterministic rotation offset from the seed, then pick k families round-robin.
  const offset = seedHash(seed) % availableFamilies.length;
  const chosenFamilies: string[] = [];
  for (let i = 0; i < k; i++) chosenFamilies.push(availableFamilies[(offset + i) % availableFamilies.length]!);

  // Within each chosen family, pick one member deterministically by seed too.
  const judges: ModelRef[] = chosenFamilies.map((fam) => {
    const members = byFamily.get(fam)!;
    return members[seedHash(seed + fam) % members.length]!;
  });

  // Belt-and-suspenders: the assembled set MUST be disjoint from candidates.
  const verify = checkDisjoint(candidates, judges);
  if (!verify.disjoint) {
    return { ok: false, judges: [], judgeFamilies: [], failure: `internal: assembled set not disjoint (${verify.reason})` };
  }
  return { ok: true, judges, judgeFamilies: chosenFamilies };
}
