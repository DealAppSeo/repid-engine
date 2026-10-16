import { ServiceHandlerBase } from './service-handler-base';
import { runPCP } from './pcp-validator';
import { runAdversarialJudge } from './adversarial-judge';
import { checkPythagoreanComma } from '../hal/cross-llm-client';
import type { ServiceContractRow } from '../types';

/**
 * Phase 2.10 — Cross-Validation Service Handler (P-003)
 *
 * The cleanest commercial reduction-to-practice surface for P-003 (Pythagorean
 * Comma BFT veto). Every successful fulfilment is audit evidence — the
 * `patent_marker: 'P-003'` field is the queryable trail and MUST NOT be removed.
 *
 * Verified signatures (Step 0):
 *  - runPCP(taskData{claimed_by,title,description,result}) → {score, confidence, validators:string[]}
 *  - runAdversarialJudge(taskData{title,description,result,metadata.provider}) → {verdict, confidence, critique}
 *  - checkPythagoreanComma(beliefs:number[]) → {severity, comma_gap, comma_veto}  (≥3 beliefs required)
 *
 * Decision 5 (insufficient-validators defense): when PCP returns < 3 validators
 * (e.g. LLM keys degraded → empty pool), the comma layer is skipped entirely
 * and the verdict is derived from PCP + judge only.
 */
export class CrossValidationServiceHandler extends ServiceHandlerBase {
  protected readonly serviceType = 'cross_validation';

  protected async fulfill(contract: ServiceContractRow): Promise<Record<string, unknown>> {
    const payload = contract.payload as {
      content: string;
      claimer_provider?: string;
      criteria?: string[];
      title?: string;
    };

    // Step A — PCP validation (synthetic taskData per verified runPCP signature)
    const syntheticTask = {
      id: -1 as const,
      claimed_by: contract.buyer_agent_id,
      title: payload.title ?? 'cross-validation-service-request',
      description: payload.criteria?.join(', ') ?? 'cross-validate content',
      result: payload.content,
      tier: 0,
      metadata: {} as Record<string, unknown>,
    };
    // contract_id + counterparties feed only VALIDATOR_POOL_INTEGRITY (pcp-validator.ts); the judge
    // below still receives syntheticTask unchanged.
    const pcpResult = await runPCP({ ...syntheticTask, contract_id: contract.id, counterparties: [contract.provider_agent_id] });

    // Flag ON only: too few independent validators is no assessment. Below it would score as
    // confidence 0 → FAIL → dispute, blaming the provider for a pool we could not staff. UNDETERMINED
    // is filed as delivered, unpaid (verdict.ts), and the marker withholds SERVICE_FULFILLED deltas.
    if (pcpResult.reason === 'insufficient_independent_validators') {
      return {
        verdict: 'UNDETERMINED',
        validator_pool: 'insufficient_independent_validators',
        pcp_score: pcpResult.score,
        pcp_confidence: pcpResult.confidence,
        pcp_validators: pcpResult.validators,
        contract_id: contract.id,
        verified_at: new Date().toISOString(),
        patent_marker: 'P-003', // AUDIT EVIDENCE TAG — DO NOT REMOVE (column name, not a claim)
      };
    }

    // Step B — Adversarial judge with cross-LLM diversity (Decision 2:
    // synthetic taskData carrying metadata.provider = claimer_provider; the
    // judge reads taskData.{title,description,result,metadata.provider})
    const judgeSyntheticTask = {
      ...syntheticTask,
      metadata: {
        ...syntheticTask.metadata,
        provider: payload.claimer_provider,
      },
    };
    const judgeResult = await runAdversarialJudge(judgeSyntheticTask);

    // Step C — Pythagorean Comma BFT veto (Decision 3 field names;
    // Decision 5 insufficient-validators defense)
    let comma_veto: boolean | null;
    let comma_gap: number | null;
    let comma_severity: string;
    let comma_layer_inactive = false;
    const validatorCount = pcpResult.validators.length;

    if (validatorCount < 3) {
      comma_veto = null;
      comma_gap = null;
      comma_severity = 'insufficient_validators';
      comma_layer_inactive = true;
    } else {
      // v1 beliefs adapter: extract authentic per-validator beliefs returned
      // by the modified PCP layer to enable proper Pythagorean gap calculation.
      const beliefs = pcpResult.validatorBeliefs ?? pcpResult.validators.map(() => pcpResult.confidence);
      const commaResult = checkPythagoreanComma(beliefs);
      comma_veto = commaResult.comma_veto;
      comma_gap = commaResult.comma_gap;
      comma_severity = commaResult.severity;
    }

    // Composite verdict. VETO only when the comma layer is active and fired.
    // PASS must mean the content was judged TRUE (src/services/verdict.ts), so the validators'
    // own validity (pcp_score) must agree too: confident validators with score < 0.5 judged it
    // FALSE, and a judge APPROVE does not turn that into a PASS. [V prod 2026-10-15: 0 of the 2
    // P-003 PASS rows had pcp_score < 0.5; the service has written nothing since 2026-05-28.]
    // FAIL here still means "did not pass cross-validation" (unsure OR judged false) and still
    // routes to dispute: this handler does not emit `confident`, so its FAIL is read as before.
    const verdict =
      comma_veto === true
        ? 'VETO'
        : pcpResult.confidence >= 0.5 && pcpResult.score >= 0.5 && judgeResult.verdict === 'APPROVE'
        ? 'PASS'
        : 'FAIL';

    return {
      verdict,
      pcp_score: pcpResult.score,
      pcp_confidence: pcpResult.confidence,
      pcp_validators: pcpResult.validators,
      judge_verdict: judgeResult.verdict,
      judge_confidence: judgeResult.confidence,
      judge_critique: judgeResult.critique,
      judge_provider: judgeResult.judge_provider,
      judge_attempts: judgeResult.judge_attempts,
      comma_veto,
      comma_gap,
      comma_severity,
      contract_id: contract.id,
      verified_at: new Date().toISOString(),
      patent_marker: 'P-003', // AUDIT EVIDENCE TAG — DO NOT REMOVE (column name, not a claim)
      ...(comma_layer_inactive
        ? {
            metadata: {
              comma_layer_inactive: true,
              reason: 'insufficient_validators',
              validator_count: validatorCount,
            },
          }
        : {}),
    };
  }
}
