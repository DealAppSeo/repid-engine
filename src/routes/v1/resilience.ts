/**
 * resilience.ts — the ANFIS intake/observability surface (SPRINT_CC_EGRESS_AND_RESILIENCE.md B0 + B5).
 *
 *   GET  /api/v1/resilience/health  → the array of SurfaceHealth for all four CC surfaces (db/rpc/llm/x402).
 *                                     This is the surface GA's ANFIS sprint INGESTS. Read-only, no auth
 *                                     change (mirrors the observability router's auth-if-enabled pattern).
 *   POST /api/v1/resilience/route   → stores the latest RoutingDecision per surface; each wrapper reads it
 *                                     at call time. The clean interface the GA ANFIS sprint DRIVES.
 *
 * Actuation gate: wrappers only ACT on a stored decision when that surface's enable flag is ON
 * (RESILIENCE_ANFIS_ENABLE_<SURFACE>, default OFF for all). With every flag OFF (the default), POSTed
 * decisions are stored + visible but IGNORED by the wrappers — pure shadow/observe. Wrapper health is
 * always the safety floor: a decision pointing at a hard-down endpoint is never honored (B5 fail-safe,
 * enforced inside each wrapper via isEndpointHardDown).
 */
import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth';
import {
  getAllHealth,
  getAllRoutingDecisions,
  setRoutingDecision,
} from '../../resilience/health-bus';
import { rpcHealth } from '../../clients/rpc-with-failover';
import { llmHealth } from '../../providers/resilient-llm';
import { x402Health } from '../../services/x402-resilient';
import { isSurfaceEnabled } from '../../resilience/decision-contract';
import type { RoutingDecision } from '../../resilience/types';

const router = Router();

// Health is read-only; gate behind auth only if explicitly enabled (matches observability router).
const requireAuthIfEnabled =
  process.env.RESILIENCE_REQUIRE_AUTH === 'true'
    ? authMiddleware
    : (_req: any, _res: any, next: any) => next();

// The POST /route intake is always auth-gated (ANFIS service key) — it influences live routing.
router.get('/resilience/health', requireAuthIfEnabled, (_req, res) => {
  try {
    // The bus holds whatever wrappers have published so far; we also pull each wrapper's current
    // snapshot so a surface that hasn't been called yet still reports its configured endpoints.
    const fromBus = getAllHealth();
    const busKeys = new Set(fromBus.map((h) => `${h.surface}::${h.endpoint}`));
    const live = [...rpcHealth(), ...llmHealth(), ...x402Health()].filter(
      (h) => !busKeys.has(`${h.surface}::${h.endpoint}`)
    );
    const surfaces = [...fromBus, ...live];

    res.json({
      data: {
        surfaces,
        decisions: getAllRoutingDecisions(),
        enabled: {
          db: isSurfaceEnabled('db_read') || isSurfaceEnabled('db_write'),
          rpc: isSurfaceEnabled('rpc'),
          llm: isSurfaceEnabled('llm'),
          x402: isSurfaceEnabled('payments'),
        },
      },
      generated_at: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to read resilience health' } });
  }
});

const VALID_SURFACES = new Set(['db', 'rpc', 'llm', 'x402']);

router.post('/resilience/route', authMiddleware, (req, res) => {
  try {
    const { surface, decision } = req.body ?? {};
    if (typeof surface !== 'string' || !VALID_SURFACES.has(surface)) {
      return res.status(400).json({
        error: { code: 'BAD_REQUEST', message: `surface must be one of ${[...VALID_SURFACES].join(', ')}` },
      });
    }
    if (!decision || typeof decision !== 'object') {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'decision object required' } });
    }

    // Whitelist the RoutingDecision fields (ignore anything else a caller sends).
    const stored: RoutingDecision = {};
    if (typeof decision.preferredEndpoint === 'string') stored.preferredEndpoint = decision.preferredEndpoint;
    if (typeof decision.forceFallback === 'boolean') stored.forceFallback = decision.forceFallback;
    if (typeof decision.tripUntil === 'number') stored.tripUntil = decision.tripUntil;

    setRoutingDecision(surface, stored);

    // Map the surface name to the decision-contract enable flag so the caller knows if it will ACT.
    const surfaceEnabled =
      surface === 'db'
        ? isSurfaceEnabled('db_read') || isSurfaceEnabled('db_write')
        : surface === 'x402'
          ? isSurfaceEnabled('payments')
          : isSurfaceEnabled(surface as any);

    res.json({
      data: { surface, stored, willActuate: surfaceEnabled },
      note: surfaceEnabled
        ? 'Surface enabled — wrappers will honor this preference (subject to the wrapper-health floor).'
        : 'Surface in shadow (enable flag OFF) — decision stored and visible but IGNORED by wrappers.',
      generated_at: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to store routing decision' } });
  }
});

export default router;
