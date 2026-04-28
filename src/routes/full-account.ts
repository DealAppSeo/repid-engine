/**
 * Full-account router — humans signing up with email + password.
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
 *   POST   /builder/full-signup
 *   POST   /builder/login
 *   POST   /builder/mint-erc7231
 *   POST   /builder/create-agent
 *   POST   /builder/link-trading-account
 *   POST   /builder/set-notification-pref
 *   POST   /builder/resolve-paper-trades
 *   POST   /agent/execute-paper-trade
 *   GET    /builder/dashboard/:builder_id
 */

import { Router, Request, Response } from 'express';
import { createFullBuilder, verifyPassword } from '../services/full-account-signup';
import { issueLoginToken } from '../services/full-account-token';
import { requireFullAccount, getFullAccountContext } from '../middleware/full-account-auth';
import { mintErc7231ForBuilder } from '../services/erc7231-mint';
import { createBuilderAgent } from '../services/agent-creation';
import { linkTradingAccount } from '../services/link-trading-account';
import { executePaperTrade } from '../services/paper-trade-execution';
import { resolveOpenPaperTrades } from '../services/paper-trade-resolver';
import { setBuilderNotificationPref, NotificationChannel } from '../services/notification-dispatcher';
import { getBuilderDashboard } from '../services/builder-dashboard';

const router = Router();

// --- Public: signup + login -----------------------------------------------

router.post('/builder/full-signup', async (req: Request, res: Response) => {
  const { email, password, walletAddress } = req.body ?? {};
  const r = await createFullBuilder({ email, password, walletAddress });
  if (!r.ok) return res.status(400).json(r);
  return res.json(r);
});

router.post('/builder/login', async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  const r = await verifyPassword(email, password);
  if (!r.ok) return res.status(401).json({ ok: false, error: r.error ?? 'invalid credentials' });
  const token = issueLoginToken(r.builder_id!, email);
  return res.json({ ok: true, builder_id: r.builder_id, login_token: token });
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
