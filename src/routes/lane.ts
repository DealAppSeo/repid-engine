/**
 * GET /api/v1/lane/:agent — the practice lane for one agent (slice P1; services/practice-lane.ts).
 *
 * PUBLIC and read-only, mounted before authMiddleware like the owner route in v1/byok.ts: it shows
 * only what is already public (whether someone owns the agent, and an allowance anyone can read on
 * chain). One chain read per request, so it has its own rate limit in src/index.ts.
 */
import { Router, type Request, type Response } from 'express';
import { laneReport } from '../services/practice-lane';
import { rpcSpendChain, type SpendChain } from '../services/agent-spend';

const DEFAULT_RPC_URL = 'https://sepolia.base.org';

export function createLaneRouter(chain?: SpendChain | null): Router {
  const router = Router();
  const getChain = () => (chain === undefined ? (chain = rpcSpendChain(process.env.BASE_SEPOLIA_RPC_URL || DEFAULT_RPC_URL)) : chain);

  router.get('/lane/:agent', async (req: Request, res: Response) => {
    const r = await laneReport(String(req.params.agent), { chain: getChain() });
    if (!r.ok) return res.status(r.status).json({ error: r.error, message: r.message });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(r.report);
  });

  return router;
}
