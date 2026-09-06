import { Router, Request, Response, NextFunction } from 'express';
import { getHalConfig } from '../hal/config';
import { groundingMode } from '../hal/hal-grounding';
import { parseHaltClasses } from '../services/producer-halt';
import { parseRetryMode } from '../services/x402-release-retry-worker';

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
 *
 * Extended a third time with two more default-ON scoring gates, this time
 * from src/scoring/pipeline.ts itself:
 *
 * - HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION (default true): gates whether a
 *   negative HAL delta actually drains live current_repid, or is suppressed
 *   as penalty_suppressed telemetry-only. pipeline.ts's own comment states
 *   the failure mode this closed: without the gate, a blind-extractor veto
 *   with no caught hallucination still wrote old_repid-10, pinning agents to
 *   the tier floor while peak_repid sat 2-3x higher.
 * - REPID_PURPOSE_GATE_ENABLED (default true): the base purpose gate — a
 *   distinct flag from REPID_PURPOSE_GATE_V3 above, which is a narrower
 *   tail-domain sub-flag riding the SAME gate (default OFF). This one decides
 *   whether a HAL veto may move RepID at all on non-deliverable surfaces
 *   (cron / DB-fact / adversarial drills / peer-verify). Reported distinctly
 *   from V3 because the name overlap is exactly the kind of thing a source
 *   read catches and a guess does not.
 *
 * Extended a fourth time with X402_RELEASE_RETRY_ENABLED, which is money-path
 * and was the clearest case yet of the defect this route exists to stop.
 *
 * It decides whether x402-release-retry-worker releases held USDC to providers
 * whose work was delivered and accepted. It defaults OFF, and before this entry
 * it appeared in exactly two places in the tree: the worker that reads it, and
 * known-env-vars.generated.ts. So "is the release worker actually running?" was
 * answerable only by opening Railway or reading source and assuming the default.
 * That cost a real wrong answer on 2026-09-05: a contract sitting `fulfilled`
 * and unpaid was diagnosed as "the exact shape the retry worker drains" on the
 * strength of two matching conditions, when the deciding third — a positive
 * buyer_satisfaction_score — did not hold. The flag turned out not to be the
 * cause, but ruling it out required a source dive it should not have.
 *
 * Reported as the RESOLVED mode from parseRetryMode, not the raw string, and
 * three-state like MOCK_FACILITATOR above. `off` is what an unset variable and
 * a misspelt one BOTH resolve to, and those are very different situations for
 * an operator: one is a deliberate default, the other is a flag that silently
 * did nothing. `source` separates them at a glance, and a `note` is attached
 * when the variable is set to something unrecognised.
 *
 * parseRetryMode is IMPORTED rather than re-implemented here, and that is a
 * deliberate trade: it drags the settlement/scoring chain into this route's
 * module graph (harmless in production — src/index.ts already imports the same
 * worker to start it — but it does make this test file load HAL). The
 * alternative, a five-line re-parse, would create two definitions of how this
 * mode resolves. This repo has already paid for that shape once: the HashKey
 * chain id had two sources of truth that could disagree, and unifying them was
 * the fix. A flag endpoint whose answer can drift from the code it describes is
 * worse than useless, because it is trusted.
 *
 * The unrecognised value itself is deliberately NOT echoed. Nothing here ever
 * returns env CONTENT, only resolved state, and a typo is diagnosable from
 * "set but unrecognised" plus Railway; making this the one field that echoes
 * what an env var contains is a habit worth not starting on a money-path flag.
 *
 * Extended a fifth time with ENGINE_WORKERS_ENABLED (default true), a single
 * flag checked at two non-adjacent call sites in src/index.ts that together
 * gate THREE worker starts: feedbackLoopWorker.start(), startTrinityTaskBridge(),
 * and startPeerVerificationReader(db). None of the three were previously
 * visible from outside the process, and turning this one flag off silently
 * stops all three at once with no error — piecing that together from source
 * previously required reading two different places in index.ts. Reported with
 * a note naming the three workers, since the boolean alone can't say what it
 * gates.
 *
 * Extended a sixth time with TRINITY_BRIDGE_ENABLED (default true): the trinity
 * task bridge is not gated by ENGINE_WORKERS_ENABLED alone. src/index.ts only
 * CALLS startTrinityTaskBridge() when ENGINE_WORKERS_ENABLED !== 'false', but
 * the function itself (src/services/trinity-task-bridge.ts) independently
 * checks TRINITY_BRIDGE_ENABLED !== 'false' and returns early if that is false.
 * Both must be true for the bridge to run — a second gate in a different file,
 * with no cross-reference between the two, same name-overlap trap as
 * REPID_PURPOSE_GATE_ENABLED vs REPID_PURPOSE_GATE_V3 above. Reported with a
 * note pointing at engine_workers_enabled so a reader of either field learns
 * about the other.
 *
 * Extended a seventh time with HAL_QUORUM_FAMILY_AWARE (default true): unlike the
 * pair above, this is ONE flag read with the identical `!== 'false'` formula at
 * three non-adjacent call sites with no import relationship between them —
 * src/hal/fact-check.ts, src/services/service-quality-hook.ts, and
 * src/scoring/pipeline.ts. It decides whether HAL quorum is counted by distinct
 * provider family (default — two same-base-model routes count once) or by raw
 * provider count. All three agree today, but they are three separately-maintained
 * copies of the same expression, so nothing stops one from being edited without
 * the other two and producing inconsistent quorum counting with no error raised.
 * Reported with a note naming all three sites so a reader sees the whole set
 * instead of grepping for it.
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
    x402_release_retry: (() => {
      const raw = process.env['X402_RELEASE_RETRY_ENABLED'];
      const value = parseRetryMode(raw);
      const set = raw !== undefined;
      // Set-but-resolves-to-off is only ambiguous for the literal 'off'. Anything
      // else that lands on 'off' was not recognised, and the worker is silently
      // doing nothing while the variable looks configured.
      const unrecognised = set && value === 'off' && (raw ?? '').trim().toLowerCase() !== 'off';
      return {
        value,
        source: set ? 'env' : 'default',
        ...(unrecognised
          ? {
              note:
                'X402_RELEASE_RETRY_ENABLED is set to a value that is not off|shadow|enforce, ' +
                "so it resolved to 'off' and the release worker is doing nothing. The value " +
                'itself is not echoed here — this route reports resolved state, never env content.',
            }
          : {}),
      };
    })(),
    hal_direct_penalty_requires_hallucination: {
      value: process.env.HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION !== 'false',
      source: process.env.HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION === undefined ? 'default' : 'env',
    },
    repid_purpose_gate_enabled: {
      value: process.env.REPID_PURPOSE_GATE_ENABLED !== 'false',
      source: process.env.REPID_PURPOSE_GATE_ENABLED === undefined ? 'default' : 'env',
    },
    engine_workers_enabled: {
      value: process.env.ENGINE_WORKERS_ENABLED !== 'false',
      source: process.env.ENGINE_WORKERS_ENABLED === undefined ? 'default' : 'env',
      note: 'gates three worker starts in src/index.ts: feedbackLoopWorker, startTrinityTaskBridge, startPeerVerificationReader',
    },
    trinity_bridge_enabled: {
      value: process.env.TRINITY_BRIDGE_ENABLED !== 'false',
      source: process.env.TRINITY_BRIDGE_ENABLED === undefined ? 'default' : 'env',
      note: 'second, independent gate on the same worker as engine_workers_enabled: startTrinityTaskBridge() is only called when engine_workers_enabled is true, AND the bridge itself checks this flag before running — both must be true',
    },
    hal_quorum_family_aware: {
      value: process.env.HAL_QUORUM_FAMILY_AWARE !== 'false',
      source: process.env.HAL_QUORUM_FAMILY_AWARE === undefined ? 'default' : 'env',
      note: 'read with the identical formula at three non-adjacent sites: src/hal/fact-check.ts, src/services/service-quality-hook.ts, src/scoring/pipeline.ts — no shared import, so the three can silently diverge if only one is edited',
    },
    hal_strict_family_independence: {
      value: process.env.HAL_STRICT_FAMILY_INDEPENDENCE === 'true',
      source: process.env.HAL_STRICT_FAMILY_INDEPENDENCE === undefined ? 'default' : 'env',
      note: 'boot-time only — decides whether assertFamilyIndependenceAtBoot() (src/hal/fact-check.ts) throws past its caller in src/index.ts on a family-collapse violation, or only logs. The audit runs once at process start, so this value describes what the NEXT boot will do, not anything that happened on this one',
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
