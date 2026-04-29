/**
 * Builder dashboard aggregator.
 *
 * Pulls builder profile + agents + stake/authority + recent audit +
 * trading status + cap progression in one shot. Used by the
 * /api/v1/builder/dashboard/:builder_id endpoint and the dashboard page.
 *
 * Scopes audit feed by either source_id=builder_id or by
 * payload.builder_id matches — covers builder rows + linked-bet rows
 * that store builder_id in payload.
 */

import { db } from '../db';
import { getCurrentStake, snapshotAuthority } from './stake-vault';
import { tradeCountByAgent } from '../db/query-helpers';
import { timed } from '../utils/perf-timing';

export interface DashboardSnapshot {
  builder: {
    id: string;
    email: string | null;
    address: string;
    current_repid: number;
    erc7231_token_id: string | null;
    auth_method: string;
    earns_repid_rewards: boolean;
    agent_count: number;
  };
  agents: Array<{
    id: string;
    name: string;
    current_repid: number;
    wisdom_score: number;
    character_score: number;
    last_active_at: string | null;
    recent_trades_count: number;
  }>;
  stake: {
    total: string;
    is_simulated: boolean;
  };
  authority: {
    current: string;
    basis: unknown;
  };
  trading: {
    provider: string | null;
    account_id: string | null;
    linked: boolean;
  };
  cap_progression: Record<string, number>;
  recent_audit: Array<{
    id: number;
    source_table: string;
    source_id: string;
    payload: any;
    created_at: string;
  }>;
  recent_trades: Array<{
    bet_id: string;
    symbol: string;
    side: string;
    qty: number;
    status: string;
    pnl: number | null;
    created_at: string;
  }>;
}

export async function getBuilderDashboard(builderId: string): Promise<DashboardSnapshot | null> {
  return timed({ service: 'builder-dashboard', op: 'getBuilderDashboard', builderId }, async () => {
  const { data: builder } = await db
    .from('builders')
    .select('id, email, address, current_repid, erc7231_token_id, auth_method, earns_repid_rewards, agent_count, trading_provider, trading_paper_account_id, notification_prefs')
    .eq('id', builderId)
    .maybeSingle();
  if (!builder) return null;

  const { data: agents } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, wisdom_score, character_score, last_active_at')
    .eq('builder_id', builderId);

  const stake = await getCurrentStake(builderId);
  const auth = await snapshotAuthority(builderId, stake);

  const { data: deposits } = await db
    .from('stake_deposits')
    .select('is_simulated')
    .eq('builder_id', builderId)
    .limit(20);
  const stakeSim = !deposits || deposits.length === 0 || deposits.every(d => d.is_simulated);

  // Recent trades for this builder
  const { data: trades } = await db
    .from('paper_trade_orders')
    .select('bet_id, symbol, side, qty, status, pnl, created_at')
    .eq('builder_id', builderId)
    .order('created_at', { ascending: false })
    .limit(20);

  // Replaces a per-agent count loop (N+1) with one batched query.
  const agentIds = (agents ?? []).map(a => a.id);
  const tradeCounts = await tradeCountByAgent(db, agentIds);

  // Audit: combine builder-keyed rows with payload->builder_id matches.
  // Two-step: query by source_id (builder.id is a UUID string) + agent ids.
  const sourceIds: string[] = [builderId, ...(agents ?? []).map(a => a.id)];
  const { data: audit } = await db
    .from('hal_audit_chain')
    .select('id, source_table, source_id, event_payload, created_at')
    .in('source_id', sourceIds)
    .order('id', { ascending: false })
    .limit(20);

  const caps = (builder.notification_prefs as any)?.agent_trade_caps ?? {};

  return {
    builder: {
      id: builder.id,
      email: builder.email ?? null,
      address: builder.address,
      current_repid: Number(builder.current_repid ?? 0),
      erc7231_token_id: builder.erc7231_token_id ?? null,
      auth_method: builder.auth_method ?? 'wallet',
      earns_repid_rewards: !!builder.earns_repid_rewards,
      agent_count: Number(builder.agent_count ?? 0),
    },
    agents: (agents ?? []).map(a => ({
      id: a.id,
      name: a.agent_name,
      current_repid: Number(a.current_repid ?? 0),
      wisdom_score: Number(a.wisdom_score ?? 1000),
      character_score: Number(a.character_score ?? 1000),
      last_active_at: a.last_active_at,
      recent_trades_count: tradeCounts.get(a.id) ?? 0,
    })),
    stake: {
      total: stake.toString(),
      is_simulated: stakeSim,
    },
    authority: {
      current: auth.authority.toString(),
      basis: auth.basis,
    },
    trading: {
      provider: builder.trading_provider ?? null,
      account_id: builder.trading_paper_account_id ?? null,
      linked: !!builder.trading_provider,
    },
    cap_progression: caps,
    recent_audit: (audit ?? []).map(r => ({
      id: r.id,
      source_table: r.source_table,
      source_id: r.source_id,
      payload: r.event_payload,
      created_at: r.created_at,
    })),
    recent_trades: (trades ?? []).map(t => ({
      bet_id: t.bet_id,
      symbol: t.symbol,
      side: t.side,
      qty: Number(t.qty ?? 0),
      status: t.status,
      pnl: t.pnl !== null ? Number(t.pnl) : null,
      created_at: t.created_at,
    })),
  };
  });
}
