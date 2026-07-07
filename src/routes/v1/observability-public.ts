/**
 * Live-numbers public observability surface (2026-07-07) — the real numbers
 * that TrustShell.dev's leaderboard + "What we've built" stats block read.
 *
 * TWO endpoints, both PUBLIC read-only (mounted BEFORE authMiddleware in
 * src/index.ts — same posture as the other public GET /api/v1/repid/* reads;
 * a bypass for GET /api/v1/agents/minted + GET /api/v1/observability/onchain-stats
 * is added in middleware/auth.ts):
 *
 *   GET /api/v1/agents/minted
 *     → { agents: [{ name, display_name, agent_id, erc8004_token_id,
 *         current_repid, tier }], count }
 *     ALL repid_agents WHERE erc8004_token_id IS NOT NULL. This replaces the
 *     landing's HARD-CODED 4-agent list — new mints appear automatically. The
 *     adversarial mock agents (agent_id 'trinity-agent-mock-%') are excluded by
 *     default via the canonical public-surface filter (isMockAgentId) so the
 *     public leaderboard shows only real minted agents; ?include_mock=true opts
 *     them back in for ops debugging.
 *
 *   GET /api/v1/observability/onchain-stats
 *     → { agents_minted, lifetime_onchain_writes, as_of }
 *     agents_minted = count of repid_agents with erc8004_token_id (mock-excluded
 *     by default, same rule); lifetime_onchain_writes = real row count of
 *     erc8004_reputation_writes. NO hard-coded constants — these were frozen at
 *     agents_minted=4 / lifetime_onchain_writes=32 since 2026-05-24; now live.
 *
 * SCHEMA-FIRST (verified via Supabase MCP 2026-07-07, project qnnpjhlxljtqyigedwkb):
 *   repid_agents:  id(uuid), agent_id(text), agent_name(text), display_name(text),
 *                  erc8004_token_id(text), current_repid(int), tier(text),
 *                  lifecycle_status(text)
 *   erc8004_reputation_writes: id(bigint), tx_hash(text), created_at(timestamptz)
 *
 * Read-only: NO writes, NO money, NO secrets. Fail-loud on DB error (500), never
 * a silent empty list reported as truth (RULE-4).
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { isMockAgentId } from '../../constants/public-surfaces';

const router = Router();

/** Whether ?include_mock=true was passed (opt the adversarial mock agents back in). */
function includeMock(req: Request): boolean {
  return String(req.query.include_mock ?? '').toLowerCase() === 'true';
}

// GET /api/v1/agents/minted — the dynamic minted-agent list the leaderboard iterates.
router.get('/agents/minted', async (req: Request, res: Response) => {
  try {
    const { data, error } = await db
      .from('repid_agents')
      .select('agent_name, display_name, agent_id, erc8004_token_id, current_repid, tier, lifecycle_status')
      .not('erc8004_token_id', 'is', null)
      .order('current_repid', { ascending: false });

    if (error) {
      console.error('[observability-public] agents/minted query failed:', error.message ?? error);
      return res.status(500).json({ error: 'query_failed', message: error.message ?? 'query failed' });
    }

    const withMock = includeMock(req);
    const agents = (data ?? [])
      .filter((a: any) => withMock || !isMockAgentId(a.agent_id))
      .map((a: any) => ({
        name: a.agent_name ?? null,
        display_name: a.display_name ?? a.agent_name ?? null,
        agent_id: a.agent_id ?? null,
        erc8004_token_id: a.erc8004_token_id ?? null,
        current_repid: a.current_repid ?? null,
        tier: a.tier ?? null,
      }));

    return res.json({ agents, count: agents.length });
  } catch (e: any) {
    console.error('[observability-public] agents/minted unexpected error:', e?.message ?? String(e));
    return res.status(500).json({ error: 'internal_error', message: e?.message ?? String(e) });
  }
});

// GET /api/v1/observability/onchain-stats — real counts for the "What we've built" block.
router.get('/observability/onchain-stats', async (req: Request, res: Response) => {
  try {
    const withMock = includeMock(req);

    // agents_minted: count repid_agents with a token id. Mock agents are excluded
    // by default in-process (the canonical filter is a name prefix, so a HEAD count
    // can't apply it directly without SQL — we count the filtered id list instead).
    const { data: mintedRows, error: mintedErr } = await db
      .from('repid_agents')
      .select('agent_id')
      .not('erc8004_token_id', 'is', null);

    if (mintedErr) {
      console.error('[observability-public] onchain-stats minted query failed:', mintedErr.message ?? mintedErr);
      return res.status(500).json({ error: 'query_failed', message: mintedErr.message ?? 'query failed' });
    }

    const agentsMinted = (mintedRows ?? [])
      .filter((a: any) => withMock || !isMockAgentId(a.agent_id))
      .length;

    // lifetime_onchain_writes: real row count of erc8004_reputation_writes.
    const { count: writesCount, error: writesErr } = await db
      .from('erc8004_reputation_writes')
      .select('*', { count: 'exact', head: true });

    if (writesErr) {
      console.error('[observability-public] onchain-stats writes query failed:', writesErr.message ?? writesErr);
      return res.status(500).json({ error: 'query_failed', message: writesErr.message ?? 'query failed' });
    }

    return res.json({
      agents_minted: agentsMinted,
      lifetime_onchain_writes: writesCount ?? 0,
      as_of: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('[observability-public] onchain-stats unexpected error:', e?.message ?? String(e));
    return res.status(500).json({ error: 'internal_error', message: e?.message ?? String(e) });
  }
});

export default router;
