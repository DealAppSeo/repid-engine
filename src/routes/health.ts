import { Router, Request, Response } from 'express';
import { db } from '../db';
import { config } from '../config';
import { testHashKeyConnection } from '../engine/hashkey-chain';

const router = Router();

router.get('/health', async (req: Request, res: Response) => {
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
  const cutoffDate = new Date(Date.now() - timeoutMs).toISOString();

  let processing_total = 0;
  let processing_hitl_pending = 0;
  let processing_stuck = 0;

  try {
    const { data: processingRows, count } = await db
      .from('validation_queue')
      .select('metadata, created_at', { count: 'exact' })
      .eq('status', 'processing');

    if (processingRows) {
      processing_total = count ?? processingRows.length;
      for (const row of processingRows) {
        const isHitl = row.metadata?.hitl_request_id != null && row.metadata?.hitl_resolved !== 'true';
        if (isHitl) {
          processing_hitl_pending++;
        } else {
          const isStuck = new Date(row.created_at).getTime() < Date.now() - timeoutMs;
          if (isStuck) {
            processing_stuck++;
          }
        }
      }
    }
  } catch (err) {
    console.error('Failed to fetch validation_queue metrics', err);
  }

  res.json({
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
      processing_stuck
    }
  });
});

export default router;
