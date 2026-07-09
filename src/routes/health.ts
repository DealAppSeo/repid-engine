import { Router, Request, Response } from 'express';
import { db } from '../db';
import { config } from '../config';
import { testHashKeyConnection } from '../engine/hashkey-chain';

const router = Router();

// Deployed commit SHA — Railway injects RAILWAY_GIT_COMMIT_SHA at build time for
// GitHub-linked services. Surfacing it here defeats the "green ≠ deployed" hazard:
// Railway keeps the last SUCCESSFUL build serving when a new deploy fails, so the
// health dot can read OK on stale code. Assert this against origin/main HEAD to
// detect deploy drift (see scripts/verify/assert-deployed-sha.ts). Resolved once
// per process (constant for the life of a deploy).
const DEPLOYED_COMMIT: string =
  process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'unknown';
const DEPLOYED_COMMIT_SHORT: string =
  DEPLOYED_COMMIT === 'unknown' ? 'unknown' : DEPLOYED_COMMIT.slice(0, 7);

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
    deployed_commit: DEPLOYED_COMMIT,
    deployed_commit_short: DEPLOYED_COMMIT_SHORT,
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

export default router;
