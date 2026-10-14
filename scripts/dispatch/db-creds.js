/**
 * db-creds.js — which database credential the daily state snapshot (status.mjs) may use.
 *
 * CommonJS on purpose, like lessons-lib.js, so the jest suite can require it.
 *
 * WHY THIS EXISTS. The snapshot accepted only a legacy service_role JWT (`eyJ…`) from
 * SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY / ~/.sb-service-key / a repo-root
 * service_role.txt. Legacy API keys are disabled on Trinity prod, so from 2026-10-12 every run
 * wrote "⚠ DB status failed: Legacy API keys are disabled" and no ecosystem numbers.
 *
 * Same precedence as the engine's own server reads (src/config.ts):
 *   1. SUPABASE_SECRET_KEY — the new-format `sb_secret_…` key, via supabase-js.
 *   2. DATABASE_URL        — the Postgres (pooler) connection string, via pg.
 * Each is read from the process environment first, then from .env.master.
 * Legacy JWT names are NOT used: they are disabled on this project, and accepting one would only
 * reproduce the confusing failure above. No credential means a precise error, never a silent skip.
 */
'use strict';

const DEFAULT_SUPABASE_URL = 'https://qnnpjhlxljtqyigedwkb.supabase.co';
const LEGACY_NAMES = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY'];

const NO_CREDS =
  'no usable DB credential: set SUPABASE_SECRET_KEY (an sb_secret_… key, the engine\'s canonical server key) '
  + 'or DATABASE_URL, in the environment or in .env.master. Legacy JWT keys (SUPABASE_SERVICE_ROLE_KEY / '
  + 'SUPABASE_SERVICE_KEY) are disabled on this project and are not used.';

/**
 * @param {Record<string, string | undefined>} env   process.env
 * @param {(name: string) => string | null} fromFile  reads one value from .env.master (never logged)
 * @returns {{mode:'rest', supaUrl:string, key:string} | {mode:'pg', url:string} | {mode:'none', why:string}}
 */
function resolveDbCreds(env, fromFile = () => null) {
  const pick = (name) => {
    const v = (env[name] || fromFile(name) || '').trim();
    return v || null;
  };
  const supaUrl = pick('SUPABASE_URL') || DEFAULT_SUPABASE_URL;
  const secret = pick('SUPABASE_SECRET_KEY');
  if (secret && secret.startsWith('sb_secret_')) return { mode: 'rest', supaUrl, key: secret };
  const dbUrl = pick('DATABASE_URL');
  if (dbUrl && /^postgres(ql)?:\/\//.test(dbUrl)) return { mode: 'pg', url: dbUrl };
  if (secret) {
    return { mode: 'none', why: 'SUPABASE_SECRET_KEY is set but is not an sb_secret_… key, and no DATABASE_URL is set. ' + NO_CREDS };
  }
  const legacy = LEGACY_NAMES.filter((n) => env[n] || fromFile(n));
  return {
    mode: 'none',
    why: legacy.length ? `${NO_CREDS} (found only legacy ${legacy.join(', ')})` : NO_CREDS,
  };
}

module.exports = { resolveDbCreds, NO_CREDS, DEFAULT_SUPABASE_URL };
