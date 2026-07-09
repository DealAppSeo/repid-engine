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
  /**
   * Whether the caller provably CONTROLS this poster_id — i.e. the identity was
   * established server-side (human JWT, DB-issued agent key) or the declared
   * poster_id is explicitly authorized for the presenting env key. Only a
   * verified identity may borrow a RepID/tier trust badge; an unverified poster
   * is accepted but its listing carries NO badge (repid_at_post stays null).
   */
  verified: boolean;
}

/**
 * Parse REPID_API_KEY_POSTER_BINDINGS — a comma-separated allowlist of
 * `key:poster_id` pairs that authorize a specific env API key to post AS a
 * specific identity (so it may inherit that identity's RepID badge). A key may
 * appear multiple times to authorize multiple poster_ids. poster_id is taken as
 * everything after the FIRST colon (agent names/uuids never contain a colon).
 */
function parsePosterBindings(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const raw = process.env.REPID_API_KEY_POSTER_BINDINGS || '';
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    if (idx <= 0) continue;
    const key = entry.slice(0, idx).trim();
    const pid = entry.slice(idx + 1).trim();
    if (!key || !pid) continue;
    if (!map.has(key)) map.set(key, new Set<string>());
    map.get(key)!.add(pid);
  }
  return map;
}

/**
 * Resolve the poster identity from the request's own auth.
 *   - human: a full-account login_token (Authorization: Bearer <token>) →
 *     poster_id = builder_id (identity from the token, never client-spoofable).
 *     Always `verified` (identity is server-side).
 *   - agent, DB-issued key (agent_api_keys): binds an agent_id → poster_id.
 *     Always `verified` (identity is server-side).
 *   - agent, env REPID_API_KEYS key: NOT bound to a single agent, so the caller
 *     declares `poster_id` in the body. `verified` ONLY when that declared
 *     poster_id is explicitly authorized for this key via
 *     REPID_API_KEY_POSTER_BINDINGS — otherwise the listing is accepted but
 *     `verified:false` (no borrowed badge). This closes the impersonation hole
 *     where any env-key holder could declare `poster_id:"SOPHIA"` and inherit a
 *     trusted agent's real RepID badge.
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
      return { poster_type: 'human', poster_id: String(payload.builder_id), verified: true };
    }
  }

  // 2) Agent — API key (Bearer <key> or x-api-key).
  const candidateKey = apiKeyHeader || bearer;
  if (!candidateKey) return null;

  // 2a) env REPID_API_KEYS allowlist (key or key:tier). Unbound identity →
  // the agent must declare which agent it posts as via body.poster_id. The
  // declared identity is trusted (verified) ONLY if the key is explicitly bound
  // to it via REPID_API_KEY_POSTER_BINDINGS; otherwise the poster is unverified
  // (accepted, but no borrowed RepID badge).
  const envKeys = (process.env.REPID_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((k) => k.split(':')[0]);
  if (envKeys.includes(candidateKey)) {
    const declared = typeof req.body?.poster_id === 'string' ? req.body.poster_id.trim() : '';
    if (!declared) return null; // handled as 400 by caller (poster_id required for env keys)
    const allowed = parsePosterBindings().get(candidateKey);
    const verified = !!allowed && allowed.has(declared);
    return { poster_type: 'agent', poster_id: declared, verified };
  }

  // 2b) DB-issued key (hashed, bound to an agent_id).
  try {
    const dbKey = await validateAgentApiKey(candidateKey);
    if (dbKey && dbKey.agent_id) {
      return { poster_type: 'agent', poster_id: String(dbKey.agent_id), verified: true };
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

  // Stamp the poster's current RepID at post time ONLY for a verified identity
  // (agents; null if unresolvable). An unverified poster (env key declaring an
  // identity it is not bound to) NEVER inherits a RepID badge → repid_at_post
  // stays null so /browse cannot surface a borrowed badge for it.
  const repid_at_post = identity.verified
    ? await resolveCurrentRepid(identity.poster_type, identity.poster_id)
    : null;

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
      poster_verified: identity.verified,
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
    poster_verified: identity.verified,
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
    .select('id, poster_type, poster_id, kind, category, title, description, price_usdc, mode, rent_period, status, poster_verified, repid_at_post, created_at, expires_at')
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

  // Enrich AGENT posters with live RepID + tier, but ONLY for VERIFIED posters —
  // a listing whose poster identity was not proven (poster_verified=false) must
  // never surface a borrowed RepID/tier badge. Batch by id and by agent_name
  // (poster_id can be either a uuid or a canonical agent_name).
  const agentPosterIds = Array.from(
    new Set(
      listings
        .filter((l) => l.poster_type === 'agent' && l.poster_id && l.poster_verified === true)
        .map((l) => String(l.poster_id)),
    ),
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
    const verified = l.poster_verified === true;
    // Only a verified poster may carry a trust badge. Unverified → no badge.
    const live = verified && l.poster_type === 'agent'
      ? (repidById.get(String(l.poster_id)) ?? repidByName.get(String(l.poster_id)) ?? null)
      : null;
    const repid = verified
      ? (live?.current_repid ?? (typeof l.repid_at_post === 'number' ? l.repid_at_post : null))
      : null;
    const tier = verified
      ? (live?.tier ?? (typeof repid === 'number' ? computeTier(repid) : null))
      : null;
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
        verified,            // whether the poster's identity was proven
        repid,               // live RepID if verified+resolvable, else at-post snapshot; null if unverified
        tier,                // the trust badge — null unless the poster is verified
        repid_at_post: verified && typeof l.repid_at_post === 'number' ? l.repid_at_post : null,
      },
    };
  });

  return res.status(200).json({ listings: enriched, count: enriched.length });
});

export default router;
