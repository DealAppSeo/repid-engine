/**
 * launch-status.ts — public system status + hero receipt (CC1, 2026-05-25).
 *
 * Mounted BEFORE authMiddleware (alongside the other public routers in index.ts)
 * so outside developers can see the system is alive without an API key. Adds the
 * two surfaces Phase 6 needs that didn't exist:
 *   GET /api/v1/status         → consolidated health + 24h economic metrics +
 *                                last heartbeat + last audit-probe result.
 *   GET /api/v1/receipts/hero  → the verified first-live-settlement on-chain proof.
 *
 * Does NOT collide with the existing /api/v1/status/* sub-routes (observabilityRouter,
 * authed after this) or the authed /api/v1/receipts/:id router (different exact paths).
 * Read-only; leaks no config/secrets/PII.
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';

const router = Router();

// Verified first-live-settlement receipt (immutable on-chain facts, CC1 05-24 smoke).
// Sourced from the verified Base Sepolia transactions; the x402_settlements.tx_hash
// column is pending a Sean backfill (see DECISIONS), so the canonical values live here.
export const HERO_RECEIPT = {
  label: 'First live USDC settlement → on-chain reputation attestation (full economic loop)',
  network: 'base-sepolia',
  chain_id: 84532,
  contract_id: '006e2416-d3de-431e-a83f-b6c488fc81bc',
  value_usdc: '0.10',
  operator_wallet: '0xf6eE1768868c3266868edcA78bC41C50309cb22A',
  provider: 'trinity-shofet',
  provider_wallet: '0x15eB9A7427f1B54486926465d5895cD51eB8b052',
  repid_change: { before: 2980, after: 3040 },
  usdc_settlement: {
    tx: '0x2a7ac151c23983f59564fc3da5c7ea74fdbe390f9e97fcbf70c79be27089967a',
    block: 41917330,
    basescan: 'https://sepolia.basescan.org/tx/0x2a7ac151c23983f59564fc3da5c7ea74fdbe390f9e97fcbf70c79be27089967a',
  },
  reputation_attestation: {
    tx: '0xd362c1b0c819e2e1ee7bce601531afb0be1eef20c1be4ab8dc643e524d19e917',
    block: 41917386,
    registry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    basescan: 'https://sepolia.basescan.org/tx/0xd362c1b0c819e2e1ee7bce601531afb0be1eef20c1be4ab8dc643e524d19e917',
  },
  settled_at: '2026-05-24T06:09:07Z',
} as const;

const since24h = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();
async function safeCount(table: string, build: (q: any) => any): Promise<number | null> {
  try {
    const { count, error } = await build(db.from(table).select('*', { count: 'exact', head: true }));
    return error ? null : (count ?? 0);
  } catch { return null; }
}
async function latestTelemetry(family: string): Promise<any | null> {
  try {
    const { data, error } = await db.from('repid_telemetry_snapshots')
      .select('metric_name,metric_value,snapshot_at').eq('metric_family', family)
      .order('snapshot_at', { ascending: false }).limit(1);
    const row = data?.[0];
    if (error || !row) return null;
    return { at: row.snapshot_at, name: row.metric_name, value: row.metric_value };
  } catch { return null; }
}

// PR-2 (CC1, 2026-05-26): summarize last-24h Firecrawl rollout activity from
// trinity_tool_usage. Pure read; honest about empty state — returns
// `{ enabled, calls, cost_usd_24h, by_agent: [], note }` so visitors see
// truthful "rollout active, 0 calls so far" rather than masking the empty state.
async function firecrawl24h(): Promise<{ enabled: boolean; calls: number; cost_usd_24h: number; by_agent: Array<{ agent_id: string; calls: number; cost_usd: number }>; note?: string }> {
  const since = since24h();
  try {
    const { data, error } = await db.from('trinity_tool_usage')
      .select('agent_id,outcome')
      .ilike('tool_name', '%firecrawl%')
      .gte('created_at', since);
    if (error) {
      return { enabled: false, calls: 0, cost_usd_24h: 0, by_agent: [], note: 'trinity_tool_usage read failed' };
    }
    const rows = data ?? [];
    let cost = 0;
    const byAgent = new Map<string, { calls: number; cost_usd: number }>();
    for (const r of rows) {
      const c = Number((r.outcome as any)?.cost_usd ?? 0);
      cost += c;
      const a = (r.agent_id as string) ?? 'unknown';
      const cur = byAgent.get(a) ?? { calls: 0, cost_usd: 0 };
      cur.calls++; cur.cost_usd = +(cur.cost_usd + c).toFixed(6);
      byAgent.set(a, cur);
    }
    return {
      enabled: true,
      calls: rows.length,
      cost_usd_24h: +cost.toFixed(6),
      by_agent: Array.from(byAgent.entries()).map(([agent_id, v]) => ({ agent_id, ...v })),
      ...(rows.length === 0 ? { note: 'rollout active, 0 calls in last 24h (research agents only: trinity-nexus, trinity-torch)' } : {}),
    };
  } catch {
    return { enabled: false, calls: 0, cost_usd_24h: 0, by_agent: [], note: 'firecrawl summary failed' };
  }
}

router.get('/status', async (_req: Request, res: Response) => {
  const since = since24h();
  let supabaseOk = true;
  const [attestations, realSettlements, scoreEvents] = await Promise.all([
    safeCount('erc8004_reputation_writes', q => q.gte('created_at', since)),
    safeCount('x402_settlements', q => q.gte('created_at', since).eq('is_simulated', false)),
    safeCount('repid_score_events', q => q.gte('created_at', since)),
  ]);
  if (attestations === null && realSettlements === null && scoreEvents === null) supabaseOk = false;
  const [heartbeat, audit, firecrawl] = await Promise.all([
    latestTelemetry('heartbeat'),
    latestTelemetry('audit_probe'),
    firecrawl24h(),
  ]);

  res.json({
    service: 'repid-engine',
    version: '1.0.0',
    network: 'base-sepolia',
    timestamp: new Date().toISOString(),
    operational: { supabase: supabaseOk },
    metrics_24h: {
      onchain_attestations: attestations,
      real_settlements: realSettlements,
      score_events: scoreEvents,
      firecrawl, // PR-2: rollout visibility — see firecrawl24h() above
    },
    last_heartbeat: heartbeat ? { at: heartbeat.at, result: heartbeat.value } : null,
    audit_status: audit ? { at: audit.at, overall: audit.value?.overall ?? null } : null,
    hero_receipt: `/api/v1/receipts/hero`,
  });
});

router.get('/receipts/hero', (_req: Request, res: Response) => {
  res.json(HERO_RECEIPT);
});

// PR-2 (CC1, 2026-05-26): dedicated public Firecrawl-stats endpoint for
// trustshell.dev (and curious devs) to inspect the rollout in detail. Same
// read-only data, no auth, no PII.
router.get('/firecrawl/stats', async (_req: Request, res: Response) => {
  res.json(await firecrawl24h());
});

export default router;
