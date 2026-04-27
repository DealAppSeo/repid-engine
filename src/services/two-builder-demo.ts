/**
 * Two-builder demo — orchestrates Builder W (wealthy operator with 5
 * sybil agents) and Builder M (mission-aligned, owns APM).
 *
 * Snapshot endpoint exposes a side-by-side view; timeseries returns
 * authority-over-time for charting. The demo doesn't need its own
 * trading-round logic — Builder W runs simulated rounds via the same
 * placeBet path; Builder M's APM uses the regular two-agent trader.
 */

import { db } from '../db';
import { snapshotAuthority, getCurrentStake, computeAuthority, BUILDER_FLOOR } from './stake-vault';
import { recomputeBuilderRepID } from './builder-registry';

const BUILDER_W_ID = '00000000-0000-0000-0000-000000000001';
const BUILDER_M_ID = '00000000-0000-0000-0000-000000000002';

interface BuilderSnapshot {
  id: string;
  display_name: string;
  current_repid: number;
  ghost_cohort_count: number;
  stake_total: string;
  authority: string;
  agents: Array<{
    id: string;
    name: string;
    current_repid: number;
    wisdom_score: number;
    character_score: number;
    is_ghost: boolean;
  }>;
  basis: unknown;
}

async function snapshotBuilder(builderId: string): Promise<BuilderSnapshot | null> {
  const { data: b } = await db.from('builders').select('*').eq('id', builderId).maybeSingle();
  if (!b) return null;

  // Recompute builder repid (active mean - ghost penalty).
  await recomputeBuilderRepID(builderId);
  const { data: b2 } = await db.from('builders').select('*').eq('id', builderId).maybeSingle();

  const stake = await getCurrentStake(builderId);
  const auth = await snapshotAuthority(builderId, stake);

  const { data: agents } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, wisdom_score, character_score, last_active_at')
    .eq('builder_id', builderId);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  return {
    id: builderId,
    display_name: b2?.display_name ?? '',
    current_repid: Number(b2?.current_repid ?? 0),
    ghost_cohort_count: Number(b2?.ghost_cohort_count ?? 0),
    stake_total: stake.toString(),
    authority: auth.authority.toString(),
    agents: (agents ?? []).map(a => {
      const ts = a.last_active_at ? new Date(a.last_active_at).getTime() : 0;
      return {
        id: a.id,
        name: a.agent_name,
        current_repid: Number(a.current_repid ?? 0),
        wisdom_score: Number(a.wisdom_score ?? 1000),
        character_score: Number(a.character_score ?? 1000),
        is_ghost: ts <= sevenDaysAgo,
      };
    }),
    basis: auth.basis,
  };
}

export interface TwoBuilderSnapshot {
  builder_w: BuilderSnapshot | null;
  builder_m: BuilderSnapshot | null;
  crossover: {
    builder_m_authority_exceeds_w: boolean;
    delta: string;
  };
  formula: string;
  is_simulated: boolean;
}

export async function getTwoBuilderSnapshot(): Promise<TwoBuilderSnapshot> {
  const [w, m] = await Promise.all([
    snapshotBuilder(BUILDER_W_ID),
    snapshotBuilder(BUILDER_M_ID),
  ]);
  const wA = BigInt(w?.authority ?? '0');
  const mA = BigInt(m?.authority ?? '0');
  return {
    builder_w: w,
    builder_m: m,
    crossover: {
      builder_m_authority_exceeds_w: mA > wA,
      delta: (mA - wA).toString(),
    },
    formula: 'authority = sqrt(stake) * (R * W * C / 1_000_000) / 10_000; floor: builder_repid >= ' + BUILDER_FLOOR,
    is_simulated: true,
  };
}

export interface TimeseriesPoint {
  computed_at: string;
  builder_w_authority: string;
  builder_m_authority: string;
  builder_w_repid: number;
  builder_m_repid: number;
}

export async function getTimeseries(limit: number = 100): Promise<TimeseriesPoint[]> {
  const { data: snaps } = await db
    .from('stake_authority_snapshots')
    .select('builder_id, computed_authority, basis, computed_at')
    .in('builder_id', [BUILDER_W_ID, BUILDER_M_ID])
    .order('computed_at', { ascending: false })
    .limit(limit * 2);

  // Group by computed_at minute (so W and M snapshots taken close in time
  // get aligned). Simplest approach: latest N for each, zip.
  const list = snaps ?? [];
  const wAll = list.filter(s => s.builder_id === BUILDER_W_ID).sort((a, b) => a.computed_at < b.computed_at ? -1 : 1);
  const mAll = list.filter(s => s.builder_id === BUILDER_M_ID).sort((a, b) => a.computed_at < b.computed_at ? -1 : 1);
  const n = Math.min(wAll.length, mAll.length);
  const out: TimeseriesPoint[] = [];
  for (let i = 0; i < n; i++) {
    const w = wAll[i]!;
    const m = mAll[i]!;
    out.push({
      computed_at: w.computed_at,
      builder_w_authority: String(w.computed_authority),
      builder_m_authority: String(m.computed_authority),
      builder_w_repid: Number((w.basis as any)?.builder_repid ?? 0),
      builder_m_repid: Number((m.basis as any)?.builder_repid ?? 0),
    });
  }
  return out.slice(-limit);
}

// Convenience seed-snapshot trigger (used by demo to bootstrap a chart point
// even before any rounds have run).
export async function bootstrapDemoSnapshots(): Promise<{ w: string; m: string }> {
  const wStake = await getCurrentStake(BUILDER_W_ID);
  const mStake = await getCurrentStake(BUILDER_M_ID);
  const wAuth = await snapshotAuthority(BUILDER_W_ID, wStake);
  const mAuth = await snapshotAuthority(BUILDER_M_ID, mStake);
  return { w: wAuth.authority.toString(), m: mAuth.authority.toString() };
}

export const _internals = {
  BUILDER_W_ID,
  BUILDER_M_ID,
  computeAuthority,
};
