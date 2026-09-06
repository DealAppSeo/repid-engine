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
   * Atomic claim. FIFO (oldest escrowed first) — but DELIVERABLE rows first.
   * Optimistic-concurrency UPDATE gated on status still 'escrowed' prevents
   * double-claim. Returns the claimed contract or null. service_contracts has no
   * processed_at⟺status biconditional CHECK (verified Phase 2.9.3 Task 2d), so
   * no constraint conflict like the Phase 2.9.2 validation_queue case.
   *
   * ── HEAD-OF-LINE BLOCKING [MEASURED 2026-09-05, live] ────────────────────
   * Plain FIFO wedges this queue permanently. A contract whose
   * `work_statement_hash` is NULL can NEVER reach `fulfilled` — the DB refuses
   * the transition outright (#607; only rows already past fulfilled are
   * grandfathered). Nothing backfills that column on an existing row. So such a
   * contract fails, stays `escrowed` (the failure path writes metadata only),
   * and is therefore selected again by the very next cycle — forever.
   *
   * Because the selection is per-provider and oldest-first, ONE undeliverable
   * row starves every later contract for that provider. Measured: an
   * undeliverable row from 2026-09-04 was re-claimed and re-failed roughly once
   * a minute, while a perfectly deliverable contract created 12 minutes earlier
   * that day sat at `claimed_at: null` — never attempted once. The retry loop
   * looked healthy from every angle; the work simply never got a turn.
   *
   * The fix is ordering, NOT exclusion. Deliverable rows are offered first.
   *
   * ── WHY THE FALLBACK NO LONGER DOES THE WORK [MEASURED 2026-09-05] ───────
   * This comment used to end: "the fallback below still picks up the un-hashed
   * ones ... Skipping them outright would trade a wedged queue for a silent
   * one, which is the worse of the two." That framing was wrong, because it
   * priced the loud failure at zero. It is not free: the loud failure happens
   * INSIDE `fulfill()`, at the DB transition, i.e. AFTER the handler has
   * already run peer validation. For the verification handler that is three
   * LLM calls per attempt.
   *
   * Once a minute, forever, that is 4,320 calls a day. Measured in
   * `llm_call_log`: 356 of 360 consecutive minutes carried exactly 3
   * `pcp_validation` calls, 4,362 in 24 hours, of which 3,892 FAILED — the
   * account's Groq daily token allowance was exhausted by this loop and every
   * other caller then got HTTP 429 for the rest of the day. The visible
   * consequence: the first genuinely deliverable contract to reach `fulfilled`
   * after the ordering fix recorded `0 of 3 validator(s) answered` and could
   * not settle. One un-hashed row was denying the whole system its verification
   * capacity.
   *
   * So the choice was never "wedged vs silent". It was "loud once vs loud 1,440
   * times a day, paid for in everyone else's quota". Deliverability is a
   * PRECONDITION, and a precondition is checked before the work, not after it.
   * The fallback still SURFACES the row — durably, in `metadata.undeliverable`
   * with a first-seen timestamp, which outlives the `last_error` string the old
   * path overwrote every minute — but it does not hand it to `fulfill()`.
   * Nothing is dropped: the row stays `escrowed`, keeps its funds, and is now
   * queryable rather than merely re-logged.
   */
  protected async claimNextContract(agentId: string): Promise<ServiceContractRow | null> {
    const baseQuery = () =>
      db
        .from('service_contracts')
        .select('*, agent_services!inner(service_type)')
        .eq('provider_agent_id', agentId)
        .eq('status', 'escrowed')
        .eq('agent_services.service_type', this.serviceType);

    // Pass 1 — oldest contract that CAN actually reach `fulfilled`.
    let { data: candidate, error: fetchErr } = await baseQuery()
      .not('work_statement_hash', 'is', null)
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

    // Pass 2 — nothing deliverable is waiting. Surface any un-hashed rows so a
    // stuck contract stays visible, but do NOT hand them to `fulfill()`: they
    // cannot reach `fulfilled`, and attempting them costs real LLM quota every
    // cycle (see the header). Marking is idempotent, so the write happens once
    // per row rather than once per minute.
    if (!candidate) {
      const fallback = await baseQuery().order('created_at', { ascending: true }).limit(1).maybeSingle();
      if (fallback.error) {
        console.error(
          `[${this.serviceType}] claim fetch error (fallback):`,
          fallback.error?.message ?? fallback.error,
          (fallback.error as any)?.stack ?? new Error().stack
        );
        return null;
      }
      candidate = fallback.data;
      if (candidate && (candidate as any).work_statement_hash == null) {
        await this.markUndeliverable(candidate as any);
        return null;
      }
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
   * Record — once — that a contract can never reach `fulfilled`, and why.
   *
   * This replaces an attempt-and-fail that cost three LLM calls a minute. It is
   * deliberately a WRITE and not just a log line: a log line in a restarting
   * container is not evidence anyone can query, and the `metadata.last_error`
   * the old path produced was overwritten on every cycle, so it recorded the
   * most recent attempt rather than the age of the problem. `first_seen_at` is
   * preserved across calls precisely so the age is answerable.
   *
   * It does NOT touch funds, status, or the escrow. Clearing or backfilling an
   * un-hashed row moves real money and is the owner's decision, not this
   * worker's.
   *
   * KNOWN LIMIT, stated rather than left to be discovered: pass 2 selects the
   * OLDEST un-hashed row, so with several waiting only that one carries a
   * marker until it is cleared. The marker adds the reason and the age; it is
   * not the census. `select … where status='escrowed' and work_statement_hash
   * is null` finds every one of them and is what an operator count should use.
   */
  private async markUndeliverable(candidate: { id: string; metadata?: Record<string, unknown> | null }): Promise<void> {
    const existing = (candidate.metadata ?? {}) as Record<string, any>;
    const prior = existing['undeliverable'] as Record<string, any> | undefined;
    const reason = 'WORK_STATEMENT_REQUIRED: work_statement_hash is NULL and nothing backfills it';

    // Already marked with the same reason ⇒ nothing to say and nothing to write.
    if (prior && prior['reason'] === reason) return;

    console.warn(
      `[${this.serviceType}] contract ${candidate.id} is UNDELIVERABLE: ${reason}. ` +
        'It is being marked and skipped, not attempted — attempting it consumes LLM ' +
        'quota every cycle and can never succeed. Clearing or backfilling this row ' +
        'is a money-path decision for the owner.'
    );

    const { error } = await db
      .from('service_contracts')
      .update({
        metadata: {
          ...existing,
          undeliverable: {
            reason,
            detected_by: this.serviceType,
            first_seen_at: prior?.['first_seen_at'] ?? new Date().toISOString(),
          },
        },
      })
      .eq('id', candidate.id)
      .eq('status', 'escrowed'); // never overwrite a row that moved on under us

    if (error) {
      console.error(
        `[${this.serviceType}] failed to mark ${candidate.id} undeliverable:`,
        error?.message ?? error,
        (error as any)?.stack ?? new Error().stack
      );
    }
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
