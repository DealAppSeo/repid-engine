/**
 * S-AUD1 — hash-chain verifier. Walks a hash-chained audit table and returns VALID or
 * CHAIN_BREAK (with the first offending row id). Exit 0 = VALID, 1 = CHAIN_BREAK, 2 = error.
 *
 *   ts-node scripts/audit/verify-chain.ts                 # hal_production_events (default)
 *   ts-node scripts/audit/verify-chain.ts --table tool_call_log
 *   ts-node scripts/audit/verify-chain.ts --json
 *
 * The recompute runs IN-DB via the exec_sql RPC, using the SAME serialization the trigger used
 * — (to_jsonb(row) - 'previous_entry_hash')::text, chained from the prior row's hash, genesis
 * sentinel 'GENESIS'. Doing it server-side guarantees byte-identical content (a JS reproduction
 * of Postgres row serialization would drift). Any row whose stored hash != recomputed hash is a
 * break (tamper or an out-of-band UPDATE). Rows with NULL previous_entry_hash are pre-migration /
 * un-backfilled and reported separately (not counted as breaks).
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

// Only audit tables that carry the chain trigger — also guards the table-name interpolation below.
const ALLOWED = new Set(['hal_production_events', 'tool_call_log']);

function loadEnv() {
  const p = join(process.cwd(), '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = (m[2] ?? '').replace(/^["']|["']$/g, '');
  }
}
function arg(flag: string): string | undefined { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; }

function verifySql(table: string): string {
  // recomputed = sha256( coalesce(prev_stored,'GENESIS') || content ), content = row minus chain col.
  const recomputed = `encode(digest(coalesce(prev_stored,'GENESIS') || ((to_jsonb(chain) - 'previous_entry_hash' - 'prev_stored')::text), 'sha256'),'hex')`;
  const isBreak = `previous_entry_hash IS NOT NULL AND previous_entry_hash <> ${recomputed}`;
  return `
    WITH chain AS (
      SELECT t.*, lag(t.previous_entry_hash) OVER (ORDER BY t.created_at, t.id) AS prev_stored
      FROM ${table} t
    )
    SELECT
      count(*)::int AS total_rows,
      count(*) FILTER (WHERE previous_entry_hash IS NULL)::int AS unchained_null,
      count(*) FILTER (WHERE ${isBreak})::int AS breaks,
      (array_agg(id::text ORDER BY created_at, id) FILTER (WHERE ${isBreak}))[1] AS first_break_id
    FROM chain;`;
}

async function main() {
  loadEnv();
  const table = arg('--table') ?? 'hal_production_events';
  if (!ALLOWED.has(table)) { console.error(`refusing unknown table '${table}' (allowed: ${[...ALLOWED].join(', ')})`); process.exit(2); }

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('needs SUPABASE_URL + SUPABASE_SERVICE_KEY'); process.exit(2); }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await db.rpc('exec_sql', { query: verifySql(table) });
  if (error) { console.error(`verify query failed: ${error.message} (is the chain migration applied?)`); process.exit(2); }
  const row: any = Array.isArray(data) ? data[0] : data;
  const total = Number(row?.total_rows ?? 0), nulls = Number(row?.unchained_null ?? 0), breaks = Number(row?.breaks ?? 0);
  const firstBreak = row?.first_break_id ?? null;
  const status = breaks === 0 ? 'VALID' : 'CHAIN_BREAK';

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ table, status, total_rows: total, chained: total - nulls, unchained_null: nulls, breaks, first_break_id: firstBreak }, null, 2));
  } else {
    console.log(`\n  hash-chain verify · ${table}`);
    console.log(`  ────────────────────────────────────────────`);
    console.log(`  rows: ${total}   chained: ${total - nulls}   pre-migration/null: ${nulls}`);
    if (status === 'VALID') console.log(`  RESULT: ✅ VALID${nulls ? ` (chain covers the ${total - nulls} post-migration rows; ${nulls} un-backfilled)` : ' (full chain intact)'}`);
    else console.log(`  RESULT: ❌ CHAIN_BREAK — ${breaks} row(s) fail; first break at id ${firstBreak}`);
    console.log('');
  }
  process.exit(status === 'VALID' ? 0 : 1);
}
main().catch(e => { console.error('verify-chain crashed:', e); process.exit(2); });
