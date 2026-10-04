/**
 * V1-9 — a Stripe payment, INERT until Sean turns it on.
 *
 * WHAT IT SELLS. Only what is already in the `stripe_products` catalog (five TrustTrader
 * subscription tiers created in Stripe on 2026-04-08; read-only here). This code never names a
 * product, a price or an amount: the buyer picks a tier id, the server looks up that tier's
 * Stripe price id, and Stripe hosts the payment page. A $0 tier is not sold (there is nothing to
 * pay for), and a tier that is not in the catalog is NOT_CHECKED (404), never a guessed price.
 *
 * INERT TWICE. Both must be set or every call answers 503 `NOT_CONFIGURED` and makes no call:
 *   PAY_CHECKOUT_ENABLED=true   the switch — a Stripe key may already sit on Railway from the
 *                               TrustTrader era, and one variable alone must not turn on money
 *   STRIPE_SECRET_KEY           the key (a restricted key with Checkout Sessions write is enough)
 * plus PAY_RETURN_ORIGIN, the https origin Stripe sends the buyer back to. The success and cancel
 * URLs are built from it here, never taken from the request, so this cannot be an open redirect.
 *
 * WHAT IT WRITES. Nothing. No table, no log row, no reputation event. Fulfilment (a webhook that
 * records a paid subscription) is a separate step and needs a table Sean has not approved; until
 * then a payment is visible in the Stripe dashboard only, and this file says so rather than
 * pretending to track it.
 *
 * WHAT LEAVES. The chosen price id and the return URLs go to api.stripe.com. The buyer's card
 * details never touch this server: Stripe Checkout collects them on Stripe's own page.
 */
import { Router, json, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

export const STRIPE_CHECKOUT_SESSIONS = 'https://api.stripe.com/v1/checkout/sessions';
export const NOT_CONFIGURED = 'NOT_CONFIGURED' as const;
export const NOT_CHECKED = 'NOT_CHECKED' as const;

export interface CatalogTier {
  id: number;
  tier_name: string;
  stripe_price_id: string;
  monthly_price_cents: number;
}

export type CatalogLoader = () => Promise<CatalogTier[] | null>;
// globalThis.Response: the fetch Response, not Express's (imported above under the same name).
type FetchLike = (url: string, init: RequestInit) => Promise<globalThis.Response>;

/** Reads the catalog with the engine's server client. Null on any failure: never an empty catalog that reads as "nothing for sale". */
export const loadCatalog: CatalogLoader = async () => {
  try {
    const { db } = await import('../db.js');
    const { data, error } = await db
      .from('stripe_products')
      .select('id, tier_name, stripe_price_id, monthly_price_cents')
      .order('monthly_price_cents', { ascending: true });
    if (error || !Array.isArray(data)) return null;
    return data as CatalogTier[];
  } catch {
    return null;
  }
};

export interface PayConfig {
  key: string;
  returnOrigin: string;
}

/** Null unless the switch, the key and an https return origin are all present. */
export function payConfig(env: NodeJS.ProcessEnv = process.env): PayConfig | null {
  if ((env.PAY_CHECKOUT_ENABLED ?? '').trim().toLowerCase() !== 'true') return null;
  const key = (env.STRIPE_SECRET_KEY ?? '').trim();
  if (!key) return null;
  let origin: string;
  try {
    const u = new URL((env.PAY_RETURN_ORIGIN ?? '').trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    origin = u.origin;
  } catch {
    return null;
  }
  return { key, returnOrigin: origin };
}

/** Public view of a tier: no Stripe ids, priced tiers only. */
export function publicTiers(catalog: CatalogTier[]): { id: number; name: string; monthly_price_cents: number }[] {
  return catalog
    .filter((t) => Number.isInteger(t.monthly_price_cents) && t.monthly_price_cents > 0 && /^price_[A-Za-z0-9]+$/.test(t.stripe_price_id))
    .map((t) => ({ id: t.id, name: t.tier_name, monthly_price_cents: t.monthly_price_cents }));
}

export interface PayRouterOptions {
  env?: NodeJS.ProcessEnv;
  catalog?: CatalogLoader;
  fetchImpl?: FetchLike;
  limit?: number;
}

export function createPayRouter(options: PayRouterOptions = {}): Router {
  const env = options.env ?? process.env;
  const catalog = options.catalog ?? loadCatalog;
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const limiter = rateLimit({
    windowMs: 60_000,
    max: options.limit ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req): string => ipKeyGenerator(req.ip ?? ''),
    message: { error: 'too_many_requests' },
  });
  const router = Router();

  router.get('/pay/tiers', limiter, async (_req: Request, res: Response): Promise<void> => {
    const rows = await catalog();
    if (!rows) {
      res.status(503).json({ status: NOT_CHECKED, reason: 'catalog_unreadable' });
      return;
    }
    res.set('Cache-Control', 'no-store').status(200).json({ enabled: payConfig(env) !== null, tiers: publicTiers(rows) });
  });

  router.post('/pay/checkout', limiter, json({ limit: '4kb' }), async (req: Request, res: Response): Promise<void> => {
    const config = payConfig(env);
    if (!config) {
      res.status(503).json({ status: NOT_CONFIGURED });
      return;
    }
    const tierId = (req.body as { tier_id?: unknown } | undefined)?.tier_id;
    if (typeof tierId !== 'number' || !Number.isInteger(tierId) || tierId <= 0) {
      res.status(400).json({ error: 'tier_id must be a positive integer' });
      return;
    }
    const rows = await catalog();
    if (!rows) {
      res.status(503).json({ status: NOT_CHECKED, reason: 'catalog_unreadable' });
      return;
    }
    const tier = rows.find((t) => t.id === tierId);
    if (!tier || !publicTiers([tier]).length) {
      res.status(404).json({ tier_id: tierId, status: NOT_CHECKED });
      return;
    }
    const form = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': tier.stripe_price_id,
      'line_items[0][quantity]': '1',
      success_url: `${config.returnOrigin}/pay/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.returnOrigin}/pay/cancelled`,
    });
    try {
      const r = await fetchImpl(STRIPE_CHECKOUT_SESSIONS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await r.json().catch(() => null)) as { url?: unknown } | null;
      if (!r.ok || !body || typeof body.url !== 'string' || !body.url.startsWith('https://checkout.stripe.com/')) {
        // Stripe's error body can name the key's mode or account; none of it is echoed.
        res.status(502).json({ status: NOT_CHECKED, reason: 'checkout_unavailable' });
        return;
      }
      res.status(200).json({ url: body.url });
    } catch {
      res.status(502).json({ status: NOT_CHECKED, reason: 'checkout_unavailable' });
    }
  });

  return router;
}

export default createPayRouter();
