import { Router } from 'express';
import { db } from '../../db';
import { routeEscalation, EscalationLevel } from '../../services/escalation-router';

// Escalation API (CC2 2026-05-26). POST is agent/worker-facing (mounted after the
// REPID_API_KEYS authMiddleware). GET reads back the ladder for the controller UI.
// NOTE: GET reads are currently API-key gated; the v0.app integration should move
// them to the SBT-gated controller surface (flagged in the API contract).
const router = Router();

const LEVELS: EscalationLevel[] = ['agent_internal', 'squad_internal', 'cross_squad', 'code_agent', 'sean'];

router.post('/escalate', async (req, res) => {
  const { agent_id, level, summary } = req.body || {};
  if (!agent_id || !summary || !LEVELS.includes(level)) {
    return res.status(400).json({ error: `agent_id, summary, and level (one of ${LEVELS.join(' | ')}) are required` });
  }
  try {
    const result = await routeEscalation(req.body);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

router.get('/', async (_req, res) => {
  const { data, error } = await db
    .from('controller_escalations')
    .select('*')
    .eq('status', 'routed')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: (data || []).length, escalations: data || [] });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await db.from('controller_escalations').select('*').eq('id', req.params.id).limit(1);
  if (error) return res.status(500).json({ error: error.message });
  const row = data?.[0];
  if (!row) return res.status(404).json({ error: 'escalation not found' });
  res.json(row);
});

export default router;
