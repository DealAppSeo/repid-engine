import { Router, Request, Response } from 'express';

const router = Router();

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: "ok", version: "1.0.0", service: "repid-engine" });
});

router.post('/prove-repid', (req: Request, res: Response) => {
  const { agent_id, requester_pubkey, requested_tier } = req.body;
  res.json({
    proof: "mock-proof",
    tier: requested_tier,
    payload: {},
    repid_score: 0
  });
});

export default router;
