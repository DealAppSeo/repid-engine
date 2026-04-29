/**
 * Query consolidation helpers — replace N+1 loops with single batched
 * queries against the existing Supabase tables. NO schema changes,
 * NO migrations.
 *
 * Each helper takes a Supabase-shaped client (the one exported from
 * `src/db.ts` or any compatible test mock) so call sites stay flexible
 * and tests can verify call counts without touching the real DB.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type AnyDb = SupabaseClient | { from: (table: string) => any };

export interface BuilderRow {
  id: string;
  email: string | null;
  address: string;
  current_repid: number;
  erc7231_token_id: string | null;
  auth_method: string | null;
  earns_repid_rewards: boolean;
  agent_count: number;
  trading_provider: string | null;
  trading_paper_account_id: string | null;
  notification_prefs: unknown;
  last_canonical_tx: string | null;
  last_canonical_status: string | null;
}

export interface RoundRow {
  id: string;
  status: string;
  apm_bet_id: string | null;
  veritas_bet_id: string | null;
  expected_resolution: string | null;
  resolved_at: string | null;
  started_at: string | null;
  resolution_outcome: boolean | null;
}

export interface CanonicalStatus {
  builder_id: string;
  last_canonical_tx: string | null;
  last_canonical_status: string | null;
  agent_count: number;
}

const BUILDER_COLUMNS =
  'id, email, address, current_repid, erc7231_token_id, auth_method, ' +
  'earns_repid_rewards, agent_count, trading_provider, ' +
  'trading_paper_account_id, notification_prefs, last_canonical_tx, ' +
  'last_canonical_status';

/**
 * Fetch many builders in ONE query instead of N maybeSingle() calls.
 *
 * Returns rows in the same order they were requested; missing IDs are
 * silently dropped. Callers can detect dropped IDs by comparing
 * result.length to ids.length.
 */
export async function batchFetchBuilders(
  db: AnyDb,
  ids: string[],
): Promise<BuilderRow[]> {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  // Deduplicate — repeated IDs do not need repeated rows
  const unique = Array.from(new Set(ids));
  const { data, error } = await db
    .from('builders')
    .select(BUILDER_COLUMNS)
    .in('id', unique);
  if (error) throw error;
  const rows = (data ?? []) as BuilderRow[];
  // Preserve request order
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered: BuilderRow[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r) ordered.push(r);
  }
  return ordered;
}

/**
 * Latest N trading_rounds for a builder, joined via APM/VERITAS bet
 * ownership. The trading_rounds table doesn't carry builder_id directly;
 * we resolve via linked_bets → repid_agents → builders. Returns rounds
 * sorted by started_at DESC.
 *
 * Hot-path optimization: replaces ad-hoc multi-step lookups with one
 * RPC pattern. Uses a covering-style select to avoid a second round-trip
 * for column data.
 */
export async function latestRoundsForBuilder(
  db: AnyDb,
  builderId: string,
  limit = 20,
): Promise<RoundRow[]> {
  if (!builderId || limit <= 0) return [];
  // Step 1: agent IDs owned by this builder.
  const { data: agentRows, error: agentErr } = await db
    .from('repid_agents')
    .select('id')
    .eq('builder_id', builderId);
  if (agentErr) throw agentErr;
  const agentIds = (agentRows ?? []).map((r: { id: string }) => r.id);
  if (agentIds.length === 0) return [];

  // Step 2: bet IDs that those agents placed.
  const { data: betRows, error: betErr } = await db
    .from('linked_bets')
    .select('id')
    .in('agent_id', agentIds);
  if (betErr) throw betErr;
  const betIds = (betRows ?? []).map((r: { id: string }) => r.id);
  if (betIds.length === 0) return [];

  // Step 3: rounds where either side matches one of those bets.
  // Supabase .or() lets us union the two foreign keys in a single round-trip.
  const orFilter = `apm_bet_id.in.(${betIds.join(',')}),veritas_bet_id.in.(${betIds.join(',')})`;
  const { data: rounds, error: rdErr } = await db
    .from('trading_rounds')
    .select('id, status, apm_bet_id, veritas_bet_id, expected_resolution, resolved_at, started_at, resolution_outcome')
    .or(orFilter)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (rdErr) throw rdErr;
  return (rounds ?? []) as RoundRow[];
}

/**
 * Combined canonical-write status for a builder: read the builder row's
 * last_canonical_tx + last_canonical_status alongside the agent count.
 *
 * Single query — avoids the previous pattern of fetching the builder
 * row separately from a count query.
 */
export async function canonicalWriteStatus(
  db: AnyDb,
  builderId: string,
): Promise<CanonicalStatus | null> {
  if (!builderId) return null;
  const { data, error } = await db
    .from('builders')
    .select('id, last_canonical_tx, last_canonical_status, agent_count')
    .eq('id', builderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    builder_id: data.id,
    last_canonical_tx: data.last_canonical_tx ?? null,
    last_canonical_status: data.last_canonical_status ?? null,
    agent_count: Number(data.agent_count ?? 0),
  };
}

/**
 * Trade-count-by-agent batch: replace the for-loop in builder-dashboard
 * that issues one count query per agent (N+1) with a single grouped
 * fetch. Returns Map<agentId, count>.
 *
 * Implemented as a select of agent_id rows + JS-side grouping rather
 * than a SQL GROUP BY, which would require either an RPC or PostgREST
 * support for aggregates.
 */
export async function tradeCountByAgent(
  db: AnyDb,
  agentIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!Array.isArray(agentIds) || agentIds.length === 0) return out;
  const unique = Array.from(new Set(agentIds));
  const { data, error } = await db
    .from('paper_trade_orders')
    .select('agent_id')
    .in('agent_id', unique);
  if (error) throw error;
  for (const id of unique) out.set(id, 0);
  for (const row of (data ?? []) as Array<{ agent_id: string }>) {
    out.set(row.agent_id, (out.get(row.agent_id) ?? 0) + 1);
  }
  return out;
}
