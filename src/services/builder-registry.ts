/**
 * Builder registry + ghost cohort decay.
 *
 * builder.current_repid = mean(active agents' RepID) - (ghost_count * 100)
 *
 * Active = agent.last_active_at within last 7 days. Below floor 0
 * clamps to 0; above 10000 clamps to 10000.
 *
 * recomputeBuilderRepID is called on:
 *   - bet resolution (linked-bet-resolver.ts)
 *   - explicit cron / endpoint call
 */

import { db } from '../db';
import { STARTING_REPID } from '../scoring/repid-constants';
import { emitAuditEvent } from './audit-emit';
import { getCurrentStake, snapshotAuthority } from './stake-vault';
import { decideAuthorityDisplay } from '../config/display-policy';

const GHOST_PENALTY_PER_AGENT = 100;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface RegisterBuilderResult {
  ok: boolean;
  builder_id: string;
  is_new: boolean;
}

export async function registerBuilder(address: string, erc7231TokenId?: string): Promise<RegisterBuilderResult> {
  const norm = address.toLowerCase();
  const { data: existing } = await db
    .from('builders')
    .select('id')
    .ilike('address', norm)
    .maybeSingle();
  if (existing) {
    return { ok: true, builder_id: existing.id, is_new: false };
  }
  const { data, error } = await db
    .from('builders')
    .insert({
      address: norm,
      erc7231_token_id: erc7231TokenId ?? null,
      current_repid: STARTING_REPID,
      ghost_cohort_count: 0,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`builder insert failed: ${error?.message}`);
  return { ok: true, builder_id: data.id, is_new: true };
}

export async function recordAgentOwnership(builderId: string, agentId: string): Promise<void> {
  await db.from('repid_agents').update({ builder_id: builderId, last_active_at: new Date().toISOString() }).eq('id', agentId);
}

export async function markAgentInactive(agentId: string): Promise<void> {
  await db.from('repid_agents').update({
    last_active_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
  }).eq('id', agentId);
}

export interface RecomputeResult {
  builder_id: string;
  builder_repid: number;
  active_count: number;
  ghost_count: number;
  mean_active_repid: number;
}

export async function recomputeBuilderRepID(builderId: string): Promise<RecomputeResult> {
  const { data: agents } = await db
    .from('repid_agents')
    .select('id, last_active_at, current_repid')
    .eq('builder_id', builderId);
  const list = agents ?? [];

  const sevenDaysAgo = Date.now() - SEVEN_DAYS_MS;
  const active = list.filter(a => a.last_active_at && new Date(a.last_active_at).getTime() > sevenDaysAgo);
  const ghosts = list.filter(a => !a.last_active_at || new Date(a.last_active_at).getTime() <= sevenDaysAgo);

  const meanActiveRepId = active.length > 0
    ? Math.round(active.reduce((s, a) => s + Number(a.current_repid ?? 0), 0) / active.length)
    : 0;
  const ghostPenalty = ghosts.length * GHOST_PENALTY_PER_AGENT;
  const builderRepId = Math.max(0, Math.min(10000, meanActiveRepId - ghostPenalty));

  await db.from('builders').update({
    current_repid: builderRepId,
    ghost_cohort_count: ghosts.length,
    last_active_at: new Date().toISOString(),
  }).eq('id', builderId);

  await emitAuditEvent({
    event_type: 'builder_repid_recompute',
    source_table: 'builders',
    source_id: builderId,
    payload: {
      builder_id: builderId,
      builder_repid: builderRepId,
      active_count: active.length,
      ghost_count: ghosts.length,
      mean_active_repid: meanActiveRepId,
      ghost_penalty: ghostPenalty,
    },
  });

  return {
    builder_id: builderId,
    builder_repid: builderRepId,
    active_count: active.length,
    ghost_count: ghosts.length,
    mean_active_repid: meanActiveRepId,
  };
}

export interface BuilderProfile {
  id: string;
  address: string;
  display_name: string | null;
  current_repid: number;
  ghost_cohort_count: number;
  last_active_at: string | null;
  owned_agents: Array<{
    id: string;
    name: string;
    current_repid: number;
    wisdom_score: number;
    character_score: number;
    last_active_at: string | null;
    is_ghost: boolean;
  }>;
  stake_summary: {
    total_active: string;
    deposit_count: number;
    is_simulated: boolean;
  };
  /** null when the policy withholds it — never a stand-in zero. See config/display-policy. */
  current_authority: string | null;
  current_authority_withheld: boolean;
  current_authority_is_binding: boolean;
  authority_basis: unknown;
}

export async function getBuilderProfile(address: string): Promise<BuilderProfile | null> {
  const norm = address.toLowerCase();
  const { data: builder } = await db
    .from('builders')
    .select('id, address, display_name, current_repid, ghost_cohort_count, last_active_at')
    .ilike('address', norm)
    .maybeSingle();
  if (!builder) return null;

  const { data: agents } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, wisdom_score, character_score, last_active_at')
    .eq('builder_id', builder.id);

  const sevenDaysAgo = Date.now() - SEVEN_DAYS_MS;
  const ownedAgents = (agents ?? []).map(a => {
    const ts = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
    return {
      id: a.id,
      name: a.agent_name,
      current_repid: Number(a.current_repid ?? 0),
      wisdom_score: Number(a.wisdom_score ?? 1000),
      character_score: Number(a.character_score ?? 1000),
      last_active_at: a.last_active_at,
      is_ghost: ts <= sevenDaysAgo,
    };
  });

  const { data: deposits } = await db
    .from('stake_deposits')
    .select('amount, status, is_simulated')
    .eq('builder_id', builder.id);
  const totalStake = (deposits ?? []).reduce((acc, d) => acc + BigInt(d.amount), 0n);

  const stake = await getCurrentStake(builder.id);
  const auth = await snapshotAuthority(builder.id, stake);
  const authorityDisplay = decideAuthorityDisplay(auth.authority.toString(), auth.basis.floor_check);

  return {
    id: builder.id,
    address: builder.address,
    display_name: builder.display_name,
    current_repid: Number(builder.current_repid ?? 0),
    ghost_cohort_count: Number(builder.ghost_cohort_count ?? 0),
    last_active_at: builder.last_active_at,
    owned_agents: ownedAgents,
    stake_summary: {
      total_active: totalStake.toString(),
      deposit_count: (deposits ?? []).length,
      is_simulated: (deposits ?? []).every(d => d.is_simulated),
    },
    // Same policy as the /stake/authority route — applied here too rather than only there,
    // because a second surface quoting the unhonoured figure is the seam this fix exists to close.
    current_authority: authorityDisplay.authority,
    current_authority_withheld: authorityDisplay.withheld,
    current_authority_is_binding: authorityDisplay.binding,
    authority_basis: auth.basis,
  };
}

export async function getBuilderForAgent(agentId: string): Promise<{
  builderId: string;
  builderRepId: number;
  agentRepId: number;
  agentWisdom: number;
  agentCharacter: number;
  stake: bigint;
} | null> {
  const { data: agent } = await db
    .from('repid_agents')
    .select('builder_id, current_repid, wisdom_score, character_score')
    .eq('id', agentId)
    .maybeSingle();
  if (!agent || !agent.builder_id) return null;
  const { data: builder } = await db
    .from('builders')
    .select('id, current_repid')
    .eq('id', agent.builder_id)
    .single();
  const stake = await getCurrentStake(agent.builder_id);
  return {
    builderId: agent.builder_id,
    builderRepId: Number(builder?.current_repid ?? 0),
    agentRepId: Number(agent.current_repid ?? 0),
    agentWisdom: Number(agent.wisdom_score ?? 1000),
    agentCharacter: Number(agent.character_score ?? 1000),
    stake,
  };
}
