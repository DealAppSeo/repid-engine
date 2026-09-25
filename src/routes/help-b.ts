/**
 * POST /api/v1/help-b/rate
 *
 * Closed unless HELP_B_WRITES_ENABLED is the exact string true. Then 410 and
 * no insert. A missing n is NOT_CHECKED and is not stored as 0.
 */
import { Router, type Request, type Response } from 'express';
import { db } from '../db';
import { helpBWritesEnabled, readHelpB } from '../services/help-b';

const router = Router();

router.post('/help-b/rate', async (req: Request, res: Response): Promise<void> => {
  if (!helpBWritesEnabled()) {
    res.status(410).json({
      ok: false,
      stored: false,
      status: 'NOT_CHECKED',
      error: 'help_b_writes_closed',
    });
    return;
  }

  const record = readHelpB(req.body ?? {});
  if (record.status !== 'recorded') {
    res.status(422).json({ ...record, stored: false });
    return;
  }

  const { error } = await db.from('help_b_ratings').insert({
    rater_type: record.rater_type,
    subject: record.subject,
    dim: record.dim,
    value: record.value,
    n: record.n,
  });
  if (error) {
    res.status(500).json({ ok: false, stored: false, error: 'help_b_write_failed' });
    return;
  }
  res.status(201).json({ ok: true, stored: true, ...record });
});

export default router;
