import { Router } from 'express';
import { db } from '../../db';
import { requireRole, mintQrToken } from '../../middleware/controller-auth';

// Controller API (CC2 2026-05-26) — backend for the aitc controller-UI rebuild
// (v0.app). All routes are gated by role permissions.
const router = Router();

// Base auth: every controller route needs at least a valid viewer role.
router.use(requireRole('viewer'));

// GET /agent-grid — live status of all Trinity agents.
router.get('/agent-grid', async (_req, res) => {
  const [hb, agents] = await Promise.all([
    db.from('agent_heartbeat').select('agent_name,status,last_ping,loop_count,code_version,current_task_id'),
    db.from('repid_agents').select('agent_name,current_repid,tier,last_active_at'),
  ]);
  const repidByName = new Map((agents.data || []).map((a: any) => [a.agent_name, a]));
  const now = Date.now();
  const grid = (hb.data || []).map((h: any) => {
    const a: any = repidByName.get(h.agent_name);
    const mins = h.last_ping ? (now - new Date(h.last_ping).getTime()) / 60000 : null;
    return {
      agent_name: h.agent_name,
      status: h.status,
      live: mins != null && mins < 5,
      minutes_since_ping: mins != null ? Number(mins.toFixed(1)) : null,
      loop_count: h.loop_count,
      code_version: h.code_version,
      current_task_id: h.current_task_id,
      repid: a?.current_repid ?? null,
      tier: a?.tier ?? null,
    };
  });
  const live = grid.filter((g) => g.live).length;
  res.json({ count: grid.length, live, uptime_pct: grid.length ? Math.round((live / grid.length) * 100) : 0, agents: grid });
});

// GET /activity-feed — recent task claims / completions / failures across agents.
router.get('/activity-feed', async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 30), 100);
  const { data, error } = await db
    .from('trinity_tasks')
    .select('id,title,task_type,status,claimed_by,agent_name,created_at,completed_at,updated_at')
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: (data || []).length, events: data || [] });
});

// GET /hallucination-meter — aggregate of recent HAL verdicts (24h).
router.get('/hallucination-meter', async (_req, res) => {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await db
    .from('hal_classifications')
    .select('id,verdict,hal_score,created_at')
    .gte('created_at', since)
    .limit(1000);
  if (error) return res.json({ window: '24h', total: 0, note: 'hal_classifications unavailable', error: error.message });
  const rows = data || [];
  const vetoed = rows.filter((r: any) => String(r.verdict || '').toLowerCase().includes('veto')).length;
  const scored = rows.filter((r: any) => r.hal_score != null);
  const avg = scored.length ? scored.reduce((s: number, r: any) => s + Number(r.hal_score), 0) / scored.length : null;
  res.json({
    window: '24h',
    total: rows.length,
    vetoed,
    veto_rate: rows.length ? Number((vetoed / rows.length).toFixed(3)) : 0,
    avg_hal_score: avg != null ? Number(avg.toFixed(3)) : null,
  });
});

// GET /squads — squad roster from the existing agent_squad_map (Gemini's squad work).
router.get('/squads', async (_req, res) => {
  const { data, error } = await db.from('agent_squad_map').select('agent_name,squad,role,is_active,railway_service');
  if (error) {
    return res.json({ squad_count: 0, squads: [], note: 'agent_squad_map unavailable — squad feature pending', dependency: 'Gemini squad table' });
  }
  const bySquad: Record<string, any[]> = {};
  for (const r of data || []) {
    (bySquad[r.squad] ||= []).push({ agent_name: r.agent_name, role: r.role, is_active: r.is_active, railway_service: r.railway_service });
  }
  res.json({
    squad_count: Object.keys(bySquad).length,
    squads: Object.entries(bySquad).map(([squad, members]) => ({ squad, members })),
  });
});

// POST /leads — capture emails for waitlist/prompts (gated to viewer).
router.post('/leads', async (req, res) => {
  const { email } = req.body || {};
  if (typeof email !== 'string' || !email.includes('@') || email.length < 3 || email.length > 255) {
    return res.status(400).json({ error: 'Valid email between 3 and 255 characters is required' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  const { error } = await db
    .from('trinity_leads')
    .insert({
      email: email.trim(),
      created_at: new Date().toISOString(),
    });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, message: 'Email captured successfully' });
});

// POST /directives — operator-privileged task injection.
router.post('/directives', requireRole('operator'), async (req, res) => {
  const { agent_name, title, description, success_criteria, expected_output, priority } = req.body || {};
  
  if (
    typeof agent_name !== 'string' || agent_name.length < 1 || agent_name.length > 100 ||
    typeof title !== 'string' || title.length < 1 || title.length > 255 ||
    typeof description !== 'string' || description.length < 1 || description.length > 5000 ||
    typeof success_criteria !== 'string' || success_criteria.length < 1 || success_criteria.length > 5000 ||
    typeof expected_output !== 'string' || expected_output.length < 1 || expected_output.length > 5000
  ) {
    return res.status(400).json({ error: 'Invalid string field types or lengths (max 255 for title, 5000 for text)' });
  }

  // Validate agent name format (alphanumeric, dashes, underscores, and UUIDs)
  const agentNameRegex = /^[a-zA-Z0-9-_]+$/;
  if (!agentNameRegex.test(agent_name)) {
    return res.status(400).json({ error: 'Invalid agent_name format' });
  }

  let validatedPriority = 1;
  if (priority !== undefined) {
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 5) {
      return res.status(400).json({ error: 'Priority must be an integer between 1 and 5' });
    }
    validatedPriority = priority;
  }

  const { data, error } = await db
    .from('trinity_tasks')
    .insert({
      title: title.trim(),
      description: description.trim(),
      success_criteria: success_criteria.trim(),
      expected_output: expected_output.trim(),
      agent_assigned: agent_name.trim(),
      agent_name: agent_name.trim(),
      assigned_to: agent_name.trim(),
      status: 'pending',
      priority: validatedPriority,
      insert_source: 'controller',
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, directive_task_id: data?.id });
});

// POST /token — mint scoped QR / link tokens.
router.post('/token', requireRole('operator'), (req, res) => {
  const { role, durationMs } = req.body || {};
  if (role !== undefined && !['viewer', 'operator', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role specified' });
  }
  const targetRole = role || 'viewer';

  let duration = 3600 * 1000; // default 1 hour
  if (durationMs !== undefined) {
    if (typeof durationMs !== 'number' || !Number.isInteger(durationMs) || durationMs <= 0 || durationMs > 24 * 3600 * 1000) {
      return res.status(400).json({ error: 'durationMs must be a positive integer not exceeding 24 hours' });
    }
    duration = durationMs;
  }

  const token = mintQrToken(targetRole, duration);
  const baseUrl = process.env.CONTROLLER_URL || 'https://controller.trustshell.dev';
  res.json({
    ok: true,
    token,
    role: targetRole,
    expiresAt: Date.now() + duration,
    shareUrl: `${baseUrl}/?token=${token}`,
  });
});

// POST /wake/:agent_id — manual wake signal (admin only).
router.post('/wake/:agent_id', requireRole('admin'), async (req, res) => {
  const agent = req.params.agent_id;
  const agentNameRegex = /^[a-zA-Z0-9-_]+$/;
  if (typeof agent !== 'string' || agent.length < 1 || agent.length > 100 || !agentNameRegex.test(agent)) {
    return res.status(400).json({ error: 'Invalid agent identity' });
  }

  const { data, error } = await db
    .from('trinity_tasks')
    .insert({
      title: 'CONTROLLER_WAKE',
      task_type: 'system',
      description: `Manual wake signal for ${agent} dispatched via controller.`,
      assigned_to: agent.trim(),
      agent_name: agent.trim(),
      status: 'pending',
      insert_source: 'controller',
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, agent, wake_task_id: data?.id });
});

// POST /sprint/:agent_id — dispatch a sprint to an agent (admin only).
router.post('/sprint/:agent_id', requireRole('admin'), async (req, res) => {
  const agent = req.params.agent_id;
  const agentNameRegex = /^[a-zA-Z0-9-_]+$/;
  if (typeof agent !== 'string' || agent.length < 1 || agent.length > 100 || !agentNameRegex.test(agent)) {
    return res.status(400).json({ error: 'Invalid agent identity' });
  }

  const { title, description, priority } = req.body || {};
  if (
    typeof title !== 'string' || title.length < 1 || title.length > 255 ||
    typeof description !== 'string' || description.length < 1 || description.length > 5000
  ) {
    return res.status(400).json({ error: 'title (max 255) and description (max 5000) strings are required' });
  }

  let validatedPriority: number | null = null;
  if (priority !== undefined && priority !== null) {
    if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 1 || priority > 5) {
      return res.status(400).json({ error: 'Priority must be an integer between 1 and 5' });
    }
    validatedPriority = priority;
  }

  const { data, error } = await db
    .from('trinity_tasks')
    .insert({
      title: title.trim(),
      task_type: 'system',
      description: description.trim(),
      assigned_to: agent.trim(),
      agent_name: agent.trim(),
      status: 'pending',
      priority: validatedPriority,
      insert_source: 'controller',
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, agent, sprint_task_id: data?.id });
});

export default router;
