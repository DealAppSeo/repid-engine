/**
 * GET /api/v1/human/spend/preview
 * Returns the fixture rates 50 and 100.
 * applied stays false. sends_eth stays false. No stake row is read.
 * This route does not insert a spend.
 */
import { Router, type Request, type Response } from 'express';
import { previewSpendFixture } from '../services/spend-preview';

const router = Router();

router.get('/human/spend/preview', (_req: Request, res: Response): void => {
  res.status(200).json(previewSpendFixture([]));
});

export default router;
