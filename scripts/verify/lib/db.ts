/**
 * Standalone Supabase access for the verify suite.
 *
 * Deliberately does NOT import src/config or src/db — those throw at import time if
 * SUPABASE_* is missing, which would crash the whole suite before the DB-free checks
 * (authority, f2-authz) can run. Here, missing credentials degrade a single check to
 * SKIP, never a crash.
 *
 * Raw SQL goes through the project's `exec_sql(query text)` RPC (returns rows as a JSON
 * array), so pg_catalog reads work with just the service-role key — no DATABASE_URL /
 * direct-pg needed. CI provides the key via secrets.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let loaded = false;
/** Load .env into process.env once, without adding a dotenv dependency. CI uses real env. */
function loadEnvOnce(): void {
  if (loaded) return;
  loaded = true;
  const envPath = join(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const name = m[1]!, raw = m[2] ?? '';
    if (process.env[name] === undefined) process.env[name] = raw.replace(/^["']|["']$/g, '');
  }
}

export function supabaseCreds(): { url?: string; key?: string } {
  loadEnvOnce();
  return {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

let client: SupabaseClient | null = null;
/** null if credentials are absent (caller should SKIP). */
export function getDb(): SupabaseClient | null {
  if (client) return client;
  const { url, key } = supabaseCreds();
  if (!url || !key) return null;
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

/** Run a read-only SQL statement and return rows. Throws if no DB or the RPC errors. */
export async function sqlExec<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const db = getDb();
  if (!db) throw new Error('no Supabase credentials (SUPABASE_URL + SUPABASE_SERVICE_KEY)');
  const { data, error } = await db.rpc('exec_sql', { query });
  if (error) throw new Error(`exec_sql failed: ${error.message}`);
  return (Array.isArray(data) ? data : []) as T[];
}
