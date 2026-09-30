/**
 * GET /api/v1/receipt/hal-latest — the newest vote row.
 * Four fields. None means 404. This handler does not insert.
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../db';

const router = Router();

export interface HalLatestCard {
  family: string;
  host: string;
  verdict: string;
  created_at: string;
}

export function halLatestCard(row: {
  family?: string | null;
  host?: string | null;
  provider?: string | null;
  verdict?: string | null;
  created_at?: string | null;
} | null): HalLatestCard | null {
  if (!row) return null;
  const family = typeof row.family === 'string' && row.family.length > 0 ? row.family : '';
  const namedHost = typeof row.host === 'string' && row.host.length > 0 ? row.host : row.provider;
  const host = typeof namedHost === 'string' && namedHost.length > 0 ? namedHost : '';
  const verdict = typeof row.verdict === 'string' && row.verdict.length > 0 ? row.verdict : '';
  const createdAt = typeof row.created_at === 'string' && row.created_at.length > 0 ? row.created_at : '';
  if (!family || !host || !verdict || !createdAt) return null;
  return { family, host, verdict, created_at: createdAt };
}

router.get('/receipt/hal-latest', async (_req: Request, res: Response): Promise<void> => {
  try {
    const { data, error } = await db
      .from('hal_quorum_validator_votes')
      .select('family, host, provider, verdict, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const card = halLatestCard(data);
    if (!card) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(200).json(card);
  } catch {
    res.status(404).json({ error: 'not_found' });
  }
});

export default router;
