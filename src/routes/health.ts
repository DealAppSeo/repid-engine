import { Router, Request, Response } from 'express';
import { db } from '../db';
import { config } from '../config';
import { testHashKeyConnection } from '../engine/hashkey-chain';
import { recordDeposit, recordSponsorship } from '../services/stake-vault'; // R4 GA: economy iface from XC, for dashboard visible calls >1

const router = Router();

let cachedHealth: any = null;
let cachedHealthTime = 0;

router.get('/health', async (req: Request, res: Response) => {
  if (Date.now() - cachedHealthTime < 5000 && cachedHealth) {
    return res.json(cachedHealth);
  }

  let supabaseConnected = false;
  try {
    const { error } = await db.from('repid_agents').select('id').limit(1);
    supabaseConnected = !error;
  } catch {}

  const hashkey = await Promise.race([
    testHashKeyConnection(),
    new Promise<{ connected: boolean; error: string }>(r =>
      setTimeout(() => r({ connected: false, error: 'timeout' }), 3000)
    ),
  ]).catch(() => ({ connected: false, error: 'error' }));

  const timeoutMs = 15 * 60 * 1000;
  
  let processing_total = 0;
  let processing_hitl_pending = 0;
  let processing_stuck = 0;
  let processing_hitl_pending_over_24h = 0;
  let pending_count = 0;
  let last_processed_at: string | null = null;
  let last_created_at: string | null = null;

  try {
    const { data: queueRows } = await db
      .from('validation_queue')
      .select('metadata, created_at, status')
      .in('status', ['processing', 'pending']);
      
    if (queueRows) {
      for (const row of queueRows) {
        if (row.status === 'pending') {
          pending_count++;
          continue;
        }
        processing_total++;
        const isHitl = row.metadata?.hitl_request_id != null;
        const ageMs = Date.now() - new Date(row.created_at).getTime();
        if (isHitl) {
          processing_hitl_pending++;
          if (ageMs > 24 * 60 * 60 * 1000) processing_hitl_pending_over_24h++;
        } else {
          if (ageMs > timeoutMs) processing_stuck++;
        }
      }
    }

    const { data: lastProcessed } = await db.from('validation_queue').select('processed_at').not('processed_at', 'is', null).order('processed_at', { ascending: false }).limit(1);
    const lp = lastProcessed?.[0]; if (lp) last_processed_at = lp.processed_at;

    const { data: lastCreated } = await db.from('validation_queue').select('created_at').order('created_at', { ascending: false }).limit(1);
    const lc = lastCreated?.[0]; if (lc) last_created_at = lc.created_at;

  } catch (err) {
    console.error('Failed to fetch validation_queue metrics', err);
  }

  const responseBody = {
    status: 'ok',
    version: config.version,
    timestamp: new Date().toISOString(),
    supabaseConnected,
    hashkeyConnected: (hashkey as any).connected,
    hashkeyBlockNumber: (hashkey as any).blockNumber,
    hashkeyChainId: (hashkey as any).chainId,
    deployerConfigured: !!config.deployerPrivateKey,
    engine: 'HyperDAG RepID Scoring Engine',
    protocol: 'hyperdag.dev',
    validation_queue: {
      processing_total,
      processing_hitl_pending,
      processing_stuck,
      processing_hitl_pending_over_24h,
      last_processed_at,
      last_created_at,
      pending_count
    }
  };

  cachedHealth = responseBody;
  cachedHealthTime = Date.now();
  
  res.json(responseBody);
});

// R4 GA DEMO SURFACE: live public endpoints for dashboard (single page), verify-proof, economy.
// Fetches REAL from DB via same queries as /api/health/agents + repid + hal + proofs. NO hardcoded numbers.
// Mounted at /health so /health/status , /health/demo/agents etc (or re-export if needed).
// Trust loop: recent hal_evaluations + repid_score_events + repid_zkp_proofs.
// Staking: POST /health/staking/deposit + /sponsor using record* (calls >1 visible on /demo).
// Citations: health-extended for agents grid; repid.ts; proof-drain-service; sponsorship/stake-vault; XC R4 handoff.

router.get('/status', async (req: Request, res: Response) => {
  // /status alias for demo surface (live agents/heartbeats count, no hardcode)
  try {
    const [hb, ag] = await Promise.all([
      db.from('agent_heartbeat').select('agent_name,status,last_ping,loop_count,code_version').order('last_ping', { ascending: false }).limit(20),
      db.from('repid_agents').select('agent_name,current_repid,tier,peak_repid').order('current_repid', { ascending: false }).limit(20),
    ]);
    const recent = (hb.data || []).filter((h: any) => {
      const mins = h.last_ping ? (Date.now() - new Date(h.last_ping).getTime()) / 60000 : 99;
      return mins < 10;
    }).length;
    res.json({
      status: 'ok',
      live_agents: recent,
      total_heartbeats: (hb.data || []).length,
      total_agents: (ag.data || []).length,
      sample_agents: (ag.data || []).slice(0, 5).map((a: any) => ({ agent_name: a.agent_name, tier: a.tier, current_repid: a.current_repid })),
      timestamp: new Date().toISOString(),
      note: 'Live from agent_heartbeat + repid_agents (no hardcodes). See /health/demo/agents for full grid.'
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Demo surface data endpoints (public, for dashboard single-page + v0.app wiring). Fetch live.
router.get('/demo/agents', async (req: Request, res: Response) => {
  try {
    const [hb, agents] = await Promise.all([
      db.from('agent_heartbeat').select('agent_name,status,last_ping,loop_count,code_version,current_task_id'),
      db.from('repid_agents').select('agent_name,current_repid,tier,peak_repid,last_active_at'),
    ]);
    const repidByName = new Map((agents.data || []).map((a: any) => [a.agent_name, a]));
    const now = Date.now();
    const grid = (hb.data || []).map((h: any) => {
      const a: any = repidByName.get(h.agent_name);
      const mins = h.last_ping ? (now - new Date(h.last_ping).getTime()) / 60000 : null;
      return {
        agent_name: h.agent_name,
        status: h.status,
        live: mins != null && mins < 5,
        minutes_since_ping: mins != null ? Number(mins.toFixed(1)) : null,
        loop_count: h.loop_count,
        code_version: h.code_version,
        current_task_id: h.current_task_id,
        repid: a?.current_repid ?? null,
        tier: a?.tier ?? null,
        peak_repid: a?.peak_repid ?? null,
      };
    });
    const liveCount = grid.filter((g: any) => g.live).length;
    res.json({ count: grid.length, live: liveCount, uptime_pct: grid.length ? Math.round((liveCount / grid.length) * 100) : 0, agents: grid, source: 'live agent_heartbeat+repid_agents' });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/demo/proofs', async (req: Request, res: Response) => {
  try {
    const { data } = await db.from('repid_zkp_proofs').select('id,agent_id,proof_type,tier_proven,merkle_root,eas_attestation_uid,eas_schema,created_at').order('created_at', { ascending: false }).limit(12);
    const proofs = (data || []).map((p: any) => ({
      ...p,
      eas_attestation_uid: p.eas_attestation_uid ?? null,
      explorer: p.eas_attestation_uid ? `https://base-sepolia.easscan.org/attestation/view/${p.eas_attestation_uid}` : null,
      anchored: !!p.eas_attestation_uid,
    }));
    res.json({ count: proofs.length, eas_anchored: proofs.filter((p: any) => p.anchored).length, proofs, note: 'null-safe until eas_anchored>0 (XC); real EAS links when present. From repid_zkp_proofs.' });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get('/demo/loop', async (req: Request, res: Response) => {
  // trust-loop in motion: tasks/hals -> verify -> repid delta -> proof
  try {
    const [hals, scores, proofs] = await Promise.all([
      db.from('hal_evaluations').select('id,agent_id,hal_score,decision,hal_vetoed,repid_delta,ts').order('ts', { ascending: false }).limit(5),
      db.from('repid_score_events').select('id,agent_id,event_type,delta,repid_before,repid_after,created_at').order('created_at', { ascending: false }).limit(5),
      db.from('repid_zkp_proofs').select('id,agent_id,proof_type,eas_attestation_uid,created_at').order('created_at', { ascending: false }).limit(5),
    ]);
    res.json({
      trust_loop: {
        hal_verifies: hals.data || [],
        repid_deltas: scores.data || [],
        proofs: (proofs.data || []).map((p: any) => ({ ...p, eas_attestation_uid: p.eas_attestation_uid ?? null })),
      },
      note: 'Live trust loop from hal_evaluations + repid_score_events + repid_zkp_proofs. No hardcodes.',
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Economy staking endpoints (public for demo surface; use XC record* iface; >1 calls visible)
router.post('/demo/staking/deposit', async (req: Request, res: Response) => {
  try {
    const { agent_id, amount_usdc } = req.body || {};
    if (!agent_id || !amount_usdc) return res.status(400).json({ error: 'agent_id and amount_usdc required' });
    const result = await recordDeposit(String(agent_id), Number(amount_usdc));
    res.json({ success: result.ok, result, note: 'Used recordDeposit from stake-vault.ts (R4 GA exercise)' });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post('/demo/staking/sponsor', async (req: Request, res: Response) => {
  try {
    const { sponsor_id, target_id, amount_usdc } = req.body || {};
    if (!sponsor_id || !target_id || !amount_usdc) return res.status(400).json({ error: 'sponsor_id,target_id,amount_usdc required' });
    const result = await recordSponsorship(String(sponsor_id), String(target_id), Number(amount_usdc), 'ga4-demo');
    res.json({ success: result.ok, result, note: 'Used recordSponsorship from sponsorship.ts (R4 GA exercise >N=1)' });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
