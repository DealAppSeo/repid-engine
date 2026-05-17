import { ServiceHandlerBase } from './service-handler-base';
import { runPCP } from './pcp-validator';
import type { ServiceContractRow } from '../types';

/**
 * Phase 2.10 — Verification Service Handler (P-001)
 *
 * Wraps the existing PCP validator for arbitrary buyer-supplied payloads.
 * runPCP signature (verified Step 0): runPCP(taskData) where taskData reads
 * {claimed_by, title, description, result}; returns
 * {score:number, confidence:number, validators:string[]}.
 * Service contracts report the verdict honestly (no internal escalation —
 * that is the validation_queue path, not the contract path); a low-confidence
 * result is surfaced so the buyer may dispute.
 */
export class VerificationServiceHandler extends ServiceHandlerBase {
  protected readonly serviceType = 'verification';

  protected async fulfill(contract: ServiceContractRow): Promise<Record<string, unknown>> {
    const payload = contract.payload as {
      content: string;
      criteria?: string[];
      title?: string;
    };

    const syntheticTask = {
      id: -1 as const, // sentinel — not a trinity_tasks row
      claimed_by: contract.buyer_agent_id, // excludes buyer from the validator pool
      title: payload.title ?? 'verification-service-request',
      description: payload.criteria?.join(', ') ?? 'verify content accuracy and coherence',
      result: payload.content,
      tier: 0,
    };

    const pcpResult = await runPCP(syntheticTask);

    return {
      verdict: pcpResult.confidence >= 0.5 ? 'PASS' : 'FAIL',
      score: pcpResult.score,
      confidence: pcpResult.confidence,
      validators: pcpResult.validators, // string[] of agent names
      validator_count: pcpResult.validators.length,
      contract_id: contract.id,
      verified_at: new Date().toISOString(),
      patent_marker: 'P-001',
    };
  }
}
