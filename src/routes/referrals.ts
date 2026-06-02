/**
 * S-SPINE Phase 6 — referral tracking.
 *
 *  POST /track            (public)  { ref_code, source_type, user_agent?, session_id? }
 *  GET  /referrals/stats  (authed)  → aggregate dashboard
 *
 * Two routers: `publicRouter` mounts BEFORE authMiddleware (visitors hit /track), `statsRouter`
 * mounts AFTER (so the dashboard requires a valid API key — service_role / Sean). Writes via the
 * service-role db client.
 */
import { Router, Request, Response } from 'express';
import { db } from '../db';

export const publicRouter = Router();
export const statsRouter = Router();

const SOURCE_TYPES = new Set(['qr_code', 'share_link', 'email', 'social', 'direct']);

publicRouter.post('/track', async (req: Request, res: Response) => {
  const ref_code = String(req.body?.ref_code ?? '').trim().slice(0, 200);
  const sourceRaw = String(req.body?.source_type ?? 'direct').trim().toLowerCase();
  const source_type = SOURCE_TYPES.has(sourceRaw) ? sourceRaw : 'direct';
  const user_agent = req.body?.user_agent ? String(req.body.user_agent).slice(0, 500) : null;
  const session_id = req.body?.session_id ? String(req.body.session_id) : null;

  if (!ref_code) return res.status(400).json({ error: 'missing_ref_code' });
  try {
    const { data, error } = await db
      .from('referral_tracking')
      .insert({
        ref_code, source_type, user_agent, session_id,
        converted_to_session: !!session_id,
      })
      .select('id')
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'track_failed', detail: error.message });
    return res.status(201).json({ ok: true, id: (data as any)?.id ?? null });
  } catch (e: any) {
    return res.status(500).json({ error: 'track_failed', detail: e?.message ?? String(e) });
  }
});

statsRouter.get('/referrals/stats', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await db
      .from('referral_tracking')
      .select('ref_code, source_type, converted_to_session, converted_to_email')
      .limit(50000);
    if (error) return res.status(500).json({ error: 'stats_failed', detail: error.message });
    const rows = (data ?? []) as any[];
    const total = rows.length;
    const by_source: Record<string, number> = {};
    const byCode = new Map<string, { visits: number; conversions: number }>();
    let conversions = 0;
    for (const r of rows) {
      by_source[r.source_type] = (by_source[r.source_type] ?? 0) + 1;
      const converted = r.converted_to_session === true || r.converted_to_email === true;
      if (converted) conversions++;
      const c = byCode.get(r.ref_code) ?? { visits: 0, conversions: 0 };
      c.visits++; if (converted) c.conversions++;
      byCode.set(r.ref_code, c);
    }
    const top_ref_codes = [...byCode.entries()]
      .map(([code, v]) => ({ code, visits: v.visits, conversions: v.conversions }))
      .sort((a, b) => b.visits - a.visits)
      .slice(0, 10);
    return res.json({
      total_referrals: total,
      by_source,
      conversion_rate: total ? Math.round((conversions / total) * 100) / 100 : 0,
      top_ref_codes,
      last_updated: new Date().toISOString(),
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'stats_failed', detail: e?.message ?? String(e) });
  }
});
