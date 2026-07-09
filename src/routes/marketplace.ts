/**
 * TrustMarket-light P0 router — schema + list/browse ONLY.
 *
 * Per E:\dev\living-docs\03_specs\TRUSTMARKET_LIGHT_SPEC_v0.md. Agents AND humans
 * post haves/wants (buy or rent); the public /browse surface renders each card
 * with the poster's RepID + tier badge — trust shown, not claimed.
 *
 * SCOPE (P0): POST /list, GET /browse. Offer/accept + x402 settlement are P1
 * (marketplace_offers exists but has NO endpoints here).
 *
 * Mounting (src/index.ts): mounted at /api/v1/marketplace BEFORE the global
 * SQL-keyword sanitizer and BEFORE authMiddleware — same precedent as the
 * full-account router. /list carries prose (title/description) that legitimately
 * contains SQL-shaped tokens, and it does its OWN auth (human login_token OR
 * agent API key), so the blanket REPID_API_KEY authMiddleware must not gate it.
 * All Supabase writes below are parameterized via supabase-js.
 *
 * DATA PLANE: reads/writes marketplace_listings only (P0). On prod these run
 * under the RLS-bypassing service-role key; schema applied to the TEST project
 * first (scripts/test-schema/marketplace.sql). Prod DDL is Sean-gated.
 */
import { Router, Request, Response } from 'express';
import { db } from '../db';
import { computeTier } from '../engine/repid-update';
import { verifyFullAccountToken } from '../services/auth-token';
import { validateAgentApiKey } from '../auth/api-keys';

const KINDS = ['have', 'want'] as const;
const MODES = ['buy', 'rent'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PosterType = 'agent' | 'human';
export interface PosterIdentity {
  poster_type: PosterType;
  poster_id: string;
}

/**
 * Resolve the poster identity from the request's own auth.
 *   - human: a full-account login_token (Authorization: Bearer <token>) →
 *     poster_id = builder_id (identity from the token, never client-spoofable).
 *   - agent: an API key. A DB-issued key (agent_api_keys) binds an agent_id,
 *     which becomes poster_id. An env REPID_API_KEYS key is not bound to a
 *     single agent, so the agent must declare `poster_id` in the body.
 * Returns null when no valid credential is present.
 */
export async function resolvePosterIdentity(req: Request): Promise<PosterIdentity | null> {
  const authz = (req.headers['authorization'] as string | undefined) ?? '';
  const bearer = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : '';
  const apiKeyHeader = (req.headers['x-api-key'] as string | undefined) ?? '';

  // 1) Human — full-account login_token (a signed token, not an API key).
  if (bearer) {
    const payload = verifyFullAccountToken(bearer);
    if (payload && payload.builder_id) {
      return { poster_type: 'human', poster_id: String(payload.builder_id) };
    }
  }

  // 2) Agent — API key (Bearer <key> or x-api-key).
  const candidateKey = apiKeyHeader || bearer;
  if (!candidateKey) return null;

  // 2a) env REPID_API_KEYS allowlist (key or key:tier). Unbound identity →
  // the agent must declare which agent it posts as via body.poster_id.
  const envKeys = (process.env.REPID_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((k) => k.split(':')[0]);
  if (envKeys.includes(candidateKey)) {
    const declared = typeof req.body?.poster_id === 'string' ? req.body.poster_id.trim() : '';
    if (!declared) return null; // handled as 400 by caller (poster_id required for env keys)
    return { poster_type: 'agent', poster_id: declared };
  }

  // 2b) DB-issued key (hashed, bound to an agent_id).
  try {
    const dbKey = await validateAgentApiKey(candidateKey);
    if (dbKey && dbKey.agent_id) {
      return { poster_type: 'agent', poster_id: String(dbKey.agent_id) };
    }
  } catch {
    // DB unreachable → treat as unauthenticated.
  }

  return null;
}

/** Look up a poster's current RepID (agents only; humans have none directly). */
async function resolveCurrentRepid(posterType: PosterType, posterId: string): Promise<number | null> {
  if (posterType !== 'agent') return null;
  const col = UUID_RE.test(posterId) ? 'id' : 'agent_name';
  const { data, error } = await db
    .from('repid_agents')
    .select('current_repid')
    .eq(col, posterId)
    .maybeSingle();
  if (error || !data) return null;
  const v = (data as { current_repid: number | null }).current_repid;
  return typeof v === 'number' ? v : null;
}

const router = Router();

/**
 * POST /list — create a listing.
 * Auth: human login_token OR agent API key (resolvePosterIdentity).
 * Body: { kind, mode, title, category?, description?, price_usdc?, rent_period?,
 *         expires_at?, poster_id? (required only for env-key agents) }
 */
router.post('/list', async (req: Request, res: Response) => {
  const identity = await resolvePosterIdentity(req);
  if (!identity) {
    return res.status(401).json({
      error: 'auth required: human login_token (Bearer) or agent API key (x-api-key). ' +
        'env-key agents must also supply poster_id.',
    });
  }

  const body = (req.body ?? {}) as Record<string, unknown>;

  const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
  if (!(KINDS as readonly string[]).includes(kind)) {
    return res.status(400).json({ error: "kind must be 'have' or 'want'" });
  }

  const mode = typeof body.mode === 'string' ? body.mode.trim() : '';
  if (!(MODES as readonly string[]).includes(mode)) {
    return res.status(400).json({ error: "mode must be 'buy' or 'rent'" });
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return res.status(400).json({ error: 'title required' });
  if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200 chars)' });

  const description = typeof body.description === 'string' ? body.description.trim() : null;
  if (description && description.length > 2000) {
    return res.status(400).json({ error: 'description too long (max 2000 chars)' });
  }

  const category = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : null;

  let price_usdc: number | null = null;
  if (body.price_usdc !== undefined && body.price_usdc !== null && body.price_usdc !== '') {
    const p = typeof body.price_usdc === 'number' ? body.price_usdc : Number(body.price_usdc);
    if (!Number.isFinite(p) || p < 0) {
      return res.status(400).json({ error: 'price_usdc must be a non-negative number' });
    }
    price_usdc = p;
  }

  let rent_period: string | null = null;
  if (mode === 'rent') {
    rent_period = typeof body.rent_period === 'string' ? body.rent_period.trim() : '';
    if (!rent_period) return res.status(400).json({ error: "rent_period required when mode='rent'" });
  } else if (typeof body.rent_period === 'string' && body.rent_period.trim()) {
    // buy mode: ignore any supplied rent_period (kept null).
    rent_period = null;
  }

  let expires_at: string | null = null;
  if (typeof body.expires_at === 'string' && body.expires_at.trim()) {
    const d = new Date(body.expires_at);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'expires_at must be an ISO timestamp' });
    expires_at = d.toISOString();
  }

  // Stamp the poster's current RepID at post time (agents; null if unresolvable).
  const repid_at_post = await resolveCurrentRepid(identity.poster_type, identity.poster_id);

  const { data, error } = await db
    .from('marketplace_listings')
    .insert({
      poster_type: identity.poster_type,
      poster_id: identity.poster_id,
      kind,
      category,
      title,
      description,
      price_usdc,
      mode,
      rent_period,
      status: 'open',
      repid_at_post,
      expires_at,
    })
    .select('id, created_at')
    .single();

  if (error || !data) {
    console.error('[marketplace-p0] listing insert failed:', error?.message);
    return res.status(500).json({ error: 'listing_create_failed' });
  }

  return res.status(201).json({
    listing_id: (data as { id: string }).id,
    status: 'open',
    poster_type: identity.poster_type,
    poster_id: identity.poster_id,
    repid_at_post,
    created_at: (data as { created_at: string }).created_at,
  });
});

/**
 * GET /browse — PUBLIC / keyless. Open listings, newest first, each enriched
 * with the poster's live RepID + tier (the trust badge). Optional filters:
 *   ?kind=have|want   ?category=<cat>   ?limit=<n> (default 50, max 100)
 */
router.get('/browse', async (req: Request, res: Response) => {
  const kindFilter = typeof req.query.kind === 'string' ? req.query.kind.trim() : '';
  const categoryFilter = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 50;

  let query = db
    .from('marketplace_listings')
    .select('id, poster_type, poster_id, kind, category, title, description, price_usdc, mode, rent_period, status, repid_at_post, created_at, expires_at')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (kindFilter && (KINDS as readonly string[]).includes(kindFilter)) query = query.eq('kind', kindFilter);
  if (categoryFilter) query = query.eq('category', categoryFilter);

  const { data, error } = await query;
  if (error) {
    console.error('[marketplace-p0] browse query failed:', error.message);
    return res.status(500).json({ error: 'browse_query_failed' });
  }

  const listings = (data ?? []) as Array<Record<string, any>>;

  // Enrich AGENT posters with live RepID + tier. Batch by id and by agent_name
  // (poster_id can be either a uuid or a canonical agent_name).
  const agentPosterIds = Array.from(
    new Set(listings.filter((l) => l.poster_type === 'agent' && l.poster_id).map((l) => String(l.poster_id))),
  );
  const repidById = new Map<string, { current_repid: number | null; tier: string | null }>();
  const repidByName = new Map<string, { current_repid: number | null; tier: string | null }>();

  if (agentPosterIds.length > 0) {
    const uuidIds = agentPosterIds.filter((x) => UUID_RE.test(x));
    const nameIds = agentPosterIds.filter((x) => !UUID_RE.test(x));

    if (uuidIds.length > 0) {
      const { data: rows } = await db
        .from('repid_agents')
        .select('id, current_repid, tier')
        .in('id', uuidIds);
      for (const r of (rows ?? []) as Array<any>) {
        repidById.set(String(r.id), { current_repid: r.current_repid ?? null, tier: r.tier ?? null });
      }
    }
    if (nameIds.length > 0) {
      const { data: rows } = await db
        .from('repid_agents')
        .select('agent_name, current_repid, tier')
        .in('agent_name', nameIds);
      for (const r of (rows ?? []) as Array<any>) {
        repidByName.set(String(r.agent_name), { current_repid: r.current_repid ?? null, tier: r.tier ?? null });
      }
    }
  }

  const enriched = listings.map((l) => {
    const live = l.poster_type === 'agent'
      ? (repidById.get(String(l.poster_id)) ?? repidByName.get(String(l.poster_id)) ?? null)
      : null;
    const repid = live?.current_repid ?? (typeof l.repid_at_post === 'number' ? l.repid_at_post : null);
    const tier = live?.tier ?? (typeof repid === 'number' ? computeTier(repid) : null);
    return {
      id: l.id,
      kind: l.kind,
      category: l.category,
      title: l.title,
      description: l.description,
      price_usdc: l.price_usdc,
      mode: l.mode,
      rent_period: l.rent_period,
      status: l.status,
      created_at: l.created_at,
      expires_at: l.expires_at,
      poster: {
        type: l.poster_type,
        id: l.poster_id,
        repid,               // live RepID if resolvable, else the at-post snapshot
        tier,                // the trust badge
        repid_at_post: typeof l.repid_at_post === 'number' ? l.repid_at_post : null,
      },
    };
  });

  return res.status(200).json({ listings: enriched, count: enriched.length });
});

export default router;
