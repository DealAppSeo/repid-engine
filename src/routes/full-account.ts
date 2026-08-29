/**
 * Full-account router — humans with a full account.
 *
 * ⚠ THE PASSWORD PATH IS RETIRED. `POST /builder/full-signup` and
 * `POST /builder/login` return 410 and create nothing. They are kept as
 * explicit refusals rather than deleted so a caller still pointed at them gets
 * told where to go instead of a bare 404.
 *
 * WHY. Signup created an account from an UNVERIFIED email address and started
 * it at the AUTONOMOUS tier floor, on a route mounted before authMiddleware —
 * so one keyless request minted a high-authority account, and ownership of the
 * address was asserted rather than proven. Measured against production
 * 2026-08-29: an empty body returned 400 (a validation error), not 401, which
 * is what established the route was reachable without a credential.
 *
 * The email-OTP path (`src/services/gate-account.ts`) proves the address with a
 * code the holder must read, and it already exists. It is now the only way in;
 * `signup-posture.ts` reports whether that door is actually open, because
 * closing one door while the other is misconfigured is how a signup funnel
 * silently stops existing.
 *
 * The starting score is deliberately NOT changed here. What a signup is worth
 * is an economic decision and does not belong in a route change.
 *
 * Mounted BEFORE the body-level SQL-keyword sanitizer in src/index.ts
 * because passwords and trade rationales can legitimately contain ';',
 * 'INSERT', 'UPDATE', etc. The router does its own per-field validation:
 *   - email format     (validateEmail)
 *   - password length  (validatePassword)
 *   - agent_name regex (NAME_RE in agent-creation.ts)
 *   - rationale capped at 500 chars
 *
 * Auth model: signup + login are public. Everything else requires
 * `Authorization: Bearer <login_token>` enforced by requireFullAccount.
 *
 * Endpoints (under /api/v1):
 *   POST   /builder/full-signup   → 410 (retired)
 *   POST   /builder/login         → 410 (retired)
 *   POST   /builder/mint-erc7231
 *   POST   /builder/create-agent
 *   POST   /builder/link-trading-account
 *   POST   /builder/set-notification-pref
 *   POST   /builder/resolve-paper-trades
 *   POST   /agent/execute-paper-trade
 *   GET    /builder/dashboard/:builder_id
 */

import { Router, Request, Response } from 'express';
import { logSignupPostureOnce } from '../services/signup-posture';
import { requireFullAccount, getFullAccountContext } from '../middleware/full-account-auth';
import { mintErc7231ForBuilder } from '../services/erc7231-mint';
import { createBuilderAgent } from '../services/agent-creation';
import { linkTradingAccount } from '../services/link-trading-account';
import { executePaperTrade } from '../services/paper-trade-execution';
import { resolveOpenPaperTrades } from '../services/paper-trade-resolver';
import { setBuilderNotificationPref, NotificationChannel } from '../services/notification-dispatcher';
import { getBuilderDashboard } from '../services/builder-dashboard';

const router = Router();

// --- Retired: the password path -------------------------------------------
//
// 410 GONE, not 404: the route existed, it is deliberately withdrawn, and a
// caller deserves to be told which path replaced it. Both handlers are
// synchronous and touch nothing — no lookup, no write, no timing difference
// between a known and an unknown address.
//
// Nobody is locked out by this. Measured 2026-08-29: no builder in production
// holds a password hash, so login could not have authenticated anyone, and
// signup was the only thing keeping the code path alive.

const PASSWORD_PATH_RETIRED = {
  ok: false as const,
  error: 'password_signup_retired',
  detail:
    'The email + password path is closed. Verify an email address with a one-time code instead — that proves you control the address, which a password does not.',
  use_instead: 'POST /api/v1/agent-gate/request-otp, then POST /api/v1/agent-gate/verify-otp',
};

router.post('/builder/full-signup', (_req: Request, res: Response) => {
  logSignupPostureOnce();
  return res.status(410).json(PASSWORD_PATH_RETIRED);
});

router.post('/builder/login', (_req: Request, res: Response) => {
  logSignupPostureOnce();
  return res.status(410).json(PASSWORD_PATH_RETIRED);
});

// --- Authenticated: every route below requires login_token ----------------

router.post('/builder/mint-erc7231', requireFullAccount, async (req: Request, res: Response) => {
  const ctx = getFullAccountContext(req);
  if (!ctx) return res.status(401).json({ error: 'auth context missing' });
  const r = await mintErc7231ForBuilder(ctx.builder_id);
  if (!r.ok) return res.status(400).json(r);
  return res.json(r);
});

router.post('/builder/create-agent', requireFullAccount, async (req: Request, res: Response) => {
  const ctx = getFullAccountContext(req);
  if (!ctx) return res.status(401).json({ error: 'auth context missing' });
  const { agent_name, agent_role } = req.body ?? {};
  const r = await createBuilderAgent({
    builderId: ctx.builder_id,
    agentName: String(agent_name ?? ''),
    agentRole: agent_role ? String(agent_role) : undefined,
  });
  if (!r.ok) return res.status(400).json(r);
  return res.json(r);
});

router.post('/builder/link-trading-account', requireFullAccount, async (req: Request, res: Response) => {
  const ctx = getFullAccountContext(req);
  if (!ctx) return res.status(401).json({ error: 'auth context missing' });
  const { provider, api_key, secret_key } = req.body ?? {};
  const r = await linkTradingAccount({
    builderId: ctx.builder_id,
    provider,
    api_key: String(api_key ?? ''),
    secret_key: String(secret_key ?? ''),
  });
  if (!r.ok) {
    if (r.mcp_not_implemented) return res.status(501).json(r);
    return res.status(400).json(r);
  }
  return res.json(r);
});

router.post('/builder/set-notification-pref', requireFullAccount, async (req: Request, res: Response) => {
  const ctx = getFullAccountContext(req);
  if (!ctx) return res.status(401).json({ error: 'auth context missing' });
  const { channel, destination } = req.body ?? {};
  const r = await setBuilderNotificationPref(ctx.builder_id, channel as NotificationChannel, String(destination ?? ''));
  if (!r.ok) return res.status(400).json(r);
  return res.json(r);
});

router.post('/builder/resolve-paper-trades', requireFullAccount, async (req: Request, res: Response) => {
  const limit = Number(req.body?.limit) || undefined;
  const force = !!req.body?.force;
  const r = await resolveOpenPaperTrades({ limit, force });
  return res.json(r);
});

router.post('/agent/execute-paper-trade', requireFullAccount, async (req: Request, res: Response) => {
  const ctx = getFullAccountContext(req);
  if (!ctx) return res.status(401).json({ error: 'auth context missing' });
  const { agent_id, symbol, qty, side, rationale, type, limit_price } = req.body ?? {};
  if (!agent_id || !symbol || !qty || !side) {
    return res.status(400).json({ error: 'agent_id, symbol, qty, side required' });
  }
  if (side !== 'buy' && side !== 'sell') {
    return res.status(400).json({ error: 'side must be buy or sell' });
  }
  const r = await executePaperTrade({
    builderId: ctx.builder_id,
    agentId: String(agent_id),
    symbol: String(symbol).toUpperCase(),
    qty: Number(qty),
    side,
    rationale: rationale ? String(rationale) : undefined,
    type: type === 'limit' ? 'limit' : 'market',
    limit_price: limit_price !== undefined ? Number(limit_price) : undefined,
  });
  if (!r.ok) {
    if (r.mcp_not_implemented) return res.status(501).json(r);
    return res.status(400).json(r);
  }
  return res.json(r);
});

router.get('/builder/dashboard/:builder_id', requireFullAccount, async (req: Request, res: Response) => {
  const ctx = getFullAccountContext(req);
  if (!ctx) return res.status(401).json({ error: 'auth context missing' });
  const requested = String(req.params.builder_id ?? '');
  if (requested !== ctx.builder_id) {
    return res.status(403).json({ error: 'cannot view another builder\'s dashboard' });
  }
  const r = await getBuilderDashboard(requested);
  if (!r) return res.status(404).json({ error: 'builder not found' });
  return res.json(r);
});

export default router;
