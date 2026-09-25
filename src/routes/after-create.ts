/**
 * GET /api/v1/after-create — what a new account can do.
 * Read-only. Does not call token signup and does not create an agent.
 */
import { Router, type Request, type Response } from 'express';
import { afterCreateCard } from '../services/after-create';

const router = Router();

router.get('/after-create', (_req: Request, res: Response): void => {
  res.json(afterCreateCard(process.env));
});

export default router;
