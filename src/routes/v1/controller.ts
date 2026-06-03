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
  if (!email || !String(email).includes('@')) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  const { error } = await db
    .from('trinity_leads')
    .insert({
      email: String(email).trim(),
      created_at: new Date().toISOString(),
    });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, message: 'Email captured successfully' });
});

// POST /directives — operator-privileged task injection.
router.post('/directives', requireRole('operator'), async (req, res) => {
  const { agent_name, title, description, success_criteria, expected_output, priority } = req.body || {};
  if (!agent_name || !title || !description || !success_criteria || !expected_output) {
    return res.status(400).json({ error: 'agent_name, title, description, success_criteria, and expected_output are required' });
  }
  const { data, error } = await db
    .from('trinity_tasks')
    .insert({
      title: String(title),
      description: String(description),
      success_criteria: String(success_criteria),
      expected_output: String(expected_output),
      agent_assigned: String(agent_name),
      agent_name: String(agent_name),
      assigned_to: String(agent_name),
      status: 'pending',
      priority: priority != null ? Number(priority) : 1,
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
  const targetRole = role === 'admin' || role === 'operator' || role === 'viewer' ? role : 'viewer';
  const duration = durationMs != null ? Number(durationMs) : 3600 * 1000; // default 1 hour
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
  const { data, error } = await db
    .from('trinity_tasks')
    .insert({
      title: 'CONTROLLER_WAKE',
      task_type: 'system',
      description: `Manual wake signal for ${agent} dispatched via controller.`,
      assigned_to: agent,
      agent_name: agent,
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
  const { title, description, priority } = req.body || {};
  if (!title || !description) {
    return res.status(400).json({ error: 'title and description are required' });
  }
  const { data, error } = await db
    .from('trinity_tasks')
    .insert({
      title: String(title),
      task_type: 'system',
      description: String(description),
      assigned_to: agent,
      agent_name: agent,
      status: 'pending',
      priority: priority != null ? Number(priority) : null,
      insert_source: 'controller',
      created_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, agent, sprint_task_id: data?.id });
});

export default router;
