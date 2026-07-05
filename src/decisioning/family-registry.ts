/**
 * MODEL FAMILY REGISTRY — single source of family truth for §7 disjointness lookups.
 * OUTPUT_PATH: src/decisioning/family-registry.ts
 * SPEC: PRIORITY_B_ANFIS_DECISIONING_CHARTER_v1.md §7 (family-disjointness HARD RULE).
 *
 * WHY A REGISTRY (not string parsing): §7 requires disjointness to be a REGISTRY LOOKUP, not
 * ad-hoc model-name parsing at decision time. familyOf() in src/hal/fact-check.ts is the existing
 * family-truth (regex over model names); it is fine for HAL's own quorum, but for the decisioning
 * disjointness gate we require an EXPLICIT registry so an unmapped/ambiguous model HARD-FAILS
 * ("register family first") instead of silently falling through to a provider-prefix guess.
 *
 * SEED PROVENANCE [V 2026-07-05]: every entry is an ACTUAL DISTINCT (provider, model) pair in
 * llm_call_log (Supabase qnnpjhlxljtqyigedwkb; COUNT(DISTINCT (provider,model))=27), with family
 * derived by tracing familyOf() over each model. 21 map to a real family and are seeded here; the 6
 * that do NOT (2x test-model, 3x unknown, 1x hf/phi-4-mini) are DELIBERATELY ABSENT — they are listed
 * in phase1-findings.md for Sean. NO INVENTED FAMILIES. Mirrors migrations/2026-07-05-model-family-registry.sql.
 *
 * ADVISORY PURITY (R3): this module is a pure lookup; it performs no I/O, no routing, no writes.
 */

import { familyOf } from '../hal/fact-check';

/** The set of families familyOf() can confidently resolve (a fall-through to a raw split is NOT one). */
const KNOWN_FAMILIES = new Set<string>([
  'deepseek', 'llama', 'glm', 'kimi', 'gemini', 'mistral', 'qwen', 'openai', 'anthropic',
]);

export interface FamilyRegistryEntry {
  provider: string;
  model: string;
  family: string;
  source: 'familyOf';
  evidence_n: number;
}

/**
 * SEED = the 21 confidently-mapped telemetry pairs [V 2026-07-05]. Keyed at lookup by (provider, model)
 * AND by model alone (model is the family-determining field per familyOf's own doc). Kept byte-aligned
 * with the migration seed so DB and code cannot drift.
 */
export const FAMILY_REGISTRY_SEED: readonly FamilyRegistryEntry[] = Object.freeze([
  { provider: 'groq',              model: 'llama-3.1-8b-instant',                family: 'llama',     source: 'familyOf', evidence_n: 77536 },
  { provider: 'cerebras',          model: 'zai-glm-4.7',                         family: 'glm',       source: 'familyOf', evidence_n: 68287 },
  { provider: 'mistral',           model: 'mistral-small-latest',                family: 'mistral',   source: 'familyOf', evidence_n: 61974 },
  { provider: 'gemini',            model: 'gemini-2.0-flash',                    family: 'gemini',    source: 'familyOf', evidence_n: 60767 },
  { provider: 'fireworks',         model: 'accounts/fireworks/models/kimi-k2p5', family: 'kimi',      source: 'familyOf', evidence_n: 9713 },
  { provider: 'cerebras',          model: 'llama3.1-8b',                         family: 'llama',     source: 'familyOf', evidence_n: 9181 },
  { provider: 'deepseek',          model: 'deepseek-chat',                       family: 'deepseek',  source: 'familyOf', evidence_n: 6386 },
  { provider: 'openai',            model: 'gpt-4o-mini',                         family: 'openai',    source: 'familyOf', evidence_n: 5073 },
  { provider: 'deepseek-chat',     model: 'deepseek-chat',                       family: 'deepseek',  source: 'familyOf', evidence_n: 5071 },
  { provider: 'groq',              model: 'llama-3.3-70b-versatile',             family: 'llama',     source: 'familyOf', evidence_n: 3953 },
  { provider: 'anthropic',         model: 'claude-haiku-4-5-20251001',           family: 'anthropic', source: 'familyOf', evidence_n: 3351 },
  { provider: 'litellm',           model: 'hf/qwen-2.5-72b',                     family: 'qwen',      source: 'familyOf', evidence_n: 3177 },
  { provider: 'gemini',            model: 'models/gemini-2.5-flash',             family: 'gemini',    source: 'familyOf', evidence_n: 3144 },
  { provider: 'litellm',           model: 'hf/deepseek-r1-qwen-32b',             family: 'deepseek',  source: 'familyOf', evidence_n: 1878 },
  { provider: 'deepseek-reasoner', model: 'deepseek-reasoner',                   family: 'deepseek',  source: 'familyOf', evidence_n: 460 },
  { provider: 'groq-70b',          model: 'llama-3.3-70b-versatile',             family: 'llama',     source: 'familyOf', evidence_n: 331 },
  { provider: 'groq-8b',           model: 'llama-3.1-8b-instant',                family: 'llama',     source: 'familyOf', evidence_n: 331 },
  { provider: 'gpt-4o-mini',       model: 'gpt-4o-mini',                         family: 'openai',    source: 'familyOf', evidence_n: 165 },
  { provider: 'qwen',              model: 'gpt-4o-mini',                         family: 'openai',    source: 'familyOf', evidence_n: 46 },
  { provider: 'litellm-qwen',      model: 'hf/qwen-2.5-72b',                     family: 'qwen',      source: 'familyOf', evidence_n: 9 },
  { provider: 'llama-3-2-1b',      model: 'Llama-3.2-1B-Instruct',               family: 'llama',     source: 'familyOf', evidence_n: 3 },
]);

/**
 * KNOWN-UNMAPPED telemetry pairs [V 2026-07-05] — recorded so a lookup for one produces an explicit,
 * auditable hard-fail (NOT a silent guess). These are the 6 that familyOf() cannot resolve to a real
 * family. Listed for Sean in phase1-findings.md. `hf/phi-4-mini` is a PROPOSED 'phi' addition (real
 * model, familyOf lacks the rule); the rest are sentinels/nulls.
 */
export const KNOWN_UNMAPPED: ReadonlyArray<{ provider: string; model: string; familyOfResult: string; note: string }> = Object.freeze([
  { provider: 'litellm-phi',  model: 'hf/phi-4-mini', familyOfResult: 'hf',      note: "real family is Microsoft 'phi'; familyOf() has no phi rule — PROPOSED addition, awaiting Sean" },
  { provider: 'groq',         model: 'test-model',    familyOfResult: 'test',    note: 'test sentinel, not a real model' },
  { provider: 'gemini',       model: 'test-model',    familyOfResult: 'test',    note: 'test sentinel, not a real model' },
  { provider: 'groq',         model: 'unknown',       familyOfResult: 'unknown', note: 'no model string' },
  { provider: 'llama-3-2-1b', model: 'unknown',       familyOfResult: 'unknown', note: 'provider implies llama; model col null-ish — NOT guessed' },
  { provider: 'anthropic',    model: 'unknown',       familyOfResult: 'unknown', note: 'no model string' },
]);

const BY_MODEL = new Map<string, string>();
for (const e of FAMILY_REGISTRY_SEED) BY_MODEL.set(e.model.toLowerCase(), e.family);

/** Thrown when a model has no confident family — the caller MUST register it before using disjointness. */
export class UnmappedFamilyError extends Error {
  constructor(public readonly model: string, public readonly familyOfResult: string) {
    super(`[family-registry] UNMAPPED model "${model}" (familyOf -> "${familyOfResult}", not a known family). Register family first — disjointness will not guess.`);
    this.name = 'UnmappedFamilyError';
  }
}

/**
 * Resolve a model's family via REGISTRY LOOKUP. Order:
 *   1) explicit seed (BY_MODEL) — the authoritative table;
 *   2) familyOf() ONLY if it resolves to a KNOWN_FAMILIES value (defensive: a new model whose name
 *      clearly carries a known family, e.g. a fresh 'llama-4-*', is accepted without a redeploy);
 *   3) otherwise HARD-FAIL (UnmappedFamilyError) — never a provider-prefix guess.
 * This is the single lookup the disjointness module uses; it does no string surgery of its own.
 */
export function resolveFamily(model: string): string {
  const key = (model || '').toLowerCase();
  const seeded = BY_MODEL.get(key);
  if (seeded) return seeded;
  const derived = familyOf(model);
  if (KNOWN_FAMILIES.has(derived)) return derived;
  throw new UnmappedFamilyError(model, derived);
}

/** Non-throwing probe: is this model confidently mappable to a family? */
export function isMapped(model: string): boolean {
  try { resolveFamily(model); return true; } catch { return false; }
}

/** The set of families the registry currently recognises (for reporting / audit). */
export function knownFamilies(): string[] {
  return [...KNOWN_FAMILIES];
}
