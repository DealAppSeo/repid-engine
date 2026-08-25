/**
 * HAL runtime config layer (Sprint 2026-07-05).
 *
 * Resolves HAL's operational knobs — per-provider enablement, pipeline
 * strictness, and the two quorum gates — from the Supabase `repid_config`
 * table so they can be changed from a phone / the Supabase dashboard / by an
 * agent via a single SQL `UPDATE`, WITHOUT a Railway redeploy.
 *
 * Precedence per knob (highest wins):
 *   1. `repid_config` row (key present)  → live, no-redeploy control
 *   2. environment variable (fallback)   → today's behavior, unchanged
 *   3. hardcoded default                 → last resort
 *
 * Caching: the full config set is read in ONE query and cached in-memory with
 * a short TTL (default 45s, override HAL_CONFIG_TTL_MS). A mobile/SQL change
 * therefore takes effect within ~one TTL window without a redeploy, and the DB
 * is not hit per request.
 *
 * Fail-safe: if the DB read throws (network / auth / table gone), we NEVER
 * crash HAL — we fall back to env → default and log loudly. The stale cache (if
 * any) is preferred over a hard failure.
 *
 * Master flag `HAL_CONFIG_FROM_DB` (default 'true'): set to 'false' to ignore
 * `repid_config` entirely and resolve from env/default only (one-env-var
 * reversal of this whole feature).
 *
 * NOTE: this module reads `repid_config` only. It never writes it. Seeding /
 * changing rows is done out-of-band via SQL (see the seed block in the sprint
 * report).
 */
import { db } from '../db';

/** repid_config keys this layer resolves. */
const PROVIDER_ENABLE_KEYS = [
  'HAL_S2_ENABLE_GROQ',
  'HAL_S2_ENABLE_CEREBRAS',
  'HAL_S2_ENABLE_FIREWORKS',
  'HAL_S2_ENABLE_DEEPSEEK',
  'HAL_S2_ENABLE_GEMINI',
  'HAL_S2_ENABLE_MISTRAL',
  'HAL_S2_ENABLE_QWEN',
  'HAL_S2_ENABLE_ANTHROPIC',
  'HAL_S2_ENABLE_GLOO',
] as const;

const BOOL_KEYS = [
  ...PROVIDER_ENABLE_KEYS,
  'HAL_DECISION_REQUIRES_QUORUM',
  'HAL_PENALTY_REQUIRES_QUORUM',
] as const;

/** All keys the layer looks up in one batched query. */
const ALL_KEYS = [...BOOL_KEYS, 'HAL_STRICTNESS'] as const;

export type HalConfigKey = (typeof ALL_KEYS)[number];

export interface HalConfig {
  /** Per-provider enable flags for the strictness-2 fact-check quorum. */
  providers: Record<(typeof PROVIDER_ENABLE_KEYS)[number], boolean>;
  /** Pipeline strictness (1 = extractor, 2 = cross-LLM fact-check). */
  strictness: 1 | 2;
  /** Quorum gates (both default ON / true = fail-safe). */
  decisionRequiresQuorum: boolean;
  penaltyRequiresQuorum: boolean;
  /** Where each resolved value came from (for loud logging / debugging). */
  source: Record<HalConfigKey, 'db' | 'env' | 'default'>;
}

// ---- defaults (must mirror the pre-existing env-default behavior exactly) ----
// Providers that are ON by default today (env unset): groq + cerebras. All
// other providers are opt-in (default OFF) — matches buildFactCheckProviders().
const PROVIDER_DEFAULTS: Record<(typeof PROVIDER_ENABLE_KEYS)[number], boolean> = {
  HAL_S2_ENABLE_GROQ: true,
  HAL_S2_ENABLE_CEREBRAS: true,
  HAL_S2_ENABLE_FIREWORKS: false,
  HAL_S2_ENABLE_DEEPSEEK: false,
  HAL_S2_ENABLE_GEMINI: false,
  HAL_S2_ENABLE_MISTRAL: false,
  HAL_S2_ENABLE_QWEN: false,
  HAL_S2_ENABLE_ANTHROPIC: false,
  HAL_S2_ENABLE_GLOO: false,
};

const TTL_MS = (() => {
  const n = Number(process.env.HAL_CONFIG_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 45_000;
})();

function configFromDbEnabled(): boolean {
  return process.env.HAL_CONFIG_FROM_DB !== 'false';
}

// ---- in-memory cache ----
interface CacheEntry {
  rows: Record<string, string>; // key -> value (only keys we asked for, present ones)
  fetchedAt: number;
}
let cache: CacheEntry | null = null;
let inflight: Promise<Record<string, string>> | null = null;

/** Fetch (or reuse cached) repid_config rows for HAL keys. Fail-safe. */
async function loadRows(): Promise<Record<string, string>> {
  if (!configFromDbEnabled()) return {};

  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) return cache.rows;

  // Coalesce concurrent refreshes into one query.
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { data, error } = await db
        .from('repid_config')
        .select('key, value')
        .in('key', ALL_KEYS as unknown as string[]);
      if (error) throw new Error(error.message);
      const rows: Record<string, string> = {};
      for (const r of (data ?? []) as Array<{ key: string; value: string }>) {
        if (r && typeof r.key === 'string' && typeof r.value === 'string') rows[r.key] = r.value;
      }
      cache = { rows, fetchedAt: Date.now() };
      return rows;
    } catch (e) {
      // FAIL SAFE: never crash HAL. Prefer a stale cache; else empty (→ env/default).
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[hal-config] repid_config read failed, falling back to env/default: ${msg}`);
      if (cache) return cache.rows;
      return {};
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
}

/**
 * Resolve one boolean knob with DB → env → default precedence.
 * `dbVal` is the raw repid_config value (or undefined if the row is absent).
 */
function resolveBool(
  dbVal: string | undefined,
  envVal: string | undefined,
  def: boolean,
): { value: boolean; source: 'db' | 'env' | 'default' } {
  const fromDb = parseBool(dbVal);
  if (fromDb !== undefined) return { value: fromDb, source: 'db' };
  const fromEnv = parseBool(envVal);
  if (fromEnv !== undefined) return { value: fromEnv, source: 'env' };
  return { value: def, source: 'default' };
}

/**
 * Resolve the full HAL config. Cached (TTL); safe to call per request.
 * Never throws — degrades to env/default on any DB error.
 */
export async function getHalConfig(): Promise<HalConfig> {
  const rows = await loadRows();
  const source = {} as Record<HalConfigKey, 'db' | 'env' | 'default'>;

  const providers = {} as Record<(typeof PROVIDER_ENABLE_KEYS)[number], boolean>;
  for (const key of PROVIDER_ENABLE_KEYS) {
    const r = resolveBool(rows[key], process.env[key], PROVIDER_DEFAULTS[key]);
    providers[key] = r.value;
    source[key] = r.source;
  }

  const dq = resolveBool(rows.HAL_DECISION_REQUIRES_QUORUM, process.env.HAL_DECISION_REQUIRES_QUORUM, true);
  source.HAL_DECISION_REQUIRES_QUORUM = dq.source;
  const pq = resolveBool(rows.HAL_PENALTY_REQUIRES_QUORUM, process.env.HAL_PENALTY_REQUIRES_QUORUM, true);
  source.HAL_PENALTY_REQUIRES_QUORUM = pq.source;

  // Strictness: only '2' → 2; anything else (incl. absent/malformed) → 1.
  // Mirrors resolveHalStrictness() exactly. DB row wins if it decides the value.
  const dbStrict = rows.HAL_STRICTNESS;
  const envStrict = process.env.HAL_STRICTNESS;
  let strictness: 1 | 2;
  if (dbStrict !== undefined) {
    strictness = dbStrict.trim() === '2' ? 2 : 1;
    source.HAL_STRICTNESS = 'db';
  } else if (envStrict !== undefined) {
    strictness = envStrict === '2' ? 2 : 1;
    source.HAL_STRICTNESS = 'env';
  } else {
    strictness = 1;
    source.HAL_STRICTNESS = 'default';
  }

  return {
    providers,
    strictness,
    decisionRequiresQuorum: dq.value,
    penaltyRequiresQuorum: pq.value,
    source,
  };
}

/** Force the next getHalConfig() to re-read the DB (tests / admin refresh). */
export function invalidateHalConfigCache(): void {
  cache = null;
}
