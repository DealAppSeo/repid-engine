import { db } from '../db';
import { runPCP } from '../services/pcp-validator';
import { runAdversarialJudge } from '../services/adversarial-judge';
import { applyServiceDisputeResolution } from '../services/validation-repid-delta';

const POLL_INTERVAL_MS = parseInt(process.env.DISPUTE_WORKER_POLL_INTERVAL_MS ?? '15000', 10);

export class DisputeResolutionWorker {
  private running = false;

  async start() {
    if (process.env.DISPUTE_WORKER_ENABLED !== 'true') {
      console.log('[DisputeWorker] Disabled via env flag, skipping');
      return;
    }
    this.running = true;
    console.log('[DisputeWorker] Starting poll loop');
    this.pollLoop();
  }

  stop() {
    this.running = false;
  }

  private async pollLoop() {
    while (this.running) {
      try {
        const handled = await this.processOne();
        if (!handled) {
          await this.sleep(POLL_INTERVAL_MS);
        }
      } catch (e: any) {
        console.error('[DisputeWorker] poll error:', e?.message, e?.stack);
        await this.sleep(POLL_INTERVAL_MS);
      }
    }
  }

  private async processOne(): Promise<boolean> {
    // Claim next pending dispute (atomic)
    const { data: candidate } = await db
      .from('dispute_validation_queue')
      .select('*, service_contracts!inner(*)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!candidate) return false;

    // Atomic claim
    const { data: claimed } = await db
      .from('dispute_validation_queue')
      .update({ status: 'processing' })
      .eq('id', candidate.id)
      .eq('status', 'pending')
      .select()
      .maybeSingle();

    if (!claimed) return false;  // lost race

    const contract = candidate.service_contracts;
    console.log(`[DisputeWorker] processing dispute for contract ${contract.id}`);

    try {
      // Run BFT panel: PCP over the disputed result + judge
      const syntheticTask = {
        id: -1 as const,
        claimed_by: contract.provider_agent_id,  // exclude provider from validation
        title: `dispute-${contract.id}`,
        description: `dispute reason: ${candidate.metadata?.dispute_reason ?? 'unspecified'}`,
        result: JSON.stringify(contract.result),
        tier: 4,  // T3+ for disputes — higher stakes
      };

      const pcpResult = await runPCP(syntheticTask);
      // Phase 5 (Bug A) — judge accepts the SAME taskData shape as PCP (title /
      // description / result / optional metadata). Previously this passed
      // { content, claimer_provider, pcp_result } — none of those fields are
      // read by runAdversarialJudge, so the prompt template substituted
      // "undefined" for title/description/result and every provider either
      // produced an unparseable verdict or returned zero-confidence ESCALATE,
      // which the verdict logic below then resolved as 'no_fault'. Fix:
      // pass the canonical syntheticTask the judge actually reads. PCP's
      // result is still used downstream in the verdict gates.
      const judgeResult = await runAdversarialJudge(syntheticTask);

      // Verdict (Phase 6 / Bug B — see runAdversarialJudge prompt at
      // src/services/adversarial-judge.ts:263 — the judge contract is
      // APPROVE | CHALLENGE | ESCALATE; 'REJECT' is not in the vocabulary.
      // Pre-fix this branch compared against 'REJECT' which never matched, so
      // judge contributed nothing to the provider_at_fault path. Verdict gate
      // now reads the correct CHALLENGE token):
      //   PCP confidence high + judge APPROVE → buyer_at_fault (provider was correct)
      //   PCP confidence low OR judge CHALLENGE → provider_at_fault
      //   Mixed (incl. ESCALATE) → no_fault
      // Terminal status is 'resolved' in every branch — set at the update below.
      let verdict: 'provider_at_fault' | 'buyer_at_fault' | 'no_fault';
      if (pcpResult.confidence >= 0.7 && judgeResult.verdict === 'APPROVE') {
        verdict = 'buyer_at_fault';
      } else if (pcpResult.confidence < 0.3 || judgeResult.verdict === 'CHALLENGE') {
        verdict = 'provider_at_fault';
      } else {
        verdict = 'no_fault';
      }

      // Update dispute queue
      await db.from('dispute_validation_queue').update({
        status: 'completed',
        worker_verdict: verdict,
        pcp_score: pcpResult.confidence,
        judge_verdict: judgeResult.verdict,
        judge_confidence: judgeResult.confidence,
        processed_at: new Date().toISOString(),
      }).eq('id', candidate.id);

      // Update service contract status
      await db.from('service_contracts').update({
        status: 'resolved',
        dispute_verdict: verdict,
        resolved_at: new Date().toISOString(),
      }).eq('id', contract.id);

      // Apply dispute deltas
      await applyServiceDisputeResolution(contract, verdict);

      console.log(`[DisputeWorker] resolved contract ${contract.id} → ${verdict}`);
      return true;

    } catch (e: any) {
      console.error(`[DisputeWorker] failed for dispute ${candidate.id}:`, e?.message, e?.stack);
      await db.from('dispute_validation_queue').update({
        status: 'failed',
        processed_at: new Date().toISOString(),
        metadata: {
          ...(candidate.metadata ?? {}),
          last_error: e?.message,
          last_error_at: new Date().toISOString(),
        },
      }).eq('id', candidate.id);
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
