import { Router, Request, Response } from 'express';
import { verifyAuditChain } from '../services/auditChainWriter';

const router = Router();

// Public auditability endpoint. Walks hal_audit_chain from id=1 forward,
// recomputing every hash, and returns the first break (if any) or the tail.
router.get('/verify', async (_req: Request, res: Response) => {
  try {
    const result = await verifyAuditChain();
    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'verify failed' });
  }
});

export default router;
