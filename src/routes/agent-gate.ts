/**
 * TrustShell agent-gate routes (T0.5 commitment tier).
 *
 *   POST /api/v1/agent-gate/request-otp  {email}         → {ok} | error
 *   POST /api/v1/agent-gate/verify-otp   {email, code}   → {ok, token}
 *   GET  /api/v1/agent-gate/status                        → {enabled, verified, remaining, limit}
 *
 * See src/services/email-otp.ts for the design rationale. The status
 * endpoint lets the frontend show "N free runs left" without consuming one.
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { requestOtp, verifyOtp, peekRuns, gateEnabled } from '../services/email-otp';

export const agentGateRouter = Router();

const otpLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests' },
});

function callerIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
}

agentGateRouter.post('/v1/agent-gate/request-otp', otpLimiter, async (req: Request, res: Response): Promise<void> => {
  const result = await requestOtp(req.body?.email, callerIp(req));
  if (!result.ok) {
    const status = result.error === 'email_disabled' ? 503 : result.error === 'too_many_requests' ? 429 : 400;
    res.status(status).json(result);
    return;
  }
  res.json({ ok: true });
});

agentGateRouter.post('/v1/agent-gate/verify-otp', otpLimiter, async (req: Request, res: Response): Promise<void> => {
  const result = await verifyOtp(req.body?.email, req.body?.code);
  if (!result.ok) {
    const status = result.error === 'server_config' ? 503 : 400;
    res.status(status).json(result);
    return;
  }
  // login_token / builder_* appear only when GATE_PROVISIONS_ACCOUNT is on, so a
  // client can treat "I got an account" as feature-detection rather than needing
  // to know the deployment's flags.
  res.json({
    ok: true,
    token: result.token,
    ...(result.login_token
      ? {
          login_token: result.login_token,
          builder_id: result.builder_id,
          builder_address: result.builder_address,
          account_created: result.account_created,
        }
      : {}),
  });
});

agentGateRouter.get('/v1/agent-gate/status', (req: Request, res: Response): void => {
  const meter = peekRuns(callerIp(req), req.headers['x-agent-gate-token']);
  res.json({ enabled: gateEnabled(), verified: meter.verified, remaining: meter.remaining, limit: meter.limit });
});
