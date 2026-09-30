/**
 * POST /api/v1/hal/receipt — one vote row on the existing votes table.
 * Exact string true inserts. Any other flag value inserts nothing.
 * This route does not score.
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../db';
import { writeReceiptVote } from '../hal/quorum-receipt-writer';

const router = Router();
const ALLOWED = new Set(['family', 'host', 'verdict']);

function isVerdict(value: unknown): value is 'TRUE' | 'FALSE' | 'UNCERTAIN' | 'NOT_CHECKED' {
  return value === 'TRUE' || value === 'FALSE' || value === 'UNCERTAIN' || value === 'NOT_CHECKED';
}

function readBody(
  body: unknown,
): { family: string; host: string; verdict: 'TRUE' | 'FALSE' | 'UNCERTAIN' | 'NOT_CHECKED' } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED.has(key)) return null;
  }
  const { family, host, verdict } = record;
  if (typeof family !== 'string' || family.length === 0 || family.length > 64) return null;
  if (typeof host !== 'string' || host.length === 0 || host.length > 64) return null;
  if (!isVerdict(verdict)) return null;
  return { family, host, verdict };
}

router.post('/receipt', async (req: Request, res: Response): Promise<void> => {
  const input = readBody(req.body);
  if (!input) {
    res.status(400).json({ error: 'rejected' });
    return;
  }
  if (process.env.HAL_QUORUM_RECEIPT_ENABLED !== 'true') {
    res.status(204).end();
    return;
  }
  try {
    const result = await writeReceiptVote(db, input, process.env);
    if (!result.written) {
      const reason =
        result.reason === 'columns-missing' || result.reason === 'receipt-missing'
          ? result.reason
          : 'insert-error';
      res.status(200).json({ written: false, reason });
      return;
    }
    res.status(200).json({ written: true });
  } catch {
    res.status(200).json({ written: false, reason: 'insert-error' });
  }
});

export default router;
