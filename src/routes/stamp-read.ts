/**
 * GET /api/v1/hal/stamp — read one stamp row.
 * Payload is family, host, and verdict only.
 * A failed read is NOT_CHECKED, not 0. No claim text. No user id.
 * This route does not write.
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../db';
import { readStampRow, type StampReadRow } from '../orchestration/stamp-row';

const router = Router();

export const STAMP_READ_MISS: StampReadRow = {
  family: 'NOT_CHECKED',
  host: 'NOT_CHECKED',
  verdict: 'NOT_CHECKED',
};

export function stampReadPayload(row: unknown): StampReadRow {
  if (!row || typeof row !== 'object') return STAMP_READ_MISS;
  const record = row as Record<string, unknown>;
  return readStampRow({
    family: record.family,
    host: record.host,
    verdict: record.verdict,
    score: record.score,
    timeout: record.timeout === true,
  });
}

router.get('/stamp', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await db
      .from('hal_quorum_validator_votes')
      .select('family, host, verdict')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      res.status(200).json(STAMP_READ_MISS);
      return;
    }
    res.status(200).json(stampReadPayload(data));
  } catch {
    res.status(200).json(STAMP_READ_MISS);
  }
});

export default router;
