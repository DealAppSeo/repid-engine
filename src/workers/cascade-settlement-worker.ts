/**
 * Cascade Settlement Worker — drains escrowed service_contracts server-side.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The inline Cascade Pickup Worker (src/index.ts) advances contracts
 * pending -> escrowed. But the SECOND hop, escrowed -> fulfilled, was only
 * ever driven by:
 *   - ConstitutionalAgentV4.runLoop (frozen; gated behind ESCALATION_CONTRACT)
 *   - the HTTP endpoint POST /api/v1/agent/process-contracts (needs an external
 *     caller passing an agent id every cycle)
 * With the agent loop frozen and no server-side driver, escrowed contracts pile
 * up indefinitely. This worker is the missing server-side driver: it polls
 * escrowed contracts and runs the EXISTING, verified service handlers'
 * processOne() — claim -> fulfil -> escrowed→fulfilled (or →disputed on
 * VETO/FAIL) -> SERVICE_FULFILLED deltas. It changes NO verification semantics
 * and touches NO ConstitutionalAgentV4 / agent.ts code; it only restores the
 * missing call site.
 *
 * SAFETY / CONTROL
 * ----------------
 *   - Disabled by default. Set CASCADE_SETTLEMENT_ENABLED=true to activate.
 *     This worker is economically active (drives RepID deltas via
 *     applyServiceFulfilledDeltas), so it ships OFF and is enabled deliberately,
 *     mirroring the DisputeResolutionWorker (DISPUTE_WORKER_ENABLED) precedent.
 *   - Per-cycle cap (CASCADE_SETTLEMENT_MAX_PER_CYCLE, default 20) bounds work
 *     per tick so a large backlog drains gradually rather than in one burst.
 *   - processOne() is internally try/caught and never throws (a failed contract
 *     stays escrowed with an error trail), so one bad contract cannot stall the
 *     loop. The poll itself is wrapped; errors are logged loud (Phase 2.9.4).
 */

import { db } from '../db';
import { VerificationServiceHandler } from '../services/verification-service-handler';
import { CrossValidationServiceHandler } from '../services/cross-validation-service-handler';
import { AnfisRoutingServiceHandler } from '../services/anfis-routing-service-handler';

const POLL_MS = parseInt(process.env.CASCADE_SETTLEMENT_POLL_MS ?? '60000', 10);
const MAX_PER_CYCLE = parseInt(process.env.CASCADE_SETTLEMENT_MAX_PER_CYCLE ?? '20', 10);

export class CascadeSettlementWorker {
  // Same handler set the production HTTP driver (routes/v1/agent.ts) instantiates.
  // Each processOne() filters to its own service_type, so running all three per
  // provider covers every escrowed contract that provider owns.
  private readonly handlers = [
    new VerificationServiceHandler(),
    new CrossValidationServiceHandler(),
    new AnfisRoutingServiceHandler(),
  ];
  private timer: NodeJS.Timeout | null = null;

  async runOnce(): Promise<{ processed: number }> {
    let processed = 0;
    try {
      // Find providers that currently own escrowed contracts. Bounded select;
      // we only need the distinct provider ids to drive the handler poll.
      const { data: rows, error } = await db
        .from('service_contracts')
        .select('provider_agent_id')
        .eq('status', 'escrowed')
        .order('created_at', { ascending: true })
        .limit(200);

      if (error) {
        console.error(
          '[cascade-settlement] poll failed:',
          error?.message ?? error,
          (error as any)?.stack ?? new Error().stack
        );
        return { processed };
      }
      if (!rows || rows.length === 0) return { processed };

      const providers = Array.from(
        new Set((rows as any[]).map((r) => r.provider_agent_id).filter(Boolean))
      ) as string[];

      for (const providerId of providers) {
        for (const handler of this.handlers) {
          // Drain this provider+service_type FIFO until empty or the cap is hit.
          while (processed < MAX_PER_CYCLE) {
            const res = await handler.processOne(providerId);
            if (!res.processed) break; // nothing left for this handler/provider
            processed++;
            console.log(
              `[cascade-settlement] drained contract ${res.contract_id} (provider=${providerId})`
            );
          }
          if (processed >= MAX_PER_CYCLE) break;
        }
        if (processed >= MAX_PER_CYCLE) break;
      }

      if (processed > 0) {
        console.log(`[cascade-settlement] cycle drained ${processed} escrowed contract(s)`);
      }
    } catch (e: any) {
      // Loud per Phase 2.9.4 — never silent-swallow.
      console.error(
        '[cascade-settlement] unhandled error:',
        e?.message ?? String(e),
        e?.stack ?? new Error().stack
      );
    }
    return { processed };
  }

  start(intervalMs: number = POLL_MS): void {
    if (process.env.CASCADE_SETTLEMENT_ENABLED !== 'true') {
      console.log(
        '[cascade-settlement] disabled — set CASCADE_SETTLEMENT_ENABLED=true to drain ' +
          'escrowed→fulfilled server-side.'
      );
      return;
    }
    console.log(
      `[cascade-settlement] starting (interval=${intervalMs}ms, max_per_cycle=${MAX_PER_CYCLE})`
    );
    // Initial run immediately, then on the interval. Both are .catch-guarded so
    // an unexpected rejection cannot crash the process (RULE-8 spirit).
    this.runOnce().catch((e) =>
      console.error('[cascade-settlement] initial run error:', e?.message ?? e, e?.stack)
    );
    this.timer = setInterval(() => {
      this.runOnce().catch((e) =>
        console.error('[cascade-settlement] cycle error:', e?.message ?? e, e?.stack)
      );
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const cascadeSettlementWorker = new CascadeSettlementWorker();
