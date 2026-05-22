import { Scenario, ScenarioContext } from '../framework';

/**
 * Scenario 3 — dispute resolution.
 * Full E2E requires: a contract in status='disputed' (only reachable via a
 * VETO/FAIL service fulfilment), DISPUTE_WORKER_ENABLED=true on the deployed
 * engine, and DB read access to confirm the verdict + RepID adjustment. None of
 * those are assertable through the public API, and seeding a disputed contract
 * needs privileged writes + the BFT/judge LLM path. Rather than fake a result,
 * this scenario documents the exact preconditions and skips.
 *
 * Follow-up sprint: add a privileged seed-and-verify path (insert an escrowed
 * contract whose handler returns VETO → assert it routes to
 * dispute_validation_queue → enable dispute worker → assert resolved).
 */
export const disputeResolution: Scenario = {
  name: 'dispute-resolution',
  description: 'Buyer disputes a result; dispute worker resolves; RepID adjusted.',
  async run(_ctx: ScenarioContext) {
    return {
      pass: false,
      skip: true,
      reason:
        'requires a seeded disputed contract + DISPUTE_WORKER_ENABLED + DB read; ' +
        'not orchestratable via the public API in this framework version (documented follow-up)',
    };
  },
};
