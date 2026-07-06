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
  // 'familyOf' = derived from a REAL telemetry pair via familyOf(). 'hal-config-default' = a model HAL
  // is CONFIGURED to use (a HAL_S2_*_MODEL default in src/hal/fact-check.ts) but which had no telemetry
  // rows at seed time — added [CROSS-FIX 2026-07-05] so HAL's live quorum hits the registry (accurate,
  // non-spoofable) instead of the regex fallback. NOT invented: it is the literal HAL default string and
  // an unambiguous single-family match. evidence_n=0 marks the honest "config, not telemetry" provenance.
  source: 'familyOf' | 'hal-config-default';
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
  // CROSS-FIX 2026-07-05 — HAL's configured qwen default (HAL_S2_QWEN_MODEL ?? 'qwen-plus' in
  // src/hal/fact-check.ts). No telemetry rows at seed time (qwen quorum is opt-in/unfunded), so it is
  // CONFIG-sourced (evidence_n=0), NOT telemetry. Unambiguous single-family match (/qwen/ only) → seeding
  // it is accurate, not a guess; without it HAL's live qwen provider would hit the spoofable regex fallback.
  { provider: 'qwen',              model: 'qwen-plus',                           family: 'qwen',      source: 'hal-config-default', evidence_n: 0 },
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

/**
 * AMBIGUOUS-SEED entry excluded from BY_MODEL at load time. Same treatment as KNOWN_UNMAPPED:
 * the model is NOT resolvable and needs explicit human family registration (Sean's call), because
 * its name carries tokens for >1 known family and any single-family seed value is a first-match guess.
 */
export interface AmbiguousSeedEntry {
  provider: string;
  model: string;
  /** the family the (rejected) seed row declared — kept for the audit trail, NOT used for resolution. */
  seededFamily: string;
  /** every known family whose token the model name matches (the reason it's ambiguous). */
  matchedFamilies: string[];
}

/**
 * SEED-INTEGRITY / AMBIGUITY DETECTION [FIX CYCLE 1 2026-07-05].
 * familyOf() is a FIRST-MATCH regex: for a name that carries more than one known-family token
 * (e.g. `deepseek-llama-3.3-70b` matches BOTH /deepseek/ AND /llama/), it returns whichever pattern
 * comes first in its if-chain — silently classifying the model as the wrong family. When BUILDING the
 * seed from familyOf() this is a mis-seed vector. This helper enumerates ALL known-family tokens a
 * model name matches; >1 match = AMBIGUOUS => the model must be treated as unmapped and listed for
 * manual review, NEVER first-match classified. Pure string inspection; used only at seed-build /
 * integrity time, not at the runtime disjointness lookup (which is registry-only).
 */
const FAMILY_TOKEN_PATTERNS: ReadonlyArray<{ family: string; re: RegExp }> = Object.freeze([
  { family: 'deepseek', re: /deepseek/ },
  { family: 'llama', re: /llama/ },
  { family: 'glm', re: /glm|zai/ },
  { family: 'kimi', re: /kimi|moonshot/ },
  { family: 'gemini', re: /gemini|gemma/ },
  { family: 'mistral', re: /mistral|mixtral|ministral/ },
  { family: 'qwen', re: /qwen/ },
  { family: 'openai', re: /gpt|o1|o3|o4/ },
  { family: 'anthropic', re: /claude/ },
]);

/** All known families whose token appears in the model name (first-match agnostic). */
export function matchedFamilies(model: string): string[] {
  // V3 FIX 2026-07-05 (fuzz-hardening) — String() coercion; never throws on a non-string input.
  const m = String(model ?? '').toLowerCase();
  const hits: string[] = [];
  for (const { family, re } of FAMILY_TOKEN_PATTERNS) if (re.test(m)) hits.push(family);
  return hits;
}

/**
 * A model is AMBIGUOUS when its name carries tokens for MORE THAN ONE known family — familyOf() would
 * first-match one and silently drop the other. Ambiguous models must NOT be seeded; they go to the
 * "register explicitly" (KNOWN_UNMAPPED) path, same as junk. Guards against `deepseek-llama-*` /
 * `llama-deepseek-*` mis-seeding.
 */
export function isAmbiguousFamily(model: string): boolean {
  return matchedFamilies(model).length > 1;
}

/**
 * SEED SWEEP [FIX CYCLE 2 2026-07-05]. The ambiguity guard (isAmbiguousFamily / seedFamilyFor) was only
 * applied to NEW seeding; the EXISTING FAMILY_REGISTRY_SEED was never swept. `hf/deepseek-r1-qwen-32b`
 * was grandfathered in as `deepseek` yet matches BOTH /deepseek/ AND /qwen/ (a DeepSeek-R1-distill-Qwen
 * hybrid) — so a Qwen-lineage judge could pass §7 disjointness against a Qwen candidate. Fix: sweep the
 * WHOLE seed through isAmbiguousFamily when building BY_MODEL; EXCLUDE any ambiguous row (collect it into
 * AMBIGUOUS_SEED for human resolution, same as an unmapped model). Excluded models are therefore absent
 * from BY_MODEL -> resolveFamily() HARD-FAILS for them (register-first), never a first-match guess.
 * (Placed AFTER isAmbiguousFamily/matchedFamilies/FAMILY_TOKEN_PATTERNS so no temporal-dead-zone access.)
 */
const BY_MODEL = new Map<string, string>();
const _ambiguousSeed: AmbiguousSeedEntry[] = [];
for (const e of FAMILY_REGISTRY_SEED) {
  if (isAmbiguousFamily(e.model)) {
    _ambiguousSeed.push({
      provider: e.provider,
      model: e.model,
      seededFamily: e.family,
      matchedFamilies: matchedFamilies(e.model),
    });
    continue; // EXCLUDE — do not register an ambiguous model under any single family.
  }
  BY_MODEL.set(e.model.toLowerCase(), e.family);
}

/** Seed rows rejected as ambiguous during the load-time sweep — exported/logged for human resolution. */
export const AMBIGUOUS_SEED: ReadonlyArray<AmbiguousSeedEntry> = Object.freeze(_ambiguousSeed);

if (AMBIGUOUS_SEED.length > 0) {
  console.error(
    `[family-registry] EXCLUDED ${AMBIGUOUS_SEED.length} ambiguous seed entr${AMBIGUOUS_SEED.length === 1 ? 'y' : 'ies'} ` +
      `(match >1 known family; need explicit human registration): ` +
      AMBIGUOUS_SEED.map((a) => `${a.model} [${a.matchedFamilies.join('/')}]`).join(', '),
  );
}

/**
 * SEED-BUILD GUARD: given a raw telemetry model name, return the family to seed, or a reason it must be
 * omitted (unmapped/ambiguous). This is the ONLY sanctioned way to derive a seed family from familyOf()
 * — it refuses to first-match an ambiguous name. Not used at runtime lookup (that path is registry-only).
 */
export function seedFamilyFor(model: string): { seed: true; family: string } | { seed: false; reason: string } {
  const hits = matchedFamilies(model);
  if (hits.length > 1) {
    return { seed: false, reason: `AMBIGUOUS: matches multiple known families [${hits.join(', ')}] — do NOT first-match; register explicitly.` };
  }
  const derived = familyOf(model);
  if (KNOWN_FAMILIES.has(derived) && hits.length === 1) return { seed: true, family: derived };
  return { seed: false, reason: `UNMAPPED: familyOf -> "${derived}" is not a known family — register explicitly.` };
}

/** Thrown when a model has no confident family — the caller MUST register it before using disjointness. */
export class UnmappedFamilyError extends Error {
  constructor(public readonly model: string, public readonly familyOfResult: string) {
    // V3 FIX 2026-07-05 (fuzz-hardening) — String(model) is Symbol-safe; a raw `${model}` template
    // interpolation throws on a Symbol, which would fault inside this error's own construction.
    super(`[family-registry] UNMAPPED model "${String(model)}" (familyOf -> "${familyOfResult}", not a known family). Register family first — disjointness will not guess.`);
    this.name = 'UnmappedFamilyError';
  }
}

/**
 * Resolve a model's family via REGISTRY LOOKUP — REGISTRY-ONLY (§7, no string parsing at check time).
 * [FIX CYCLE 1 2026-07-05] The prior familyOf() fallback was a disjointness BYPASS: familyOf() is a
 * first-match substring regex, so an aliased model like `deepseek-llama-3.3-70b` (matches /deepseek/
 * before /llama/) resolved to 'deepseek' — a Llama judge could then "pass" disjointness against a Llama
 * candidate. Runtime lookup now consults ONLY the explicit seed (BY_MODEL); a model absent from the
 * registry HARD-FAILS with UnmappedFamilyError (register-first). No provider-prefix or substring guess.
 *   1) explicit seed (BY_MODEL) — the authoritative table;
 *   2) otherwise HARD-FAIL (UnmappedFamilyError).
 * familyOf() is invoked ONLY to populate a human-readable diagnostic in the error — it does NOT steer
 * the resolve decision (which is registry membership alone).
 */
export function resolveFamily(model: string): string {
  // V3 FIX 2026-07-05 (fuzz-hardening) — String() coercion so a truthy non-string input can't throw at
  // `.toLowerCase()` (which would escape familyOfResolved()'s catch). Zero change on the string path.
  const key = String(model ?? '').toLowerCase();
  const seeded = BY_MODEL.get(key);
  if (seeded) return seeded;
  // Not in the registry: register-first. familyOf() here is DIAGNOSTIC ONLY (never decides the result).
  throw new UnmappedFamilyError(model, familyOf(model));
}

/** Non-throwing probe: is this model confidently mappable to a family? */
export function isMapped(model: string): boolean {
  try { resolveFamily(model); return true; } catch { return false; }
}

/** The set of families the registry currently recognises (for reporting / audit). */
export function knownFamilies(): string[] {
  return [...KNOWN_FAMILIES];
}
