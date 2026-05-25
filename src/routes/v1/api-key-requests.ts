/**
 * API key issuance V0 — request intake.
 *
 * Public endpoint (a developer has no key yet): mounted BEFORE authMiddleware and added to the SQL
 * sanitizer bypass (use_case is free-form prose). Writes a row to api_key_requests for Sean to review
 * + provision via scripts/api-keys/provision.ts. Rate-limited to 1 request/hour per email.
 *
 * Depends on the api_key_requests table (migration 20260524120000 — apply after Sean greenlight).
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ApiKeyRequestBody {
  email?: unknown;
  use_case?: unknown;
  organization?: unknown;
}

/** Pure validation (unit-testable, no IO). Returns the cleaned fields or an error message. */
export function validateApiKeyRequestBody(
  body: ApiKeyRequestBody,
): { ok: true; email: string; use_case: string; organization: string | null } | { ok: false; error: string } {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const use_case = typeof body.use_case === 'string' ? body.use_case.trim() : '';
  const organization = typeof body.organization === 'string' && body.organization.trim() ? body.organization.trim() : null;
  if (!email || !EMAIL_RE.test(email)) return { ok: false, error: 'valid email required' };
  if (email.length > 254) return { ok: false, error: 'email too long' };
  if (use_case.length < 10) return { ok: false, error: 'use_case required (min 10 chars)' };
  if (use_case.length > 2000) return { ok: false, error: 'use_case too long (max 2000 chars)' };
  return { ok: true, email, use_case, organization };
}

export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 request / hour / email

const router = Router();

router.post('/request', async (req: Request, res: Response) => {
  const v = validateApiKeyRequestBody(req.body ?? {});
  if (!v.ok) return res.status(400).json({ error: v.error });

  // Rate limit: 1 pending/recent request per email per hour.
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
  const { data: recent, error: rlErr } = await db
    .from('api_key_requests')
    .select('id')
    .eq('email', v.email)
    .gte('requested_at', since)
    .limit(1);
  if (rlErr) {
    console.error('[api-key-requests] rate-limit check failed:', rlErr.message);
    return res.status(500).json({ error: 'request_failed' });
  }
  if (recent && recent.length > 0) {
    return res.status(429).json({ error: 'rate_limited', message: 'One request per email per hour. We will be in touch.' });
  }

  const { data, error } = await db
    .from('api_key_requests')
    .insert({ email: v.email, use_case: v.use_case, organization: v.organization, status: 'pending' })
    .select('id')
    .single();
  if (error || !data) {
    console.error('[api-key-requests] insert failed:', error?.message);
    return res.status(500).json({ error: 'request_failed' });
  }

  return res.status(201).json({ request_id: data.id, status: 'pending', message: 'Request received. A testnet key will be emailed after review.' });
});

export default router;
