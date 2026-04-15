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
  });
});

export default router;
