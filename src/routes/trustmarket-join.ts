/**
 * GET /api/v1/trustmarket/join
 * can_list and can_stake stay false. This card does not read a staking flag.
 */
import { Router, type Request, type Response } from 'express';

const router = Router();

export function trustmarketJoin() {
  return {
    can_list: false as const,
    can_stake: false as const,
  };
}

router.get('/trustmarket/join', (_req: Request, res: Response): void => {
  res.json(trustmarketJoin());
});

export default router;
