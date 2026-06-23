/**
 * Per-vertical + overall leaderboard for Trinity 12 (mocks excluded).
 * Reads v_repid_leaderboard_by_vertical when present; falls back to inline query.
 */
import { pgQuery } from '../db/direct-pg';
import { TRINITY_12_AGENT_NAMES } from '../constants/public-surfaces';

export interface LeaderboardEntry {
  vertical: string;
  agent_name: string;
  current_repid: number;
  tier: string;
  domain_pct: number | null;
  rank: number;
  credentials_in_vertical?: number;
}

export interface VerticalLeaderboardPayload {
  overall: LeaderboardEntry[];
  by_vertical: Record<string, LeaderboardEntry[]>;
  credential_verticals: { vertical: string; count: number }[];
  last_updated: string;
}

async function fetchFromView(): Promise<LeaderboardEntry[] | null> {
  try {
    return await pgQuery<LeaderboardEntry>(
      `SELECT vertical, agent_name, current_repid, tier, domain_pct, rank
       FROM v_repid_leaderboard_by_vertical
       ORDER BY vertical, rank`,
      [],
      { label: 'vertical-leaderboard-view' }
    );
  } catch {
    return null;
  }
}

async function fetchInline(): Promise<LeaderboardEntry[]> {
  const rows = await pgQuery<{
    agent_name: string;
    current_repid: number;
    tier: string;
    domain_accuracy: Record<string, { pct?: number }> | null;
  }>(
    `SELECT agent_name, current_repid, tier, domain_accuracy
     FROM repid_agents
     WHERE agent_name = ANY($1::text[])
       AND COALESCE(agent_id, '') NOT LIKE 'trinity-agent-mock-%'
     ORDER BY current_repid DESC`,
    [TRINITY_12_AGENT_NAMES],
    { label: 'vertical-leaderboard-inline' }
  );

  const out: LeaderboardEntry[] = [];
  rows.forEach((r, i) => {
    out.push({
      vertical: 'overall',
      agent_name: r.agent_name,
      current_repid: r.current_repid,
      tier: r.tier,
      domain_pct: null,
      rank: i + 1,
    });
  });

  const byVert = new Map<string, { agent_name: string; pct: number; repid: number; tier: string }[]>();
  for (const r of rows) {
    const da = r.domain_accuracy;
    if (!da || typeof da !== 'object') continue;
    for (const [vertical, stats] of Object.entries(da)) {
      const pct = Number((stats as any)?.pct);
      if (!Number.isFinite(pct)) continue;
      (byVert.get(vertical) ?? byVert.set(vertical, []).get(vertical)!).push({
        agent_name: r.agent_name,
        pct,
        repid: r.current_repid,
        tier: r.tier,
      });
    }
  }

  for (const [vertical, entries] of byVert) {
    entries.sort((a, b) => b.pct - a.pct || b.repid - a.repid);
    entries.forEach((e, i) => {
      out.push({
        vertical,
        agent_name: e.agent_name,
        current_repid: e.repid,
        tier: e.tier,
        domain_pct: e.pct,
        rank: i + 1,
      });
    });
  }

  return out;
}

export async function fetchVerticalLeaderboard(): Promise<VerticalLeaderboardPayload> {
  let rows = await fetchFromView();
  if (!rows?.length) rows = await fetchInline();

  const credRows = await pgQuery<{ vertical: string; n: number }>(
    `SELECT COALESCE(vertical, 'unknown') AS vertical, count(*)::int AS n
     FROM repid_credentials GROUP BY vertical ORDER BY n DESC`,
    [],
    { label: 'vertical-leaderboard-creds' }
  );

  const overall = rows.filter((r) => r.vertical === 'overall');
  const by_vertical: Record<string, LeaderboardEntry[]> = {};
  for (const r of rows) {
    if (r.vertical === 'overall') continue;
    (by_vertical[r.vertical] ??= []).push(r);
  }

  return {
    overall,
    by_vertical,
    credential_verticals: credRows.map((c) => ({ vertical: c.vertical, count: c.n })),
    last_updated: new Date().toISOString(),
  };
}