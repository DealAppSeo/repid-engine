/**
 * GET /api/v1/human/spend/preview
 * Names the wallet and the agent from the query.
 * applied stays false. sends_eth stays false.
 * An unbound agent is denied. The visible cap is not a transfer.
 * No stake row is read. This route does not insert a spend.
 */
import { Router, type Request, type Response } from 'express';
import { previewSpendFixture } from '../services/spend-preview';

const router = Router();

function one(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

router.get('/human/spend/preview', (req: Request, res: Response): void => {
  res.status(200).json(previewSpendFixture([], {
    wallet: one(req.query.wallet),
    agent: one(req.query.agent),
    bound: one(req.query.bound),
  }));
});

export default router;
