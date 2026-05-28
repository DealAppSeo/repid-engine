import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { VerificationServiceHandler } from '../../services/verification-service-handler';
import { CrossValidationServiceHandler } from '../../services/cross-validation-service-handler';
import { AnfisRoutingServiceHandler } from '../../services/anfis-routing-service-handler';
import { ReputationAuditServiceHandler } from '../../services/reputation-audit-service-handler';
import { StorageServiceHandler } from '../../services/storage-service-handler';
import { FactCheckServiceHandler } from '../../services/fact-check-service-handler';

/**
 * Phase 2.10 — Option A cross-repo integration (mirrors the Phase 2.8
 * substance-gate-client pattern). trinity-symphony-shared's main loop POSTs
 * { agent_name } (agents only know their trinity-* name, not their UUID);
 * this endpoint resolves it to repid_agents.id server-side (same approach as
 * substance-gate-writer.getAgentUuid), then runs handlers — one contract
 * processed per cycle.
 */
const router = Router();

router.post('/agent/process-contracts', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  let agentId: string | undefined = body.agent_id;
  const agentName: string | undefined = body.agent_name;

  if (!agentId && !agentName) {
    return res.status(400).json({ error: 'agent_id or agent_name required' });
  }

  try {
    if (!agentId && agentName) {
      const { data, error } = await db
        .from('repid_agents')
        .select('id')
        .eq('agent_name', agentName)
        .maybeSingle();
      if (error) {
        console.error(
          `[agent/process-contracts] agent lookup error for ${agentName}:`,
          error?.message ?? error,
          (error as any)?.stack ?? new Error().stack
        );
        return res.status(500).json({ processed: false, error: 'agent lookup failed' });
      }
      if (!data) {
        return res.status(404).json({ processed: false, error: `unknown agent_name: ${agentName}` });
      }
      agentId = (data as any).id as string;
    }

    const handlers = [
      new VerificationServiceHandler(),
      new CrossValidationServiceHandler(),
      new AnfisRoutingServiceHandler(),
      new ReputationAuditServiceHandler(),
      new StorageServiceHandler(),
      new FactCheckServiceHandler(),
    ];

    for (const handler of handlers) {
      const result = await handler.processOne(agentId as string);
      if (result.processed) {
        return res.json({ processed: true, contract_id: result.contract_id });
      }
      if (result.error) {
        return res.json({ processed: false, error: result.error });
      }
    }
    return res.json({ processed: false });
  } catch (e: any) {
    // Loud error logging (Phase 2.9.4) — endpoint must never silently swallow.
    console.error(
      `[agent/process-contracts] unhandled error (agent=${agentName ?? agentId}):`,
      e?.message ?? String(e),
      e?.stack ?? new Error().stack
    );
    return res.status(500).json({ processed: false, error: 'internal error' });
  }
});

export default router;
