/**
 * GET /api/v1/join-kit — where a newcomer goes next.
 * Paths only. can_stake is false. This does not read REAL_STAKING_ENABLED.
 */
import { Router, type Request, type Response } from 'express';

const router = Router();

export function joinKit() {
  return {
    verify: '/api/v1/repid/verify',
    status: '/readiness',
    repid: '/api/v1/repid/:agentId',
    proof: '/api/v1/proof/verify',
    honesty_a: '/api/v1/hal/honesty-a',
    after_create: '/api/v1/after-create',
    can_stake: false as const,
  };
}

router.get('/join-kit', (_req: Request, res: Response): void => {
  res.json(joinKit());
});

export default router;
