import { db } from '../db';
import { shouldParkForHalt } from './emergency-halt';
import { x402Facilitator, PaymentRequirements } from './x402-facilitator';

export interface RecoveryResult {
  rowsProcessed: number;
  rowsRecovered: number;
  rowsStillFailing: number;
  rowsAbandoned: number;
  circuitBreakerTripped: boolean;
}

export async function processRecoveryQueue(opts?: { dryRun?: boolean }): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    rowsProcessed: 0,
    rowsRecovered: 0,
    rowsStillFailing: 0,
    rowsAbandoned: 0,
    circuitBreakerTripped: false
  };

  try {
    // 1. Check circuit breaker
    const { data: cbConfig } = await db.from('repid_config')
      .select('value')
      .eq('key', 'cb_disable_x402_settlements')
      .single();

    if (cbConfig?.value === 'true') {
      result.circuitBreakerTripped = true;
      await logRun(result, opts?.dryRun);
      return result;
    }

    // 2. Read unresolved failures with attempt_count < 5
    const { data: failures, error } = await db.from('x402_settlement_failures')
      .select('*')
      .is('resolved_at', null)
      .lt('attempt_count', 5);

    if (error || !failures) {
      console.error('Failed to fetch x402_settlement_failures:', error?.message);
      return result;
    }

    // OWNERSHIP GUARD — do not touch a deferred release.
    //
    // This worker recovers the old inbound-tip flow: it re-settles from the
    // stored payload and INSERTS a new x402_settlements row. That is wrong for a
    // deferred release, where an authorization row already exists keyed on the
    // contract. Inserting a second row with the same idempotency_key would make
    // `.eq('idempotency_key').maybeSingle()` ambiguous for every future read,
    // leave the held row 'authorized' forever, and never settle the contract —
    // and calling the facilitator directly bypasses the atomic
    // `.eq('status','authorized')` claim that guarantees a single broadcast.
    //
    // Those rows belong to x402-release-retry-worker, which drives
    // releaseHeldPayment and owns that claim. A failure row is deferred-owned
    // exactly when a settlement row already exists under the same key.
    const failureKeys = failures
      .map((f: any) => f.idempotency_key)
      .filter((k: unknown): k is string => typeof k === 'string' && k.length > 0);
    const deferredOwned = new Set<string>();
    if (failureKeys.length > 0) {
      const { data: existing } = await db
        .from('x402_settlements')
        .select('idempotency_key')
        .in('idempotency_key', failureKeys);
      for (const e of (existing ?? []) as any[]) {
        if (e.idempotency_key) deferredOwned.add(String(e.idempotency_key));
      }
    }

    const now = Date.now();

    for (const row of failures) {
      if (row.idempotency_key && deferredOwned.has(String(row.idempotency_key))) {
        continue; // owned by the deferred-release retry worker
      }
      // 3. Apply exponential backoff
      const lastAttempt = new Date(row.last_attempted_at).getTime();
      let backoffMs = 30000; // default 30s for attempt 1
      if (row.attempt_count === 2) backoffMs = 120000; // 2 mins
      if (row.attempt_count === 3) backoffMs = 600000; // 10 mins
      if (row.attempt_count === 4) backoffMs = 3600000; // 1 hr
      if (row.attempt_count >= 5) backoffMs = 86400000; // Never really retry

      if (now - lastAttempt < backoffMs) {
        continue; // skip, still in backoff
      }

      result.rowsProcessed++;

      if (opts?.dryRun) {
        result.rowsRecovered++;
        continue;
      }

      // 4. Re-attempt settlement
      try {
        const settleResult = await x402Facilitator.settlePayment(
          row.payment_payload_b64,
          row.payment_requirements as PaymentRequirements[]
        );

        // Success!
        await db.from('x402_settlement_failures').update({
          resolved_at: new Date().toISOString()
        }).eq('id', row.id);

        const insertRes = await db.from('x402_settlements').insert({
          tip_id: 'recovery_' + row.id,
          prediction_topic: 'recovery',
          asset: row.payment_requirements?.[0]?.asset || '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          settlement_attempt_count: row.attempt_count + 1,
          idempotency_key: row.idempotency_key || null,
          requestor_agent_id: row.agent_id,
          amount: row.payment_requirements?.[0]?.maxAmountRequired || '0',
          status: 'settled',
          is_simulated: false
        });

        if (insertRes.error) {
           throw new Error(insertRes.error.message);
        }

        result.rowsRecovered++;
      } catch (err: any) {
        // Failed again
        console.error('Recovery attempt failed:', err);
        const newAttemptCount = row.attempt_count + 1;
        const isAbandoned = newAttemptCount >= 5;

        await db.from('x402_settlement_failures').update({
          attempt_count: newAttemptCount,
          last_attempted_at: new Date().toISOString(),
          facilitator_response: { error: err.message, abandoned: isAbandoned }
        }).eq('id', row.id);

        if (isAbandoned) {
          result.rowsAbandoned++;
        } else {
          result.rowsStillFailing++;
        }
      }
    }

    await logRun(result, opts?.dryRun);

  } catch (globalErr) {
    console.error('Fatal error in processRecoveryQueue:', globalErr);
  }

  return result;
}

async function logRun(result: RecoveryResult, dryRun?: boolean) {
  try {
    await db.from('x402_recovery_worker_runs').insert({
      rows_examined: result.rowsProcessed, // roughly maps to processed
      rows_eligible: result.rowsProcessed,
      rows_recovered: result.rowsRecovered,
      rows_still_failing: result.rowsStillFailing,
      rows_abandoned: result.rowsAbandoned,
      circuit_breaker_tripped: result.circuitBreakerTripped,
      dry_run: !!dryRun
    });
  } catch (err: any) {
    console.error('Failed to write telemetry:', err.message);
  }
}

export function startRecoveryWorker(opts?: { pollIntervalMs?: number }): { stop: () => void } {
  const intervalMs = opts?.pollIntervalMs || 30000;
  // RULE-8: re-entrancy guard so a slow recovery pass never overlaps the next tick, and
  // catch so a thrown pass can't crash the process or leave the flag stuck.
  let running = false;

  const timer = setInterval(async () => {
    if (running) return; // previous pass still in flight — skip this tick
    running = true;
    try {
      // L0 gate 0.4 — GLOBAL EMERGENCY HALT. This loop moves MONEY (x402
      // settlement recovery); it is the last loop that should keep running
      // through an incident.
      if (await shouldParkForHalt(db, 'x402-recovery')) return;
      await processRecoveryQueue();
    } catch (err) {
      console.error('[x402-recovery] processRecoveryQueue threw:', err instanceof Error ? err.message : err);
    } finally {
      running = false; // release regardless of outcome
    }
  }, intervalMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();

  return {
    stop: () => clearInterval(timer)
  };
}
