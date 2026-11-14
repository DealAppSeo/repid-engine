// src/routes/ops-flags.ts
//
// GET /api/v1/ops/flags: which feature switches this process has on.
//
// Railway's variables are not readable from an agent session, so until now the
// only way to learn whether a switch was on was to ask Sean to open the
// dashboard. This answers from the running process.
//
// WHAT IT REPORTS. Every name in src/ops/flag-registry.ts (a committed list,
// never derived from process.env). For each:
//   * the HAL keys src/hal/config.ts resolves (repid_config, then env, then a
//     default): the resolved value from getHalConfig(), on/off or the strictness
//     digit, with source repid_config / env / default. If the repid_config read
//     failed, `unknown`: a row could be overriding env, and repeating the
//     fallback as if it had been read would be a guess.
//   * everything else: the env value through classifyEnvValue(), which echoes
//     only mode words and numbers and reports anything else as `set`. `unset`
//     means the code default applies; this route does not claim to know it.
//
// WHAT IT DOES NOT DO. It does not run each flag's own parser, so a value here
// is what the environment holds, not what the gate makes of it. For the
// money and scoring gates resolved one by one, with notes, see
// GET /api/v1/admin/flags (routes/admin-flags.ts, ADMIN_KEY).
//
// AUTH. Mounted after authMiddleware and on no bypass list, so no key is a 401.
// It also requires an operator key (REPID_API_KEYS tier `ops`, same as
// /observability/x402-metrics): a DB-issued agent key passes authMiddleware, and
// the list says which enforcement switches are off, which no agent needs.

import { Router, Request, Response } from 'express';
import { isOperatorKey } from '../middleware/auth';
import { ALL_KEYS as HAL_KEYS, getHalConfig, type HalConfig, type HalConfigKey } from '../hal/config';
import { classifyEnvValue, FLAG_REGISTRY } from '../ops/flag-registry';
import { DEPLOYED_COMMIT } from './readiness';

export const opsFlagsRouter = Router();

const SOURCE = { db: 'repid_config', env: 'env', default: 'default' } as const;
const isHalKey = (name: string): name is HalConfigKey => (HAL_KEYS as readonly string[]).includes(name);

function halValue(cfg: HalConfig, key: HalConfigKey): string {
  if (key === 'HAL_STRICTNESS') return String(cfg.strictness);
  if (key === 'HAL_DECISION_REQUIRES_QUORUM') return cfg.decisionRequiresQuorum ? 'on' : 'off';
  if (key === 'HAL_PENALTY_REQUIRES_QUORUM') return cfg.penaltyRequiresQuorum ? 'on' : 'off';
  return cfg.providers[key] ? 'on' : 'off';
}

opsFlagsRouter.get('/flags', async (req: Request, res: Response) => {
  if (!isOperatorKey(req)) return res.status(403).json({ error: 'Forbidden: needs an operator key' });

  // getHalConfig never throws today; if that changes, this reports unknown rather than a fallback.
  const cfg = await getHalConfig().catch(() => null);
  const halRead = cfg ? cfg.dbRead : 'failed';

  const flags = FLAG_REGISTRY.map((name) => {
    if (isHalKey(name)) {
      if (!cfg || cfg.dbRead === 'failed') return { name, value: 'unknown', source: 'repid_config' };
      return { name, value: halValue(cfg, name), source: SOURCE[cfg.source[name]] };
    }
    const raw = process.env[name];
    return { name, value: classifyEnvValue(raw), source: raw === undefined ? 'default' : 'env' };
  });

  res.set('Cache-Control', 'no-store');
  return res.json({
    generated_at: new Date().toISOString(),
    deployed_commit: DEPLOYED_COMMIT,
    repid_config_read: halRead,
    flags,
  });
});
