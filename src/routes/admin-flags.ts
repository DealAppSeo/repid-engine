import { Router, Request, Response, NextFunction } from 'express';
import { getHalConfig } from '../hal/config';
import { groundingMode } from '../hal/hal-grounding';
import { parseHaltClasses } from '../services/producer-halt';

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
 *
 * Extended to add the "three switches, stacked" SPRINT_BOARD names as the reason
 * peer-verification consensus has never fired even once despite tens of
 * thousands of votes cast: PEER_VERIFY_PANEL_ENABLED, PRODUCER_HALT_CLASSES
 * (parsed, and specifically whether it halts the `peer_verify` class — SPRINT_BOARD
 * called this exact fact UNVERIFIED because Railway env isn't readable from a cloud
 * session), and HAL_CHRONIC_FLAG_ENABLED, the consequence path that promise routes
 * to. Plus MOCK_FACILITATOR, which is three-state ('true'/'false'/unset-is-real) —
 * reporting it as a boolean would misreport the unset-real case as false.
 *
 * Also reports OBSERVABILITY_REQUIRE_AUTH and RESILIENCE_REQUIRE_AUTH, which
 * SPRINT_BOARD's flag audit names and then explicitly refutes as an open door:
 * both routers mount after the global authMiddleware and neither path is in
 * publicPaths, so these gate a redundant SECOND auth layer, not the only one.
 * Still worth reporting — the question "is this on?" was answered by reading
 * source instead of asking the process, which is the pattern this whole route
 * exists to stop.
 *
 * Extended again with the two flags SPRINT_BOARD singles out as the more
 * dangerous default-ON shape ("a default-on gate that nobody knows about is
 * live behaviour nobody chose"), both money/scoring-affecting:
 *
 * - WRITER_DIRECT_APPLY (default true): the D-054/D-055 single-applier cutover
 *   guard read identically at every direct-apply site (repid-earning.ts,
 *   challenge.ts, agents-external.ts, substance-gate-writer.ts). While true,
 *   those sites write current_repid directly (legacy behaviour). Flipping it
 *   false makes repid-sync-aggregator.ts's startRepidSyncWorker() the sole
 *   applier — but that function has zero callers anywhere in src/ today, so
 *   flipping this flag without first starting that worker would silently stop
 *   current_repid from ever being applied. Reported with that fact attached
 *   rather than as a bare boolean, since the boolean alone can't warn of it.
 * - STAKE_DEPOSIT_AUTH_ENFORCED (default true): the fail-closed rollback valve
 *   in stake-authorization.ts guarding real stake deposits. The exported
 *   constant there is computed once at module load, but this endpoint (like
 *   every other field above) needs a live per-request read, so the same
 *   `?? 'true' / !== 'false'` formula is re-evaluated here rather than
 *   importing a value frozen at process start.
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
    peer_verify_panel_enabled: {
      value: (process.env.PEER_VERIFY_PANEL_ENABLED || 'false').toLowerCase() === 'true',
      source: process.env.PEER_VERIFY_PANEL_ENABLED === undefined ? 'default' : 'env',
    },
    hal_chronic_flag_enabled: {
      value: process.env.HAL_CHRONIC_FLAG_ENABLED === 'true',
      source: process.env.HAL_CHRONIC_FLAG_ENABLED === undefined ? 'default' : 'env',
    },
    producer_halt_classes: {
      value: Array.from(parseHaltClasses(process.env.PRODUCER_HALT_CLASSES)),
      peer_verify_halted: (() => {
        const halted = parseHaltClasses(process.env.PRODUCER_HALT_CLASSES);
        return halted.has('all') || halted.has('*') || halted.has('peer_verify');
      })(),
      source: process.env.PRODUCER_HALT_CLASSES === undefined ? 'default' : 'env',
    },
    observability_require_auth: {
      value: process.env.OBSERVABILITY_REQUIRE_AUTH === 'true',
      source: process.env.OBSERVABILITY_REQUIRE_AUTH === undefined ? 'default' : 'env',
    },
    resilience_require_auth: {
      value: process.env.RESILIENCE_REQUIRE_AUTH === 'true',
      source: process.env.RESILIENCE_REQUIRE_AUTH === undefined ? 'default' : 'env',
    },
    writer_direct_apply: {
      value: process.env.WRITER_DIRECT_APPLY !== 'false',
      source: process.env.WRITER_DIRECT_APPLY === undefined ? 'default' : 'env',
      note: 'sole alternate applier is startRepidSyncWorker() (repid-sync-aggregator.ts), which has zero callers in src/ today — flipping this to false without first wiring that worker would silently stop current_repid from ever being applied',
    },
    stake_deposit_auth_enforced: {
      value: (process.env.STAKE_DEPOSIT_AUTH_ENFORCED ?? 'true').toLowerCase() !== 'false',
      source: process.env.STAKE_DEPOSIT_AUTH_ENFORCED === undefined ? 'default' : 'env',
    },
    mock_facilitator: {
      value: process.env.MOCK_FACILITATOR === 'true'
        ? 'true (simulated settlement)'
        : process.env.MOCK_FACILITATOR === 'false'
          ? 'false (settlement disabled, pending_funding)'
          : 'unset (real on-chain settlement path)',
      source: process.env.MOCK_FACILITATOR === undefined ? 'default' : 'env',
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
