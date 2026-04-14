import { Router, Request, Response } from 'express';
import { db } from '../db';
import { config } from '../config';

const router = Router();

router.get('/health', async (req: Request, res: Response) => {
  let supabaseConnected = false;
  try {
    const { error } = await db.from('repid_agents').select('id').limit(1);
    supabaseConnected = !error;
  } catch {}
  
  res.json({
    status: 'ok',
    version: config.version,
    timestamp: new Date().toISOString(),
    supabaseConnected,
    engine: 'HyperDAG RepID Scoring Engine',
    protocol: 'hyperdag.dev',
  });
});

export default router;
