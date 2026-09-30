/**
 * GET /api/v1/onboard/unlock
 * A counted receipt total of 1 unlocks layer 1. Any other count unlocks nothing.
 * This route does not query or insert.
 */
import { Router, type Request, type Response } from 'express';

export function unlockForReceiptCount(counted: number): { unlocked: number[] } {
  if (counted === 1) return { unlocked: [1] };
  return { unlocked: [] };
}

export function createOnboardUnlockRouter(countReceipts: () => Promise<number> = async () => 0) {
  const router = Router();
  router.get('/onboard/unlock', async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json(unlockForReceiptCount(await countReceipts()));
  });
  return router;
}

export default createOnboardUnlockRouter();
