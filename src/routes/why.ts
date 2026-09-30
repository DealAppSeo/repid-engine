/**
 * GET /api/v1/why
 * Four public reasons. Each row is an id and one sentence.
 */
import { Router, type Request, type Response } from 'express';

export const WHY_REASONS = [
  { id: 'lies', sentence: 'A statement with no receipt is not counted as true.' },
  { id: 'data', sentence: 'The receipt names the exchange and leaves the private work out.' },
  { id: 'lockin', sentence: 'You can take the receipt with you and stop using the service.' },
  { id: 'control', sentence: 'You pick the agent, and a score changes only after a recorded event.' },
] as const;

export function whyReasons(): { reasons: { id: string; sentence: string }[] } {
  return { reasons: WHY_REASONS.map((row) => ({ id: row.id, sentence: row.sentence })) };
}

const router = Router();

router.get('/why', (_req: Request, res: Response): void => {
  res.status(200).json(whyReasons());
});

export default router;
