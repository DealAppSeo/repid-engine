/**
 * ZkpAuditServiceHandler — the A2A marketplace adapter for `zkp-audit-service`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not route failures to `dispute_validation_queue`. Every gate in the
 * service THROWS, `ServiceHandlerBase.processOne` catches, and the contract
 * stays `escrowed` with a loud error trail in `metadata` — no
 * `SERVICE_FULFILLED` deltas, no dispute row, no artifact reaching the buyer.
 *
 * That is a correction to the original design, forced by the adversarial
 * review: the existing FAIL path routes to `DisputeResolutionWorker`, whose LLM
 * panel reads `JSON.stringify(contract.result)` — a 10KB base64 blob — and can
 * return `buyer_at_fault`, which pays the provider +20 and fines the innocent
 * buyer −50. A provider whose proof does not verify would be REWARDED for
 * shipping it. Until the dispute worker calls `verifyDeliverable()` first
 * (see wiring), FAIL must not be expressible on this rail.
 *
 * The handler therefore only ever returns a fully-verified deliverable, which
 * is why `verdict: 'PASS'` on it is a true statement rather than a self-award.
 *
 * ⚠ THIS HANDLER IS NOT THE ONLY DOOR. `POST /api/v1/contracts/:id/fulfill`
 * accepts `{result: <anything>}` on any escrowed contract with no provider
 * check and no handler dispatch, so a provider can bypass every invariant here
 * by posting its own `{verdict:'PASS', proof_bytes:'<garbage>'}`. Closing that
 * requires editing `src/routes/v1/contracts.ts`, which this component may not
 * touch — it is reported as required wiring, not as a solved problem.
 */
import { ServiceHandlerBase } from '../service-handler-base';
import { db } from '../../db';
import {
  createZkpAuditService,
  verifyDeliverable,
  ZKP_AUDIT_SERVICE_TYPE,
  ZkpAuditError,
  type AdmissionPolicy,
  type DeliverableVerification,
  type VerifyFn,
  type VerifyResult,
  type ZkpAuditService,
} from '../zkp-audit-service';
import type { ServiceContractRow } from '../../types';

/**
 * Resolve the external prover base URL. There is intentionally NO default
 * fallback to the in-repo `plonky3-real.ts` / `plonky3-stub.ts` paths: when the
 * URL is absent the service throws PROVER_UNAVAILABLE. Degrade CLOSED.
 */
export function resolveProverUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.ZKP_SERVICE_URL ?? env.PLONKY3_PROVER_URL ?? '').trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Lazily load the published WASM verifier. Kept lazy so importing this handler
 * (e.g. from the route module at boot) never pays the WASM init cost, and so a
 * verifier resolution failure surfaces as SELF_VERIFY_FAILED on one contract
 * rather than crashing process start.
 */
export function createWasmVerifier(): VerifyFn {
  return async (proofBytes: string, statement: Record<string, unknown>): Promise<VerifyResult> => {
    const mod: any = await import('@hyperdag/proof-verifier');
    const result = await mod.verify(proofBytes, statement);
    // The package returns a structured VerifyResult. Anything else is treated as
    // a failure rather than coerced — `!!result` on an object is always true and
    // is exactly how a fake "verified" slips through (that bug exists today at
    // src/routes/v1.ts:147; it is not reproduced here).
    if (!result || typeof result !== 'object' || typeof result.verified !== 'boolean') {
      return {
        verified: false,
        error: 'verifier returned an unexpected shape',
        proof_size_bytes: 0,
        verifier_version: 'unknown',
      };
    }
    return {
      verified: result.verified,
      error: typeof result.error === 'string' ? result.error : null,
      proof_size_bytes: typeof result.proof_size_bytes === 'number' ? result.proof_size_bytes : 0,
      verifier_version:
        typeof result.verifier_version === 'string' ? result.verifier_version : 'unknown',
    };
  };
}

export interface ZkpAuditHandlerOptions {
  service?: ZkpAuditService;
  proverUrl?: string | null;
  verifyImpl?: VerifyFn;
  admission?: Partial<AdmissionPolicy>;
}

export class ZkpAuditServiceHandler extends ServiceHandlerBase {
  /**
   * REUSE-BEFORE-CREATE: `zkp_attestation` already exists in
   * `service_categories` (v1_active=false) and its description is verbatim this
   * service. `agent_services.service_type` is FK-bound to that table, so a new
   * `zkp_audit` category would have to be invented. The class/file keep the
   * `zkp_audit` name per the build spec.
   */
  protected readonly serviceType = ZKP_AUDIT_SERVICE_TYPE;

  private readonly service: ZkpAuditService;

  constructor(opts: ZkpAuditHandlerOptions = {}) {
    super();
    this.service =
      opts.service ??
      createZkpAuditService({
        db,
        proverUrl: opts.proverUrl !== undefined ? opts.proverUrl : resolveProverUrl(),
        verifyImpl: opts.verifyImpl ?? createWasmVerifier(),
        ...(opts.admission ? { admission: opts.admission } : {}),
      });
  }

  protected async fulfill(contract: ServiceContractRow): Promise<Record<string, unknown>> {
    try {
      return await this.service.produceAudit(contract);
    } catch (e: unknown) {
      if (e instanceof ZkpAuditError) {
        // Loud, coded, with the stack — Phase 2.9.4 anti-silent-swallow. Re-thrown
        // so the base class leaves the contract escrowed. Never converted into a
        // verdict, because a verdict of FAIL would enter the dispute economy.
        console.error(
          `[${this.serviceType}] refusing to deliver contract ${contract.id} — code=${e.code}:`,
          e.message,
          JSON.stringify(e.detail),
          e.stack ?? new Error().stack
        );
      }
      throw e;
    }
  }
}

/**
 * Independent re-verification entry point for a party that is NOT the producer:
 * the dispute panel, a route guard, or the buyer's own tooling.
 *
 * `DisputeResolutionWorker` should call this BEFORE running `runPCP` /
 * `runAdversarialJudge` on a `zkp_attestation` contract — the artifact is
 * deterministic and public, so an LLM panel adds noise, not signal. Wiring that
 * in requires editing `src/services/dispute-resolution-worker.ts`, which this
 * component may not touch.
 */
export async function verifyZkpAuditDeliverable(
  result: unknown,
  expectedSubjectAgentId?: string
): Promise<DeliverableVerification> {
  return verifyDeliverable(result, {
    verifyImpl: createWasmVerifier(),
    ...(expectedSubjectAgentId !== undefined ? { expectedSubjectAgentId } : {}),
  });
}
