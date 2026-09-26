/**
 * GET /api/v1/join-kit — where a newcomer goes next, and what they can do.
 * can_verify is true. can_bind is the exact string true on the bind flag.
 * can_stake is false. This does not read REAL_STAKING_ENABLED.
 */
import { Router, type Request, type Response } from 'express';
import { TRUTHY } from '../config/flag-readiness';

const router = Router();

export function joinKit(env: Record<string, string | undefined> = process.env) {
  return {
    verify: '/api/v1/repid/verify',
    status: '/readiness',
    repid: '/api/v1/repid/:agentId',
    proof: '/api/v1/proof/verify',
    honesty_a: '/api/v1/hal/honesty-a',
    after_create: '/api/v1/after-create',
    can_verify: true as const,
    can_bind: env.HUMAN_AGENT_BIND_ENABLED === TRUTHY,
    can_stake: false as const,
  };
}

router.get('/join-kit', (_req: Request, res: Response): void => {
  res.json(joinKit(process.env));
});

export default router;
