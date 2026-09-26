/**
 * GET /api/v1/join-kit — what a visitor can do before an account exists.
 * Read-only. Does not call token signup and does not create an agent.
 */
import { Router, type Request, type Response } from 'express';
import { joinKit } from '../services/join-kit';

const router = Router();

router.get('/join-kit', (_req: Request, res: Response): void => {
  res.json(joinKit(process.env));
});

export default router;
