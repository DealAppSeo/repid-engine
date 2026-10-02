/**
 * GET /api/v1/stamp — read one stamp row.
 * Payload is family, host, verdict, and latency_ms.
 * A failed read is NOT_CHECKED, not 0. No claim text. No user id.
 * latency_ms is null when the call was not timed. A missing time is not 0.
 * This handler does not write.
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../db';
import { readStampRow, type StampReadRow } from '../orchestration/stamp-row';

const router = Router();

export type StampPayload = StampReadRow & { latency_ms: number | null };

/** A recorded duration. 0, "0", and any non-finite value were not timed. */
export function stampLatency(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return value;
  return null;
}

export const STAMP_READ_MISS: StampPayload = {
  family: 'NOT_CHECKED',
  host: 'NOT_CHECKED',
  verdict: 'NOT_CHECKED',
  latency_ms: null,
};

export function stampReadPayload(row: unknown): StampPayload {
  if (!row || typeof row !== 'object') return STAMP_READ_MISS;
  const record = row as Record<string, unknown>;
  const read = readStampRow({
    family: record.family,
    host: record.host,
    verdict: record.verdict,
    score: record.score,
    timeout: record.timeout === true,
  });
  return {
    family: read.family,
    host: read.host,
    verdict: read.verdict,
    latency_ms: stampLatency(record.latency_ms),
  };
}

export async function getStamp(_req: Request, res: Response): Promise<void> {
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
}

router.get('/stamp', getStamp);

export default router;
