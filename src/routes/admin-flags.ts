import { Router, Request, Response, NextFunction } from 'express';
import { getHalConfig } from '../hal/config';
import { groundingMode } from '../hal/hal-grounding';

export const adminFlagsRouter = Router();

adminFlagsRouter.use((req: Request, res: Response, next: NextFunction) => {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    res.status(503).json({ error: 'Admin not configured' });
    return;
  }
  const reqKey = req.headers['x-admin-key'];
  if (reqKey !== adminKey) {
    res.status(401).json({ error: 'Unauthorized: Invalid admin key' });
    return;
  }
  next();
});

/**
 * Reports resolved state (never just presence) for the subset of this repo's
 * behaviour gates that are Sean-gated or money/scoring-affecting per CLAUDE.md's
 * hard lines and SPRINT_BOARD's flag-observability audit (line 262): 111 real
 * gates exist in src/, only 5 were visible from outside the process before this
 * route, and none of those 5 are money/chain-write/breaker-affecting.
 *
 * Deliberately smaller than "all 111" — that is a larger, separate pass.
 * ENGINE_LLM_PROXY is named in CLAUDE.md's hard lines but is excluded here: it is
 * not read via process.env anywhere in src/ today (grep confirms only a comment
 * in routing-record.ts describes a future flip), so reporting it would publish a
 * switch that does not exist yet.
 */
adminFlagsRouter.get('/', async (req: Request, res: Response) => {
  const halConfig = await getHalConfig().catch(() => null);

  res.json({
    repid_purpose_gate_v3: {
      value: process.env.REPID_PURPOSE_GATE_V3 === 'true',
      source: process.env.REPID_PURPOSE_GATE_V3 === undefined ? 'default' : 'env',
    },
    hal_grounding_mode: {
      value: groundingMode(),
      source: process.env.HAL_GROUNDING_MODE === undefined ? 'default' : 'env',
    },
    constitutional_audit_enabled: {
      value: process.env.CONSTITUTIONAL_AUDIT_ENABLED === 'true',
      source: process.env.CONSTITUTIONAL_AUDIT_ENABLED === undefined ? 'default' : 'env',
    },
    owner_ceiling_shadow_enabled: {
      value: String(process.env['OWNER_CEILING_SHADOW_ENABLED'] ?? '').toLowerCase() === 'true',
      source: process.env['OWNER_CEILING_SHADOW_ENABLED'] === undefined ? 'default' : 'env',
    },
    router_strict_cost_order: {
      value: process.env.ROUTER_STRICT_COST_ORDER !== 'false',
      source: process.env.ROUTER_STRICT_COST_ORDER === undefined ? 'default' : 'env',
    },
    hal_s2: halConfig
      ? {
          strictness: halConfig.strictness,
          decision_requires_quorum: { value: halConfig.decisionRequiresQuorum, source: halConfig.source.HAL_DECISION_REQUIRES_QUORUM },
          penalty_requires_quorum: { value: halConfig.penaltyRequiresQuorum, source: halConfig.source.HAL_PENALTY_REQUIRES_QUORUM },
          providers: Object.fromEntries(
            Object.entries(halConfig.providers).map(([key, value]) => [key, { value, source: halConfig.source[key as keyof typeof halConfig.source] }])
          ),
        }
      : { error: 'UNAVAILABLE', detail: 'getHalConfig() threw; DB/env/default resolution could not be read' },
  });
});
