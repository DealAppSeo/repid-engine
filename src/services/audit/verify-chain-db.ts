/**
 * Programmatic hash-chain verification (the verify-chain.ts logic as a function).
 *
 * Runs the SAME server-side recompute the CLI uses — `sha256(coalesce(prior,'GENESIS') || content)`,
 * content = `(to_jsonb(row) - 'previous_entry_hash')::text` — via the direct-pg pooler (which
 * bypasses RLS, unlike the exec_sql RPC). Returns null when the DB is unreachable / DATABASE_URL
 * is unset so callers can degrade gracefully instead of throwing.
 */
import { pgQuery } from '../../db/direct-pg';

// Only the chain-carrying audit tables — also guards the table-name interpolation.
const ALLOWED = new Set(['hal_production_events', 'tool_call_log', 'hal_classifications', 'hal_audit_chain']);

export interface ChainVerifyResult {
  table: string;
  status: 'VALID' | 'CHAIN_BREAK';
  total_rows: number;
  chained: number;
  unchained_null: number;
  breaks: number;
  first_break_id: string | null;
}

export async function verifyChainBreaks(table: string): Promise<ChainVerifyResult | null> {
  if (!ALLOWED.has(table)) return null;
  // Fast-fail when no pooler is configured — otherwise direct-pg retries with backoff
  // (seconds) before giving up, which would block the public endpoints that call this.
  if (!process.env.DATABASE_URL && !process.env.SUPABASE_DB_URL) return null;
  const recomputed =
    `encode(digest(coalesce(prev_stored,'GENESIS') || ((to_jsonb(chain) - 'previous_entry_hash' - 'prev_stored')::text), 'sha256'),'hex')`;
  const isBreak = `previous_entry_hash IS NOT NULL AND previous_entry_hash <> ${recomputed}`;
  const sql = `
    WITH chain AS (
      SELECT t.*, lag(t.previous_entry_hash) OVER (ORDER BY t.created_at, t.id) AS prev_stored
      FROM ${table} t
    )
    SELECT count(*)::int AS total_rows,
           count(*) FILTER (WHERE previous_entry_hash IS NULL)::int AS unchained_null,
           count(*) FILTER (WHERE ${isBreak})::int AS breaks,
           (array_agg(id::text ORDER BY created_at, id) FILTER (WHERE ${isBreak}))[1] AS first_break_id
    FROM chain;`;
  try {
    const rows = await pgQuery<any>(sql, [], { timeoutMs: 8000, retries: 1, label: `verify-chain ${table}` });
    const r = rows[0];
    if (!r) return null;
    const total = Number(r.total_rows ?? 0);
    const nulls = Number(r.unchained_null ?? 0);
    const breaks = Number(r.breaks ?? 0);
    return {
      table,
      status: breaks === 0 ? 'VALID' : 'CHAIN_BREAK',
      total_rows: total,
      chained: total - nulls,
      unchained_null: nulls,
      breaks,
      first_break_id: r.first_break_id ?? null,
    };
  } catch {
    return null; // DB unreachable / DATABASE_URL unset — caller degrades.
  }
}
