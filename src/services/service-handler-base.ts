import { db } from '../db';
import { applyServiceFulfilledDeltas } from './validation-repid-delta';
import { recordServiceQuality } from './service-quality-hook';
import type { ServiceContractRow } from '../types';

/**
 * Phase 2.10 — Service Handler Base Class (production)
 *
 * Supersedes the Phase 2.11 minimal compile-stub. Backward-compatible:
 * the abstract surface (`serviceType`, `fulfill`) and the `process(contract)`
 * shim are preserved verbatim, so the Phase 2.11 StorageServiceHandler and
 * ReputationAuditServiceHandler (which only use `serviceType` + `fulfill`)
 * keep compiling and functioning with ZERO edits — they additionally gain
 * production `processOne` drivability for free.
 *
 * Pattern: an agent's main loop polls handlers in order; each handler claims
 * the oldest escrowed contract where this agent is provider AND service_type
 * matches, fulfils it, transitions escrowed→fulfilled, and applies the
 * canonical SERVICE_FULFILLED deltas. Atomic (optimistic-concurrency) claim
 * prevents two handler instances grabbing the same contract.
 *
 * LOUD ERROR LOGGING (per Phase 2.9.4 silent-swallow finding): every catch
 * here uses console.error WITH STACK TRACE, never .message-only. This is
 * audit surface — failures must be discoverable.
 */
export abstract class ServiceHandlerBase {
  protected abstract readonly serviceType: string;

  /**
   * Phase 2.11 compatibility shim (retained verbatim — no current caller, but
   * zero-cost and guarantees no 2.11 regression). Prefer processOne() for the
   * production poll→claim→fulfil→deltas lifecycle.
   */
  public async process(contract: ServiceContractRow): Promise<void> {
    await this.fulfill(contract);
  }

  /**
   * Subclass implements the actual service logic; returns the result object
   * stored on the contract.
   */
  protected abstract fulfill(contract: ServiceContractRow): Promise<Record<string, unknown>>;

  /**
   * Atomic claim. FIFO (oldest escrowed first). Optimistic-concurrency UPDATE
   * gated on status still 'escrowed' prevents double-claim. Returns the
   * claimed contract or null. service_contracts has no processed_at⟺status
   * biconditional CHECK (verified Phase 2.9.3 Task 2d), so no constraint
   * conflict like the Phase 2.9.2 validation_queue case.
   */
  protected async claimNextContract(agentId: string): Promise<ServiceContractRow | null> {
    const { data: candidate, error: fetchErr } = await db
      .from('service_contracts')
      .select('*, agent_services!inner(service_type)')
      .eq('provider_agent_id', agentId)
      .eq('status', 'escrowed')
      .eq('agent_services.service_type', this.serviceType)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (fetchErr) {
      console.error(
        `[${this.serviceType}] claim fetch error:`,
        fetchErr?.message ?? fetchErr,
        (fetchErr as any)?.stack ?? new Error().stack
      );
      return null;
    }
    if (!candidate) return null;

    const { data: claimed, error: claimErr } = await db
      .from('service_contracts')
      .update({
        metadata: {
          ...((candidate as any).metadata ?? {}),
          claimed_at: new Date().toISOString(),
          claimed_by_handler: this.serviceType,
        },
      })
      .eq('id', (candidate as any).id)
      .eq('status', 'escrowed') // optimistic concurrency — lost race ⇒ 0 rows
      .select()
      .maybeSingle();

    if (claimErr) {
      console.error(
        `[${this.serviceType}] claim update error for ${(candidate as any).id}:`,
        claimErr?.message ?? claimErr,
        (claimErr as any)?.stack ?? new Error().stack
      );
      return null;
    }
    if (!claimed) return null; // lost the race to another instance — not an error

    return claimed as unknown as ServiceContractRow;
  }

  /**
   * Full cycle: claim → fulfil → escrowed→fulfilled → SERVICE_FULFILLED deltas.
   * Retry-safe: on failure the contract stays escrowed (not failed) with an
   * error trail in metadata, so a later cycle can retry.
   */
  async processOne(
    agentId: string
  ): Promise<{ processed: boolean; contract_id?: string; error?: string }> {
    const contract = await this.claimNextContract(agentId);
    if (!contract) return { processed: false };

    try {
      const result = await this.fulfill(contract);

      // Defect 3 fix (2026-05-18): the composite verdict GATES settlement.
      // Prior behaviour fulfilled unconditionally — a Pythagorean-Comma BFT
      // VETO (or FAIL) still reached status='fulfilled' and emitted the
      // SERVICE_FULFILLED economy, corrupting the ledger (12/12 repro in
      // Gemini's variety run). Now VETO/FAIL routes to the dispute panel:
      // NOT fulfilled, NO SERVICE_FULFILLED deltas, NO audit anchor. Only
      // PASS/APPROVE — or a handler that returns no `verdict` at all (the
      // Phase 2.11 storage/reputation handlers) — takes the fulfilled path,
      // so there is zero regression for verdict-less handlers.
      const verdict =
        typeof (result as any)?.verdict === 'string'
          ? ((result as any).verdict as string).toUpperCase()
          : undefined;

      if (verdict === 'VETO' || verdict === 'FAIL') {
        const { data: dq, error: dqErr } = await db
          .from('dispute_validation_queue')
          .insert({
            contract_id: contract.id,
            status: 'pending',
            pcp_score: (result as any)?.pcp_score ?? null,
            judge_verdict: (result as any)?.judge_verdict ?? null,
            judge_confidence: (result as any)?.judge_confidence ?? null,
            validator_agents: (result as any)?.pcp_validators ?? null,
            metadata: {
              composite_verdict: verdict,
              comma_severity: (result as any)?.comma_severity ?? null,
              patent_marker: (result as any)?.patent_marker ?? null,
              routed_by: this.serviceType,
              routed_at: new Date().toISOString(),
              fulfill_result: result,
            },
          })
          .select('id')
          .single();

        if (dqErr || !dq) {
          console.error(
            `[${this.serviceType}] dispute_validation_queue insert failed for contract ${contract.id}:`,
            dqErr?.message ?? dqErr,
            (dqErr as any)?.stack ?? new Error().stack
          );
          throw new Error(
            `dispute_validation_queue insert failed: ${dqErr?.message ?? 'no row returned'}`
          );
        }

        // NB: do NOT write dispute_panel_validation_queue_id here — that
        // column's FK references validation_queue(id), NOT
        // dispute_validation_queue. The contract↔dispute link is preserved
        // by dispute_validation_queue.contract_id (set above).
        const { error: dispErr } = await db
          .from('service_contracts')
          .update({
            status: 'disputed',
            result,
            disputed_at: new Date().toISOString(),
          })
          .eq('id', contract.id);

        if (dispErr) {
          console.error(
            `[${this.serviceType}] disputed-transition failed for contract ${contract.id}:`,
            dispErr?.message ?? dispErr,
            (dispErr as any)?.stack ?? new Error().stack
          );
          throw new Error(`Disputed status transition failed: ${dispErr.message}`);
        }

        console.log(
          `[${this.serviceType}] contract ${contract.id} verdict=${verdict} ` +
            `→ routed to dispute_validation_queue ${(dq as any).id} ` +
            `(NOT fulfilled, no SERVICE_FULFILLED deltas)`
        );
        return { processed: true, contract_id: contract.id };
      }

      // PASS / APPROVE / verdict-less handler → existing fulfilled path.
      const { error: updateErr } = await db
        .from('service_contracts')
        .update({
          status: 'fulfilled',
          result,
          fulfilled_at: new Date().toISOString(),
        })
        .eq('id', contract.id);

      if (updateErr) {
        console.error(
          `[${this.serviceType}] fulfilled-transition failed for contract ${contract.id}:`,
          updateErr?.message ?? updateErr,
          (updateErr as any)?.stack ?? new Error().stack
        );
        throw new Error(`Status transition failed: ${updateErr.message}`);
      }

      // Canonical Phase 2.6 economy. Signature (Phase 2.9):
      // applyServiceFulfilledDeltas({id, service_id, provider_agent_id, buyer_agent_id})
      await applyServiceFulfilledDeltas({
        id: contract.id,
        service_id: contract.service_id as string,
        provider_agent_id: contract.provider_agent_id,
        buyer_agent_id: contract.buyer_agent_id,
      });

      // QUALITY, as distinct from DELIVERY. Everything above pays for the fact
      // that work arrived; nothing above asks whether it was any good. This is
      // the one live path carrying real deliverable work, so it is where a HAL
      // verdict belongs — see src/services/service-quality-hook.ts for why it is
      // off by default and scoped to an agent allowlist.
      //
      // Deliberately AFTER the deltas: the buyer already has the artifact and
      // the economy has already settled by the time this runs. It IS awaited —
      // the observation must be recorded before the contract is reported
      // processed, or a shadow run would race its own result — but it cannot
      // fail the fulfilment, because recordServiceQuality returns a NOT_CHECKED
      // observation instead of throwing. An observation that can undo a
      // completed delivery is not an observation.
      const quality = await recordServiceQuality({
        contractId: contract.id,
        providerAgentId: contract.provider_agent_id,
        serviceType: this.serviceType,
        result,
        contractMetadata: (contract.metadata as Record<string, unknown>) ?? null,
      });
      if (quality.mode !== 'off') {
        // NOT_CHECKED is logged as loudly as a verdict. A quality probe that
        // silently declined to run is indistinguishable from one that passed,
        // and that confusion is the defect class this repo keeps paying for.
        console.log(
          `[${this.serviceType}] quality ${quality.mode}: ` +
            (quality.checked
              ? `decision=${quality.hal_decision} score=${quality.hal_score} ` +
                `${quality.mode === 'shadow' ? `would_apply=${quality.would_apply}` : `applied=${quality.applied}`}`
              : `NOT_CHECKED (${quality.reason})`) +
            ` contract=${contract.id}`
        );
      }

      console.log(
        `[${this.serviceType}] fulfilled contract ${contract.id} ` +
          `(buyer=${contract.buyer_agent_id}, provider=${contract.provider_agent_id})`
      );
      return { processed: true, contract_id: contract.id };
    } catch (e: any) {
      console.error(
        `[${this.serviceType}] fulfilment failed for contract ${contract.id}:`,
        e?.message ?? String(e),
        e?.stack ?? new Error().stack
      );

      await db
        .from('service_contracts')
        .update({
          metadata: {
            ...((contract.metadata as any) ?? {}),
            last_error: e?.message ?? String(e),
            last_error_at: new Date().toISOString(),
            last_error_handler: this.serviceType,
          },
        })
        .eq('id', contract.id);

      return { processed: false, error: e?.message ?? String(e) };
    }
  }
}
