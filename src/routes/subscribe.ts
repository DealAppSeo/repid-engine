/**
 * S-SPINE Phase 5 — email subscribe / unsubscribe (public, CAN-SPAM/GDPR-minimal).
 *
 * POST /subscribe   { email, source?, ref_code? } → 201 created / 409 already subscribed
 * GET  /unsubscribe?token=<uuid>                  → marks unsubscribed (required for compliance)
 *
 * Writes via the service-role db client (RLS: service_role only). Email format validated.
 * The route-level rate limiter (5/min/IP) is applied at mount in src/index.ts.
 * Mounted BEFORE authMiddleware (public).
 */
import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SOURCES = new Set(['trustchat', 'hub', 'trustshell', 'founding', 'other']);

router.post('/subscribe', async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const sourceRaw = String(req.body?.source ?? 'other').trim().toLowerCase();
  const source = SOURCES.has(sourceRaw) ? sourceRaw : 'other';
  const ref_code = req.body?.ref_code ? String(req.body.ref_code).slice(0, 200) : null;

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  try {
    // Detect existing first for a clean 409 (UNIQUE would also catch it).
    const { data: existing } = await db
      .from('email_subscribers').select('id, unsubscribed_at').eq('email', email).maybeSingle();
    if (existing) {
      // If previously unsubscribed, resubscribe; otherwise 409.
      if ((existing as any).unsubscribed_at) {
        const { error: upErr } = await db
          .from('email_subscribers')
          .update({ unsubscribed_at: null, subscribed_at: new Date().toISOString(), source, ref_code })
          .eq('id', (existing as any).id);
        if (upErr) return res.status(500).json({ error: 'resubscribe_failed', detail: upErr.message });
        return res.status(200).json({ ok: true, resubscribed: true });
      }
      return res.status(409).json({ error: 'already_subscribed' });
    }
    const { data, error } = await db
      .from('email_subscribers')
      .insert({ email, source, ref_code })
      .select('id, confirmation_token')
      .maybeSingle();
    if (error) {
      if (/duplicate key|unique/i.test(error.message)) return res.status(409).json({ error: 'already_subscribed' });
      return res.status(500).json({ error: 'subscribe_failed', detail: error.message });
    }
    return res.status(201).json({ ok: true, id: (data as any)?.id ?? null });
  } catch (e: any) {
    return res.status(500).json({ error: 'subscribe_failed', detail: e?.message ?? String(e) });
  }
});

router.get('/unsubscribe', async (req: Request, res: Response) => {
  const token = String(req.query?.token ?? '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return res.status(400).json({ error: 'invalid_token' });
  }
  try {
    const { data, error } = await db
      .from('email_subscribers')
      .update({ unsubscribed_at: new Date().toISOString() })
      .eq('confirmation_token', token)
      .select('id')
      .maybeSingle();
    if (error) return res.status(500).json({ error: 'unsubscribe_failed', detail: error.message });
    if (!data) return res.status(404).json({ error: 'token_not_found' });
    return res.json({ ok: true, unsubscribed: true });
  } catch (e: any) {
    return res.status(500).json({ error: 'unsubscribe_failed', detail: e?.message ?? String(e) });
  }
});

export default router;
