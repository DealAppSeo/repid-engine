/**
 * HAL CHECKPOINT REGISTRY + WEIGHT-DEDUP SELECTION.
 * OUTPUT_PATH: src/hal/checkpoint-registry.ts
 * MOTIVATION: reports/2026-07-09 HAL rigorous eval (N=337).
 *
 * THE PROBLEM the eval surfaced
 * -----------------------------
 * HAL's family-independence quorum counts DISTINCT MODEL FAMILIES (see familyOf/familyOfResolved in
 * src/hal/fact-check.ts). "Family" is BRAND-level (llama / qwen / deepseek). Two failure modes:
 *   1. UNDER-COUNT (fake diversity): two DIFFERENT hosts serving the SAME underlying weights —
 *      e.g. Groq `llama-3.1-8b` and DeepInfra `llama-3.1-8b` — error-correlate 0.881 in the eval.
 *      They are ONE independent vote, not two. Family DOES collapse these (both 'llama'), but only
 *      by luck of the brand string; a spoofable regex host label can dodge it.
 *   2. OVER-COUNT the wrong axis: `qwen-72b` and `qwen-7b` are the SAME family 'qwen' yet are
 *      GENUINELY DIFFERENT checkpoints (different weights, far lower error-correlation). Family
 *      counting collapses them to one vote; the correlation that actually matters tracks the
 *      CHECKPOINT (the weights), not the brand.
 *
 * THE FIX (this module)
 * ---------------------
 * An EXPLICIT, curated host+model -> model CHECKPOINT registry (NOT a regex guess). The quorum must
 * never count two hosts that share a checkpoint as two independent votes. A model absent from the
 * registry is a LOUD FLAG and is treated as its OWN distinct singleton checkpoint — NEVER silently
 * merged with anything (so an unknown host can only ever REDUCE independence for itself, never fake it).
 *
 * WHY A REGISTRY, NOT PARSING (mirrors the family-registry rationale, §7): correlation must be an
 * explicit lookup an operator can audit and extend, not a substring heuristic that a crafted model
 * string can spoof. `groq/llama-3.1-8b` and `deepinfra/llama-3.1-8b` map to the SAME checkpoint id
 * `llama-3.1-8b-instruct`; `qwen-2.5-72b` and `qwen-2.5-7b` map to DIFFERENT ones.
 *
 * PURITY: pure lookups + pure (seeded, deterministic) selection. No I/O, no env reads in the core
 * functions (the env flag is read by the caller). No throws on the live path — an unmapped model
 * resolves to a distinct singleton, never an exception.
 */

export interface CheckpointRef {
  /** provider / host label (part of the lookup key AND the unmapped-singleton key). */
  provider?: string;
  /** model string as configured for this host. */
  model: string;
}

export interface CheckpointResolution {
  /** the checkpoint id (weights identity). For an unmapped model this is a per-(provider,model) singleton. */
  checkpoint: string;
  /** true iff resolved from the explicit registry; false = unmapped fallback singleton (LOUD flag). */
  mapped: boolean;
}

/**
 * A curated registry entry. `provider` is OPTIONAL:
 *   - entry WITH provider  -> host-specific mapping (`groq` `llama-3.1-8b-instant` -> `llama-3.1-8b-instruct`).
 *   - entry WITHOUT provider -> model-string default that applies for ANY host serving that model
 *     (most model strings are unambiguous about their weights regardless of host).
 * Host-specific entries win over model-default entries at lookup time.
 */
export interface CheckpointRegistryEntry {
  provider?: string;
  model: string;
  /** the weights-identity id. Two entries with the SAME checkpoint = the SAME underlying weights. */
  checkpoint: string;
  /** short provenance note (why this maps here / source of truth). */
  note?: string;
}

/**
 * SEED. Every model here is one HAL actually configures (src/hal/fact-check.ts builder) or one present
 * in the family-registry telemetry seed, plus the cross-host duplicates the eval flagged (groq vs
 * deepinfra Llama-3.1-8B). Checkpoint ids are lowercase, host-agnostic weights labels.
 *
 * THE LOAD-BEARING PAIR (eval finding): groq + deepinfra + cerebras all serving Llama-3.1-8B collapse
 * to the ONE checkpoint `llama-3.1-8b-instruct`. Distinct SIZE (8b vs 70b) or LINEAGE (2.5-72b vs
 * 2.5-7b) => distinct checkpoint => still allowed to count separately.
 */
export const CHECKPOINT_REGISTRY_SEED: readonly CheckpointRegistryEntry[] = Object.freeze([
  // ---- Llama 3.1 8B: the multi-host SAME-WEIGHTS collapse the eval measured (corr 0.881) ----
  { provider: 'groq',      model: 'llama-3.1-8b-instant', checkpoint: 'llama-3.1-8b-instruct', note: 'Groq host of Llama-3.1-8B-Instruct' },
  { provider: 'cerebras',  model: 'llama3.1-8b',          checkpoint: 'llama-3.1-8b-instruct', note: 'Cerebras host of the same 8B weights' },
  { provider: 'deepinfra', model: 'llama-3.1-8b',         checkpoint: 'llama-3.1-8b-instruct', note: 'DeepInfra host — eval corr 0.881 vs Groq' },
  { provider: 'deepinfra', model: 'meta-llama/meta-llama-3.1-8b-instruct', checkpoint: 'llama-3.1-8b-instruct', note: 'DeepInfra canonical slug, same weights' },
  { model: 'llama-3.1-8b-instant',          checkpoint: 'llama-3.1-8b-instruct', note: 'model-default: any host of the 8B instant weights' },
  { model: 'llama3.1-8b',                   checkpoint: 'llama-3.1-8b-instruct' },
  { model: 'llama-3.2-1b-instruct',         checkpoint: 'llama-3.2-1b-instruct', note: 'DISTINCT size from 8B — not merged' },
  // ---- Llama 3.3 70B — DIFFERENT weights from the 8B; MUST NOT merge with it ----
  { provider: 'groq',      model: 'llama-3.3-70b-versatile', checkpoint: 'llama-3.3-70b-instruct', note: 'distinct SIZE => distinct checkpoint' },
  { model: 'llama-3.3-70b-versatile',       checkpoint: 'llama-3.3-70b-instruct' },
  // ---- GLM (cerebras zai) ----
  { provider: 'cerebras',  model: 'zai-glm-4.7',          checkpoint: 'glm-4.7' },
  { model: 'zai-glm-4.7',                    checkpoint: 'glm-4.7' },
  // ---- DeepSeek: chat (V3) vs reasoner (R1) are DIFFERENT weights ----
  { provider: 'deepseek',  model: 'deepseek-chat',        checkpoint: 'deepseek-v3-chat' },
  { model: 'deepseek-chat',                  checkpoint: 'deepseek-v3-chat' },
  { provider: 'deepseek',  model: 'deepseek-reasoner',    checkpoint: 'deepseek-r1' },
  { model: 'deepseek-reasoner',              checkpoint: 'deepseek-r1' },
  { model: 'hf/deepseek-r1-qwen-32b',        checkpoint: 'deepseek-r1-distill-qwen-32b', note: 'R1 distill on Qwen-32B — its own weights' },
  // ---- Gemini: 2.0-flash / 2.5-flash / 3.5-flash are DIFFERENT weights (even the OpenRouter re-route) ----
  { provider: 'gemini',    model: 'gemini-2.0-flash',     checkpoint: 'gemini-2.0-flash' },
  { model: 'gemini-2.0-flash',               checkpoint: 'gemini-2.0-flash' },
  { model: 'models/gemini-2.5-flash',        checkpoint: 'gemini-2.5-flash' },
  { model: 'gemini-2.5-flash',               checkpoint: 'gemini-2.5-flash' },
  { provider: 'gemini',    model: 'google/gemini-3.5-flash', checkpoint: 'gemini-3.5-flash', note: 'OpenRouter re-route of the gemini family — 3.5 weights' },
  { model: 'google/gemini-3.5-flash',        checkpoint: 'gemini-3.5-flash' },
  // ---- Mistral ----
  { provider: 'mistral',   model: 'mistral-small-latest', checkpoint: 'mistral-small' },
  { model: 'mistral-small-latest',           checkpoint: 'mistral-small' },
  // ---- Kimi (fireworks) ----
  { provider: 'fireworks', model: 'accounts/fireworks/models/kimi-k2p5', checkpoint: 'kimi-k2p5' },
  { model: 'accounts/fireworks/models/kimi-k2p5', checkpoint: 'kimi-k2p5' },
  // ---- Qwen: 2.5-72b (openrouter/litellm SAME weights) vs qwen-plus vs a 7B are DIFFERENT ----
  { provider: 'openrouter', model: 'qwen/qwen-2.5-72b-instruct', checkpoint: 'qwen-2.5-72b-instruct' },
  { model: 'qwen/qwen-2.5-72b-instruct',     checkpoint: 'qwen-2.5-72b-instruct' },
  { provider: 'litellm',   model: 'hf/qwen-2.5-72b',      checkpoint: 'qwen-2.5-72b-instruct', note: 'litellm host of the SAME 72B weights as openrouter' },
  { model: 'hf/qwen-2.5-72b',                checkpoint: 'qwen-2.5-72b-instruct' },
  { model: 'qwen/qwen-2.5-7b-instruct',      checkpoint: 'qwen-2.5-7b-instruct', note: 'DISTINCT lineage/size from 72B — the eval example' },
  { provider: 'qwen',      model: 'qwen-plus',            checkpoint: 'qwen-plus', note: 'Alibaba hosted qwen-plus — its own weights' },
  { model: 'qwen-plus',                      checkpoint: 'qwen-plus' },
  // ---- Anthropic ----
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', checkpoint: 'claude-haiku-4.5' },
  { model: 'claude-haiku-4-5-20251001',      checkpoint: 'claude-haiku-4.5' },
  // ---- OpenAI ----
  { provider: 'openai',    model: 'gpt-4o-mini',          checkpoint: 'gpt-4o-mini' },
  { model: 'gpt-4o-mini',                    checkpoint: 'gpt-4o-mini' },
]);

const norm = (s: string | undefined | null): string => String(s ?? '').trim().toLowerCase();

// provider+model -> checkpoint (host-specific, wins)
const BY_PROVIDER_MODEL = new Map<string, string>();
// model -> checkpoint (host-agnostic default)
const BY_MODEL = new Map<string, string>();
for (const e of CHECKPOINT_REGISTRY_SEED) {
  const m = norm(e.model);
  if (e.provider) BY_PROVIDER_MODEL.set(`${norm(e.provider)} ${m}`, e.checkpoint);
  else if (!BY_MODEL.has(m)) BY_MODEL.set(m, e.checkpoint);
}
// Also let a host-specific entry seed the model-default when no explicit model-default row exists,
// so `resolveCheckpoint(undefined, model)` still resolves for a model only ever seen with one host.
for (const e of CHECKPOINT_REGISTRY_SEED) {
  const m = norm(e.model);
  if (!BY_MODEL.has(m)) BY_MODEL.set(m, e.checkpoint);
}

/** Distinct singleton checkpoint id for an unmapped (provider, model) — never merges with anything. */
export function unmappedCheckpointId(provider: string | undefined, model: string): string {
  return `unmapped:${norm(provider) || 'noprovider'}/${norm(model) || 'nomodel'}`;
}

/**
 * Resolve a host+model to its weights-identity checkpoint. REGISTRY-ONLY (no substring guessing):
 *   1) host-specific (provider, model) entry, else
 *   2) model-default entry, else
 *   3) UNMAPPED -> a per-(provider,model) singleton id + mapped:false (caller must flag it LOUD).
 * Never throws.
 */
export function resolveCheckpoint(provider: string | undefined, model: string): CheckpointResolution {
  const m = norm(model);
  const hostKey = `${norm(provider)} ${m}`;
  const host = BY_PROVIDER_MODEL.get(hostKey);
  if (host) return { checkpoint: host, mapped: true };
  const byModel = BY_MODEL.get(m);
  if (byModel) return { checkpoint: byModel, mapped: true };
  return { checkpoint: unmappedCheckpointId(provider, model), mapped: false };
}

/** Non-throwing probe: is this host+model in the checkpoint registry? */
export function isCheckpointMapped(provider: string | undefined, model: string): boolean {
  return resolveCheckpoint(provider, model).mapped;
}

// ---------------------------------------------------------------------------------------------------
// Deterministic seeded RNG (mulberry32 + FNV-1a seed hash) — mirrors src/decisioning/disjointness.ts
// so selection is reproducible under test (fixed seed) and varies per check in prod (random seed).
// ---------------------------------------------------------------------------------------------------

function seedHash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seedInt: number): () => number {
  let a = seedInt >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle over a COPY, driven by a seeded RNG (pure; input untouched). */
function seededShuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i]!;
    const b = out[j]!;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

export interface CheckpointGroup {
  checkpoint: string;
  mapped: boolean;
  members: CheckpointRef[];
}

export interface DedupResult<T extends CheckpointRef> {
  /** exactly one member per distinct checkpoint (weights). */
  kept: T[];
  /** members dropped because another member with the SAME checkpoint was kept (fake-diversity removals). */
  dropped: T[];
  /** every distinct checkpoint and its members (for the glass-box shadow log). */
  groups: CheckpointGroup[];
  /** checkpoints that came from the UNMAPPED fallback (each a singleton; surfaced for registration). */
  unmapped: Array<{ provider?: string; model: string; checkpoint: string }>;
}

/** Group refs by resolved checkpoint, preserving first-seen order of the groups. */
function groupByCheckpoint<T extends CheckpointRef>(refs: readonly T[]): {
  order: string[];
  byCk: Map<string, { mapped: boolean; members: T[] }>;
} {
  const byCk = new Map<string, { mapped: boolean; members: T[] }>();
  const order: string[] = [];
  for (const r of refs) {
    const res = resolveCheckpoint(r.provider, r.model);
    const g = byCk.get(res.checkpoint);
    if (g) {
      g.members.push(r);
    } else {
      byCk.set(res.checkpoint, { mapped: res.mapped, members: [r] });
      order.push(res.checkpoint);
    }
  }
  return { order, byCk };
}

/**
 * WEIGHT-DEDUP: keep exactly ONE host per checkpoint so two hosts sharing weights can never count as
 * two independent votes. Deterministic given `seed` (which member of a shared-checkpoint group is
 * kept is chosen by the seeded RNG; without a seed, the first-seen member is kept — stable). Unmapped
 * models are singletons (their own checkpoint) and are ALWAYS kept, but surfaced in `unmapped`.
 */
export function dedupByCheckpoint<T extends CheckpointRef>(refs: readonly T[], seed?: string): DedupResult<T> {
  const { order, byCk } = groupByCheckpoint(refs);
  const rng = seed != null ? mulberry32(seedHash(seed)) : null;
  const kept: T[] = [];
  const dropped: T[] = [];
  const groups: CheckpointGroup[] = [];
  const unmapped: Array<{ provider?: string; model: string; checkpoint: string }> = [];

  for (const ck of order) {
    const g = byCk.get(ck)!;
    groups.push({ checkpoint: ck, mapped: g.mapped, members: g.members.slice() });
    if (!g.mapped) {
      for (const m of g.members) unmapped.push({ provider: m.provider, model: m.model, checkpoint: ck });
    }
    // Choose the survivor: seeded pick when a seed is given, else first-seen (stable).
    let keepIdx = 0;
    if (rng && g.members.length > 1) keepIdx = Math.floor(rng() * g.members.length);
    g.members.forEach((m, i) => (i === keepIdx ? kept.push(m) : dropped.push(m)));
  }
  return { kept, dropped, groups, unmapped };
}

export interface StochasticSubset<T extends CheckpointRef> extends DedupResult<T> {
  /** the randomized, checkpoint-diverse subset actually selected (<= k, one host per checkpoint). */
  selected: T[];
  /** the distinct checkpoints represented in `selected`. */
  selectedCheckpoints: string[];
  /** requested subset size. */
  k: number;
}

/**
 * STOCHASTIC, CHECKPOINT-DIVERSE SELECTION (Sean's directive): first weight-dedup (one host per
 * checkpoint), then draw a RANDOMIZED subset of up to `k` DISTINCT checkpoints. Randomizing which
 * checkpoints are drawn each check spreads load and denies a gamer a fixed target roster, while the
 * dedup guarantees the subset never contains two same-weights hosts.
 *
 * Deterministic given (`seed`, refs, k): same inputs -> same subset (testable). In prod the caller
 * passes a per-check random seed (e.g. the quorum uuid) so successive checks vary. If fewer than `k`
 * distinct checkpoints exist, ALL of them are returned (never padded with a duplicate-weights host).
 */
export function stochasticCheckpointDiverseSubset<T extends CheckpointRef>(
  refs: readonly T[],
  k: number,
  seed: string,
): StochasticSubset<T> {
  const deduped = dedupByCheckpoint(refs, seed);
  const rng = mulberry32(seedHash(`${seed} subset`));
  // Shuffle the deduped survivors, then take k. (Each survivor is a distinct checkpoint already.)
  const shuffled = seededShuffle(deduped.kept, rng);
  const take = Math.max(0, Math.min(k, shuffled.length));
  const selected = shuffled.slice(0, take);
  const selectedCheckpoints = selected.map((s) => resolveCheckpoint(s.provider, s.model).checkpoint);
  return { ...deduped, selected, selectedCheckpoints, k };
}

export type WeightDedupMode = 'off' | 'shadow' | 'on';

/**
 * Resolve the HAL_QUORUM_WEIGHT_DEDUP flag. DEFAULT = 'off' (current behavior; live quorum unchanged).
 * 'shadow' = compute + log what dedup/stochastic WOULD select vs current, mutate nothing.
 * 'on' = actually dedup (and optionally stochastically subsample) the quorum before counting votes.
 * Any unrecognized value falls back to 'off' (fail-closed to today's behavior).
 */
export function weightDedupMode(raw: string | undefined = process.env.HAL_QUORUM_WEIGHT_DEDUP): WeightDedupMode {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'shadow') return 'shadow';
  if (s === 'on') return 'on';
  return 'off';
}

/**
 * Resolve the stochastic subset size `k` from HAL_QUORUM_STOCHASTIC_K. Default 0 = "no subsampling"
 * (dedup only; keep every distinct checkpoint). A positive integer draws that many distinct
 * checkpoints. `0`/absent/invalid -> 0 (dedup-only), preserving maximal quorum breadth by default.
 */
export function stochasticK(raw: string | undefined = process.env.HAL_QUORUM_STOCHASTIC_K): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The set of checkpoint ids the registry currently recognises (for reporting / audit). */
export function knownCheckpoints(): string[] {
  return [...new Set(CHECKPOINT_REGISTRY_SEED.map((e) => e.checkpoint))].sort();
}
