/**
 * HAL Judgment Worker — fills verdict_hal on repid_events rows awaiting judgment.
 *
 * x402-server writes a repid_events row with verdict_x402 set + verdict_hal='pending'.
 * This worker polls those pending rows, runs the REAL HAL evaluator
 * (extractHALSignalsWithCrossLLM — groq/anthropic/deepseek consensus +
 * Pythagorean-Comma BFT veto) on the agent output, derives a pass/fail verdict,
 * persists the judgment to hal_classifications (audit link), and sets verdict_hal
 * + hal_classification_id + verdict_combined_at. Once both verdicts are present,
 * the FeedbackLoopWorker decides on-chain eligibility (either dissent vetoes).
 *
 * GAS RULE: never fabricate a 'pass'. If the row carries no agent output to judge,
 * verdict_hal='error' (manual review) — no on-chain write will follow.
 *
 * Disabled by default (HAL_JUDGMENT_WORKER_ENABLED=true to activate), mirroring
 * the cascade-settlement / dispute worker gating. Bounded poll + per-cycle cap.
 */

import crypto from 'crypto';
import { db } from '../db';
import { extractHALSignalsWithCrossLLM } from '../services/hal-signals';

const POLL_MS = parseInt(process.env.HAL_JUDGMENT_POLL_MS ?? '15000', 10);
const MAX_PER_CYCLE = parseInt(process.env.HAL_JUDGMENT_MAX_PER_CYCLE ?? '10', 10);
const BFT_THRESHOLD = 0.618; // canonical cross-LLM agreement floor

export type HalVerdict = 'pass' | 'fail' | 'error';

/**
 * Derive pass/fail from HAL signals. The Pythagorean-Comma BFT veto is the
 * strongest dissent; sub-threshold cross-LLM agreement also fails. No output to
 * judge → 'error' (NEVER a fabricated pass — gas rule). Pure + unit-testable.
 */
export function deriveHalVerdict(
  signals: { comma_veto?: boolean | null; agreement_score?: number | null } | null,
  hadOutput: boolean
): HalVerdict {
  if (!hadOutput || !signals) return 'error';
  if (signals.comma_veto === true) return 'fail';
  if (typeof signals.agreement_score === 'number' && signals.agreement_score < BFT_THRESHOLD) return 'fail';
  return 'pass';
}

function hashText(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

export class HalJudgmentWorker {
  private timer: NodeJS.Timeout | null = null;

  async runOnce(): Promise<{ judged: number }> {
    let judged = 0;
    try {
      const { data: rows, error } = await db
        .from('repid_events')
        .select('id, subject_id, event_data')
        .eq('verdict_hal', 'pending')
        .not('verdict_x402', 'is', null)
        .is('processed_at', null)
        .order('created_at', { ascending: true })
        .limit(MAX_PER_CYCLE);

      if (error) {
        console.error('[hal-judgment] poll failed:', error?.message ?? error, (error as any)?.stack ?? new Error().stack);
        return { judged };
      }
      if (!rows || rows.length === 0) return { judged };

      for (const row of rows as any[]) {
        const ed = row.event_data ?? {};
        const output: string = String(ed.output ?? ed.claim_text ?? '').trim();
        const prompt: string = String(ed.prompt ?? ed.task ?? '').trim();

        let verdict: HalVerdict;
        let halClassificationId: number | null = null;

        try {
          if (!output) {
            // No agent output recorded on the event → cannot judge. Do NOT pass.
            verdict = 'error';
            console.warn(`[hal-judgment] event ${row.id}: no output in event_data → verdict_hal=error (manual review)`);
          } else {
            const signals: any = await extractHALSignalsWithCrossLLM(
              output,
              String(ed.domain ?? 'general'),
              Number(ed.certainty ?? 0.9),
              prompt || output
            );
            verdict = deriveHalVerdict(signals, true);

            // Persist the judgment to hal_classifications for audit + linkage (RULE-11).
            const { data: cls, error: clsErr } = await db
              .from('hal_classifications')
              .insert({
                prompt_hash: hashText(output),
                category: signals?.prompt_category ?? 'factual',
                confidence: verdict === 'pass' ? 'high' : 'low',
                latency_ms: 0,
                provider: 'cross-llm',
                model: 'hal-consensus',
              })
              .select('id')
              .single();
            if (clsErr) {
              console.error(`[hal-judgment] hal_classifications insert failed for event ${row.id}:`, clsErr?.message ?? clsErr);
            } else {
              halClassificationId = (cls as any)?.id ?? null;
            }
          }
        } catch (e: any) {
          verdict = 'error';
          console.error(`[hal-judgment] evaluator error for event ${row.id}:`, e?.message ?? e, e?.stack);
        }

        // Optimistic update — only if still pending (no double-judge race). RULE-11.
        const { error: updErr } = await db
          .from('repid_events')
          .update({
            verdict_hal: verdict,
            hal_classification_id: halClassificationId,
            verdict_combined_at: new Date().toISOString(), // x402 verdict already set → both present now
          })
          .eq('id', row.id)
          .eq('verdict_hal', 'pending');
        if (updErr) {
          console.error(`[hal-judgment] verdict update failed for event ${row.id}:`, updErr?.message ?? updErr);
          continue;
        }
        judged++;
        console.log(`[hal-judgment] event ${row.id}: verdict_hal=${verdict}${halClassificationId ? ` (hal_classification_id=${halClassificationId})` : ''}`);
      }
    } catch (e: any) {
      console.error('[hal-judgment] unhandled error:', e?.message ?? String(e), e?.stack ?? new Error().stack);
    }
    return { judged };
  }

  start(intervalMs: number = POLL_MS): void {
    if (process.env.HAL_JUDGMENT_WORKER_ENABLED !== 'true') {
      console.log('[hal-judgment] disabled — set HAL_JUDGMENT_WORKER_ENABLED=true to judge pending verdict_hal rows.');
      return;
    }
    console.log(`[hal-judgment] starting (interval=${intervalMs}ms, max_per_cycle=${MAX_PER_CYCLE})`);
    this.runOnce().catch((e) => console.error('[hal-judgment] initial run error:', e?.message ?? e, e?.stack));
    this.timer = setInterval(() => {
      this.runOnce().catch((e) => console.error('[hal-judgment] cycle error:', e?.message ?? e, e?.stack));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const halJudgmentWorker = new HalJudgmentWorker();
