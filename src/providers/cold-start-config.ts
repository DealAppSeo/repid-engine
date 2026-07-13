/**
 * cold-start-config.ts — runtime config for cold-start PREMIUM routing (CC, task 22, 2026-07-12).
 *
 * Resolves the cold-start knobs from the Supabase `repid_config` table (phone / dashboard / SQL
 * controllable, no redeploy), mirroring the precedence + fail-safe + TTL-cache pattern of
 * `src/hal/config.ts`:
 *
 *   1. `repid_config` row (key present)  → live control
 *   2. environment variable (fallback)
 *   3. hardcoded default
 *
 * Keys (already live in repid_config, verified 2026-07-12):
 *   - cold_start_premium_enabled       (bool, default false — MASTER; nothing happens while false)
 *   - cold_start_premium_max_questions (int,  default 3)
 *   - cold_start_premium_scope         (csv,  default 'new_user,new_chat,testing')
 *   - cold_start_anfis_gate            (bool, default true — let the difficulty gate spare trivial Qs)
 *
 * Fail-safe: a DB read failure NEVER throws — it degrades to env → default (and, in effect, to
 * "premium disabled" since the master flag defaults false). Read is cached in-memory (TTL, default
 * 45s) so it is safe to call per request.
 *
 * This module ONLY reads repid_config; it never writes it. The GATE DECISION (is premium active for
 * THIS request?) lives in providers/router.ts, which owns `isLowComplexity` (the ANFIS difficulty
 * gate) — keeping this module a pure config resolver and avoiding an import cycle.
 */
import { db } from '../db';

export type ColdStartScope = 'new_user' | 'new_chat' | 'testing';

export interface ColdStartConfig {
  /** MASTER flag. While false, cold-start premium is entirely inert. */
  enabled: boolean;
  /** Route the first N questions of a qualifying session to frontier/premium LLMs. */
  maxQuestions: number;
  /** Which session kinds qualify for the premium window. */
  scopes: Set<ColdStartScope>;
  /** When true, a trivially-easy question is NOT sent to a frontier model (ANFIS difficulty gate). */
  anfisGate: boolean;
  source: Record<string, 'db' | 'env' | 'default'>;
}

const KEYS = [
  'cold_start_premium_enabled',
  'cold_start_premium_max_questions',
  'cold_start_premium_scope',
  'cold_start_anfis_gate',
] as const;

const DEFAULTS = {
  enabled: false,
  maxQuestions: 3,
  scope: 'new_user,new_chat,testing',
  anfisGate: true,
};

const TTL_MS = (() => {
  const n = Number(process.env.COLD_START_CONFIG_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : 45_000;
})();

function configFromDbEnabled(): boolean {
  // Shares HAL's master DB-config switch so one flag disables all repid_config-driven config.
  return process.env.HAL_CONFIG_FROM_DB !== 'false';
}

interface CacheEntry { rows: Record<string, string>; fetchedAt: number; }
let cache: CacheEntry | null = null;
let inflight: Promise<Record<string, string>> | null = null;

async function loadRows(): Promise<Record<string, string>> {
  if (!configFromDbEnabled()) return {};
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) return cache.rows;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const { data, error } = await db.from('repid_config').select('key, value').in('key', KEYS as unknown as string[]);
      if (error) throw new Error(error.message);
      const rows: Record<string, string> = {};
      for (const r of (data ?? []) as Array<{ key: string; value: string }>) {
        if (r && typeof r.key === 'string' && typeof r.value === 'string') rows[r.key] = r.value;
      }
      cache = { rows, fetchedAt: Date.now() };
      return rows;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cold-start-config] repid_config read failed, falling back to env/default: ${msg}`);
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

function resolveBool(dbVal: string | undefined, envVal: string | undefined, def: boolean): { value: boolean; source: 'db' | 'env' | 'default' } {
  const fromDb = parseBool(dbVal);
  if (fromDb !== undefined) return { value: fromDb, source: 'db' };
  const fromEnv = parseBool(envVal);
  if (fromEnv !== undefined) return { value: fromEnv, source: 'env' };
  return { value: def, source: 'default' };
}

function parseScopes(v: string | undefined): Set<ColdStartScope> {
  const valid: ColdStartScope[] = ['new_user', 'new_chat', 'testing'];
  const set = new Set<ColdStartScope>();
  for (const raw of String(v ?? '').split(',')) {
    const s = raw.trim().toLowerCase();
    if ((valid as string[]).includes(s)) set.add(s as ColdStartScope);
  }
  return set;
}

/** Resolve the cold-start config. Cached (TTL); safe per request. Never throws. */
export async function getColdStartConfig(): Promise<ColdStartConfig> {
  const rows = await loadRows();
  const source: Record<string, 'db' | 'env' | 'default'> = {};

  const en = resolveBool(rows.cold_start_premium_enabled, process.env.COLD_START_PREMIUM_ENABLED, DEFAULTS.enabled);
  source.enabled = en.source;

  // maxQuestions: db → env → default; must be a positive integer.
  let maxQuestions = DEFAULTS.maxQuestions;
  const dbMax = rows.cold_start_premium_max_questions;
  const envMax = process.env.COLD_START_PREMIUM_MAX_QUESTIONS;
  const pickInt = (s: string | undefined): number | undefined => {
    if (s == null) return undefined;
    const n = Number(s.trim());
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const dbMaxN = pickInt(dbMax);
  const envMaxN = pickInt(envMax);
  if (dbMaxN !== undefined) { maxQuestions = dbMaxN; source.maxQuestions = 'db'; }
  else if (envMaxN !== undefined) { maxQuestions = envMaxN; source.maxQuestions = 'env'; }
  else { source.maxQuestions = 'default'; }

  // scopes: db → env → default.
  const dbScope = rows.cold_start_premium_scope;
  const envScope = process.env.COLD_START_PREMIUM_SCOPE;
  let scopeStr = DEFAULTS.scope;
  if (dbScope !== undefined) { scopeStr = dbScope; source.scopes = 'db'; }
  else if (envScope !== undefined) { scopeStr = envScope; source.scopes = 'env'; }
  else { source.scopes = 'default'; }

  const ag = resolveBool(rows.cold_start_anfis_gate, process.env.COLD_START_ANFIS_GATE, DEFAULTS.anfisGate);
  source.anfisGate = ag.source;

  return {
    enabled: en.value,
    maxQuestions,
    scopes: parseScopes(scopeStr),
    anfisGate: ag.value,
    source,
  };
}

/** Force the next getColdStartConfig() to re-read the DB (tests / admin refresh). */
export function invalidateColdStartConfigCache(): void {
  cache = null;
}
