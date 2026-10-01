/**
 * POST /api/v1/human/bind when the body names a wallet and an agent.
 * Inserts one human_agent_binds row when HUMAN_AGENT_BIND_ENABLED is the exact string true.
 * A repeated pair is 409. Unset or any other value is 410 and inserts nothing.
 * A body with neither field falls through to the existing bind route.
 * This route does not score.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { db } from '../db';

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

router.post('/human/bind', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    next();
    return;
  }
  const record = body as Record<string, unknown>;
  const wallet = text(record, 'wallet');
  const agent = text(record, 'agent_id') || text(record, 'agent');
  if (!wallet && !agent) {
    next();
    return;
  }
  if (!wallet || wallet.length > 128 || !UUID.test(agent)) {
    res.status(400).json({ error: 'rejected' });
    return;
  }
  const bindEnabled = process.env.HUMAN_AGENT_BIND_ENABLED === 'true';
  if (!bindEnabled) {
    res.status(410).json({ error: 'disabled' });
    return;
  }
  const { error } = await db.from('human_agent_binds').insert({ wallet, agent_id: agent });
  if (error) {
    const code = (error as { code?: string }).code;
    const conflict = code === '23505';
    res.status(conflict ? 409 : 500).json({ error: conflict ? 'conflict' : 'insert-error' });
    return;
  }
  res.status(201).json({ ok: true });
});

export default router;
