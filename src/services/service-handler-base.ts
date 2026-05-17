import { db } from '../db';
import { applyServiceFulfilledDeltas } from './validation-repid-delta';
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
 * patent surface — failures must be discoverable.
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
