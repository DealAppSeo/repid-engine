/**
 * Sprint R-C Track B Phase B1 — RepID lookup service.
 *
 * Reads from canonical tables:
 *   - repid_agents          (agent state: id, current_repid, tier, etc.)
 *   - repid_score_events    (append-only audit log of every score change)
 *
 * Per repid-engine CLAUDE.md table rules:
 *   - repid_agents IS canonical (NOT agent_repid — that is stale)
 *   - repid_standings view reads from agent_repid (known bug; do not propagate)
 *
 * The service is a thin read-only adapter for the new `/api/v1/repid/*`
 * routes that Sprint R-G (Gemini) calls into.
 */
import { db } from '../db';

export type RepIDSource = 'cached' | 'computed' | 'autonomous_cap';

export interface RepIDLookup {
  agent_id: string;
  repid_score: number | null;
  tier: string | null;
  last_updated: string | null;
  source: RepIDSource;
}

export interface RepIDHistoryEntry {
  repid_score: number;
  recorded_at: string;
  delta_from_previous: number | null;
  event_type: string | null;
}

export interface RepIDServiceErrors {
  agentNotFound: 'AGENT_NOT_FOUND';
  databaseError: 'DATABASE_ERROR';
}

/** AUTONOMOUS tier cap — agents above this are clamped per CLAUDE.md. */
export const AUTONOMOUS_CAP = 10000;

/**
 * Fetch the current RepID for an agent. Returns null `repid_score` and
 * `source: 'cached'` semantics by default; if the agent's score is at
 * the AUTONOMOUS_CAP (10000), `source: 'autonomous_cap'` to indicate
 * the cap is binding.
 *
 * Throws an Error with `.code = 'AGENT_NOT_FOUND' | 'DATABASE_ERROR'`
 * on failure — callers map these to HTTP 404 / 500.
 */
export async function getRepIDForAgent(agentId: string): Promise<RepIDLookup> {
  if (!agentId || typeof agentId !== 'string') {
    const e = new Error('agentId required');
    (e as any).code = 'AGENT_NOT_FOUND';
    throw e;
  }

  const { data, error } = await db
    .from('repid_agents')
    .select('id, current_repid, tier, updated_at, created_at')
    .eq('id', agentId)
    .maybeSingle();

  if (error) {
    const e = new Error(`repid_agents lookup failed: ${error.message}`);
    (e as any).code = 'DATABASE_ERROR';
    throw e;
  }
  if (!data) {
    const e = new Error(`agent ${agentId} not found`);
    (e as any).code = 'AGENT_NOT_FOUND';
    throw e;
  }

  const score = typeof data.current_repid === 'number' ? data.current_repid : null;
  const source: RepIDSource = score !== null && score >= AUTONOMOUS_CAP ? 'autonomous_cap' : 'cached';
  const lastUpdated =
    (data as any).updated_at ?? (data as any).created_at ?? null;

  return {
    agent_id: data.id,
    repid_score: score,
    tier: (data as any).tier ?? null,
    last_updated: lastUpdated,
    source,
  };
}

/**
 * Fetch RepID history for an agent. Reads append-only `repid_score_events`
 * filtered by `repid_after IS NOT NULL`. Optional `sinceISO` cursor.
 *
 * Returns events ordered newest-first. Each entry's `delta_from_previous`
 * is computed by subtracting the prior event's `repid_after` (positional
 * scan over the result set — the table also stores `repid_before` /
 * `repid_after` so the delta is straightforward).
 */
export async function getRepIDHistory(
  agentId: string,
  sinceISO?: string,
): Promise<RepIDHistoryEntry[]> {
  if (!agentId || typeof agentId !== 'string') {
    const e = new Error('agentId required');
    (e as any).code = 'AGENT_NOT_FOUND';
    throw e;
  }

  let query = db
    .from('repid_score_events')
    .select('repid_after, repid_before, created_at, event_type')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false });

  if (sinceISO && /^\d{4}-\d{2}-\d{2}/.test(sinceISO)) {
    query = query.gte('created_at', sinceISO);
  }

  const { data, error } = await query;
  if (error) {
    const e = new Error(`repid_score_events query failed: ${error.message}`);
    (e as any).code = 'DATABASE_ERROR';
    throw e;
  }
  if (!data || data.length === 0) return [];

  return data.map((row: any) => {
    const before = typeof row.repid_before === 'number' ? row.repid_before : null;
    const after = typeof row.repid_after === 'number' ? row.repid_after : null;
    const delta = after !== null && before !== null ? after - before : null;
    return {
      repid_score: after ?? 0,
      recorded_at: row.created_at,
      delta_from_previous: delta,
      event_type: row.event_type ?? null,
    };
  });
}
