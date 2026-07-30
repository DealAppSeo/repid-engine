// GET /api/v1/passport/:agentId — the public Agent Trust Passport.
//
// The one-call composite a counterparty (merchant, marketplace, another agent)
// hits before authorizing an agent: RepID + tier, ERC-8004 identity metadata
// with a live-verification link, real-vs-simulated x402 settlement history,
// on-chain reputation write count, and the latest ZKP proof labeled honestly.
//
// Public surface — mounted BEFORE authMiddleware in src/index.ts, same as the
// observability/repid public routers. CORS is pinned globally to the Trust*
// frontends (tests/cors-origins.test.ts). DB-first: no per-request RPC.
import { Router, type Request, type Response } from 'express';
import { db } from '../../db';
import { buildAgentPassport, PassportQueryError } from '../../services/agent-passport';

const router = Router();

router.get('/passport/:agentId', async (req: Request, res: Response) => {
  try {
    const passport = await buildAgentPassport(db, String(req.params.agentId ?? ''));
    if (!passport) {
      return res.status(404).json({ error: 'agent_not_found' });
    }
    // Modest edge cache: passports change on score events, not per-request.
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json(passport);
  } catch (e: unknown) {
    if (e instanceof PassportQueryError) {
      console.error(`[passport] ${e.message}`);
      return res.status(500).json({ error: 'query_failed', step: e.step });
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[passport] unexpected: ${msg}`);
    return res.status(500).json({ error: 'internal' });
  }
});

export default router;
