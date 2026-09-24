/**
 * GET /api/v1/human/path — the human walk, in shadow.
 *
 * sign up → connect wallet → Base Sepolia testnet tokens → stake → bind agents
 * → blast-radius cap.
 *
 * Read-only. Mounted before auth so a visitor with no API key can see the
 * path. It inserts nothing, signs nothing, and dials no chain. Optional query
 * numbers preview the cap; omitting them is NOT_CHECKED, not zero.
 *
 *   agent_ceiling   USDC the agent's tier would allow per transaction
 *   owner_cap       USDC the owner would allow, or the word `none` when a
 *                   lookup found no owner limit
 */
import { Router, type Request, type Response } from 'express';
import { shadowHumanPath, type HumanPathInput } from '../services/human-path-shadow';

const router = Router();

function finite(raw: unknown): number | 'absent' | 'bad' {
  if (raw === undefined || raw === '') return 'absent';
  if (typeof raw !== 'string') return 'bad';
  const n = Number(raw);
  return Number.isFinite(n) ? n : 'bad';
}

router.get('/human/path', (req: Request, res: Response): void => {
  const agent = finite(req.query.agent_ceiling);
  const ownerRaw = req.query.owner_cap;
  if (agent === 'bad') {
    res.status(400).json({ error: 'bad_agent_ceiling', message: 'agent_ceiling must be a finite number of USDC.' });
    return;
  }

  const input: HumanPathInput = {};
  if (agent !== 'absent') input.agentCeilingUsdc = agent;

  if (ownerRaw !== undefined && ownerRaw !== '') {
    if (ownerRaw === 'none') {
      input.ownerCapUsdcPerTx = null;
    } else if (typeof ownerRaw !== 'string' || !Number.isFinite(Number(ownerRaw))) {
      res.status(400).json({
        error: 'bad_owner_cap',
        message: 'owner_cap must be a finite number of USDC, or the word none.',
      });
      return;
    } else {
      input.ownerCapUsdcPerTx = Number(ownerRaw);
    }
  }

  res.json(shadowHumanPath(input));
});

export default router;
