/**
 * GET /api/v1/hal/honesty-a — read-only 7-day verdict counts.
 *
 * Selects family, provider, and verdict only. No claim text, no user id, no agent id,
 * no latency. A database error or a full page is NOT_CHECKED, not a fabricated count.
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../db';
import {
  aggregateHonestyA,
  HONESTY_A_LLM_LOG_GAP,
  HONESTY_A_PAGE_CAP,
  HONESTY_A_WINDOW_DAYS,
  honestyANotChecked,
  type HonestyVote,
} from '../services/honesty-a';

const router = Router();

router.get('/honesty-a', async (_req: Request, res: Response): Promise<void> => {
  const since = new Date(Date.now() - HONESTY_A_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await db
      .from('hal_quorum_validator_votes')
      .select('family, provider, verdict')
      .gte('created_at', since)
      .limit(HONESTY_A_PAGE_CAP);
    if (error) {
      res.json(honestyANotChecked(`${HONESTY_A_LLM_LOG_GAP} Vote read failed: ${error.message}`));
      return;
    }
    const votes = (data ?? []) as HonestyVote[];
    if (votes.length >= HONESTY_A_PAGE_CAP) {
      res.json(
        honestyANotChecked(
          `${HONESTY_A_LLM_LOG_GAP} The vote read hit ${HONESTY_A_PAGE_CAP} rows. A partial page is not a count.`,
        ),
      );
      return;
    }
    res.json(aggregateHonestyA(votes));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json(honestyANotChecked(`${HONESTY_A_LLM_LOG_GAP} Vote read threw: ${message}`));
  }
});

export default router;
