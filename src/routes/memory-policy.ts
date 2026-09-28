/**
 * GET /api/v1/memory/policy — keyless read of the memory policy.
 * Does not open a database and does not write.
 */
import { Router, type Request, type Response } from 'express';
import { memoryPolicy } from '../services/memory-policy';

const router = Router();

router.get('/memory/policy', (_req: Request, res: Response): void => {
  res.json(memoryPolicy());
});

export default router;
