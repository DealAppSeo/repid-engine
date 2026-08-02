/**
 * x402-release-retry-worker.ts — a delivered contract must not stay unpaid
 * because one facilitator call failed.
 *
 * THE STRANDED STATE. When /satisfy releases payment and the facilitator throws,
 * the state machine does the right thing: the authorization is handed back from
 * 'settling' to 'authorized' so a retry is possible, no money moves, nothing is
 * double-spent. But nothing retries. The contract sits `fulfilled` — the work
 * delivered and verified, the provider unpaid, the buyer's authorization still
 * good — until a human happens to call satisfy again. Observed live 2026-08-02
 * on contract 2e89cea0-c540-4a19-8adc-47df56cf5be1, where the only reason it
 * healed is that I was at a terminal and retried by hand.
 *
 * A user should never have to know that happened. This closes it.
 *
 * WHY IT DRIVES releaseHeldPayment AND NOT THE FACILITATOR DIRECTLY. The
 * pre-existing x402-recovery-worker calls x402Facilitator.settlePayment() itself
 * and then INSERTS a new x402_settlements row. For the old inbound-tip flow that
 * is fine. For a deferred release it would be wrong twice over: the held
 * authorization row already exists keyed on this contract, so a second row makes
 * `.eq(idempotency_key).maybeSingle()` ambiguous for every future read; and
 * calling the facilitator directly bypasses the atomic
 * `.eq('status','authorized')` claim that is the ONLY thing guaranteeing an
 * authorization is broadcast exactly once. releaseHeldPayment owns that claim,
 * the void check and the idempotency, so the retry goes through it.
 *
 * WHY IT FINALIZES. Releasing the money and stopping would leave funds moved,
 * contract still `fulfilled`, provider unpaid on the ledger and unrewarded in
 * RepID — strictly worse than the state it set out to repair. It calls the same
 * finalizeSettledContract that /satisfy calls, so both paths end identically.
 *
 * SAFETY, in order of how much they matter:
 *   · never invents consent — only contracts whose buyer ALREADY accepted, i.e.
 *     a recorded PASS verdict AND a positive buyer_satisfaction_score. A
 *     contract nobody accepted is left alone, forever if need be.
 *   · never resurrects a void — releaseHeldPayment refuses a voided row.
 *   · bounded — MAX_ATTEMPTS, then it stops and escalates to a human rather
 *     than hammering a broken facilitator.
 *   · exponential backoff, reusing the schedule the recovery worker established.
 *   · default OFF (X402_RELEASE_RETRY_ENABLED), and a shadow mode that reports
 *     what it WOULD do without touching anything.
 *
 * FLAG: X402_RELEASE_RETRY_ENABLED = off | shadow | enforce (default off).
 */

import { db } from '../db';
import { releaseHeldPayment, SETTLEMENT_STATUS } from './x402-deferred-settlement';
import { finalizeSettledContract } from './contract-settlement-finalize';
import { x402Facilitator } from './x402-facilitator';
import { sendTelegramMessage } from '../routes/telegram';

export type RetryMode = 'off' | 'shadow' | 'enforce';

export const MAX_ATTEMPTS = 5;

/** Same schedule the recovery worker uses, so operators reason about one curve. */
export const BACKOFF_MS: Record<number, number> = {
  0: 30_000,
  1: 30_000,
  2: 120_000,
  3: 600_000,
  4: 3_600_000,
};

export function parseRetryMode(raw: string | undefined | null): RetryMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'enforce') return 'enforce';
  if (v === 'shadow') return 'shadow';
  return 'off';
}

export function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, 4)] ?? 3_600_000;
}

export interface StrandedContract {
  contractId: string;
  settlementId: string;
  providerAgentId: string;
  agreedPriceRaw: number;
  satisfactionScore: number;
  attempts: number;
  lastAttemptedAt: string | null;
}

export interface RetrySweepResult {
  mode: RetryMode;
  examined: number;
  eligible: number;
  recovered: number;
  stillFailing: number;
  abandoned: number;
  wouldAttempt: string[];
}

/**
 * A contract is stranded when the work was delivered AND the buyer accepted it,
 * but the authorization is still sitting unspent.
 *
 * Both halves matter. `fulfilled` alone is not enough — that is the normal state
 * of a contract waiting for its buyer, and paying those out would be inventing
 * an acceptance nobody gave.
 */
export function isStranded(row: {
  contract_status: string;
  settlement_status: string;
  verdict: string | null;
  buyer_satisfaction_score: number | null;
}): boolean {
  if (row.contract_status !== 'fulfilled') return false;
  if (row.settlement_status !== SETTLEMENT_STATUS.AUTHORIZED) return false;
  if (String(row.verdict ?? '').toUpperCase() !== 'PASS') return false;
  return typeof row.buyer_satisfaction_score === 'number' && row.buyer_satisfaction_score > 0;
}

export function isDue(stranded: StrandedContract, now: number): boolean {
  if (stranded.attempts >= MAX_ATTEMPTS) return false;
  if (!stranded.lastAttemptedAt) return true;
  return now - new Date(stranded.lastAttemptedAt).getTime() >= backoffFor(stranded.attempts);
}

export interface RetryDeps {
  findStranded(): Promise<StrandedContract[]>;
  release(s: StrandedContract): Promise<{ status: string; txHash?: string; reason?: string }>;
  finalize(s: StrandedContract, txHash?: string): Promise<{ ok: boolean; error?: string }>;
  recordAttempt(s: StrandedContract, ok: boolean, reason?: string): Promise<void>;
  escalate(s: StrandedContract, reason: string): Promise<void>;
  now(): number;
}

/**
 * Pure orchestration over injected effects, so the decision logic is testable
 * without a database, a chain, or a clock.
 */
export async function runRetrySweep(deps: RetryDeps, mode: RetryMode): Promise<RetrySweepResult> {
  const out: RetrySweepResult = {
    mode,
    examined: 0,
    eligible: 0,
    recovered: 0,
    stillFailing: 0,
    abandoned: 0,
    wouldAttempt: [],
  };
  if (mode === 'off') return out;

  const stranded = await deps.findStranded();
  out.examined = stranded.length;
  const now = deps.now();

  for (const s of stranded) {
    if (s.attempts >= MAX_ATTEMPTS) {
      out.abandoned++;
      // Say so once, to a human, rather than retrying forever in silence.
      await deps.escalate(s, `abandoned after ${s.attempts} attempts`);
      continue;
    }
    if (!isDue(s, now)) continue;

    out.eligible++;
    if (mode === 'shadow') {
      out.wouldAttempt.push(s.contractId);
      continue;
    }

    const released = await deps.release(s);
    const paid =
      released.status === 'SETTLED' ||
      released.status === 'ALREADY_SETTLED' ||
      released.status === 'SETTLED_UNRECORDED';

    if (!paid) {
      out.stillFailing++;
      await deps.recordAttempt(s, false, released.reason ?? released.status);
      if (s.attempts + 1 >= MAX_ATTEMPTS) {
        out.abandoned++;
        await deps.escalate(s, `final attempt failed: ${released.reason ?? released.status}`);
      }
      continue;
    }

    // Money moved. Finishing is now mandatory — see the module header.
    const fin = await deps.finalize(s, released.txHash);
    if (!fin.ok) {
      // The transfer is real and cannot be undone. Do not report recovery.
      await deps.escalate(
        s,
        `PAID BUT NOT FINALIZED tx=${released.txHash ?? 'unknown'} — ledger is behind the chain: ${fin.error ?? 'unknown'}`,
      );
      out.stillFailing++;
      continue;
    }

    out.recovered++;
    await deps.recordAttempt(s, true);
  }

  return out;
}

// ---------------------------------------------------------------------------
// db-bound adapter
// ---------------------------------------------------------------------------

async function findStranded(): Promise<StrandedContract[]> {
  const { data: rows, error } = await db
    .from('service_contracts')
    .select('id, provider_agent_id, agreed_price_usdc_raw, buyer_satisfaction_score, result, status')
    .eq('status', 'fulfilled')
    .limit(100);
  if (error || !rows || rows.length === 0) return [];

  const ids = rows.map((r: any) => String(r.id));
  const { data: settlements } = await db
    .from('x402_settlements')
    .select('id, idempotency_key, status')
    .in('idempotency_key', ids);

  const byContract = new Map<string, { id: string; status: string }>();
  for (const s of (settlements ?? []) as any[]) {
    byContract.set(String(s.idempotency_key), { id: String(s.id), status: String(s.status) });
  }

  // Attempt history lives in x402_settlement_failures, written by the release
  // path (see x402-deferred-settlement recordReleaseFailure).
  const { data: failures } = await db
    .from('x402_settlement_failures')
    .select('idempotency_key, attempt_count, last_attempted_at, resolved_at')
    .in('idempotency_key', ids)
    .is('resolved_at', null);
  const failByContract = new Map<string, { attempts: number; last: string | null }>();
  for (const f of (failures ?? []) as any[]) {
    failByContract.set(String(f.idempotency_key), {
      attempts: Number(f.attempt_count ?? 0),
      last: f.last_attempted_at ?? null,
    });
  }

  const out: StrandedContract[] = [];
  for (const r of rows as any[]) {
    const settle = byContract.get(String(r.id));
    if (!settle) continue;
    if (
      !isStranded({
        contract_status: String(r.status),
        settlement_status: settle.status,
        verdict: (r.result as any)?.verdict ?? null,
        buyer_satisfaction_score: r.buyer_satisfaction_score ?? null,
      })
    ) {
      continue;
    }
    const hist = failByContract.get(String(r.id));
    out.push({
      contractId: String(r.id),
      settlementId: settle.id,
      providerAgentId: String(r.provider_agent_id),
      agreedPriceRaw: Number(r.agreed_price_usdc_raw ?? 0),
      satisfactionScore: Number(r.buyer_satisfaction_score ?? 1),
      attempts: hist?.attempts ?? 0,
      lastAttemptedAt: hist?.last ?? null,
    });
  }
  return out;
}

async function releaseFor(s: StrandedContract) {
  const { data: provider } = await db
    .from('repid_agents')
    .select('wallet_address')
    .eq('id', s.providerAgentId)
    .maybeSingle();

  const requirements = x402Facilitator.buildPaymentRequirements({
    resource: `/api/v1/contracts/${s.contractId}/escrow`,
    payTo: (provider as any)?.wallet_address || '0x0000000000000000000000000000000000000000',
    priceUsdc: String(s.agreedPriceRaw),
    description: `Service Contract ${s.contractId} Escrow payment`,
  });

  return releaseHeldPayment({
    contractId: s.contractId,
    requirements,
    deliverableVerified: true,
    verificationEvidence: `retry-worker: buyer already accepted (satisfaction=${s.satisfactionScore})`,
  });
}

async function recordAttempt(s: StrandedContract, ok: boolean, reason?: string): Promise<void> {
  try {
    if (ok) {
      await db
        .from('x402_settlement_failures')
        .update({ resolved_at: new Date().toISOString() })
        .eq('idempotency_key', s.contractId)
        .is('resolved_at', null);
      return;
    }
    await db
      .from('x402_settlement_failures')
      .update({
        attempt_count: s.attempts + 1,
        last_attempted_at: new Date().toISOString(),
        facilitator_response: { error: reason ?? 'unknown', source: 'release-retry-worker' },
      })
      .eq('idempotency_key', s.contractId)
      .is('resolved_at', null);
  } catch (e) {
    console.error(`[x402-release-retry] could not record attempt for ${s.contractId}:`, e);
  }
}

/**
 * Escalate to a human.
 *
 * ALWAYS loud in the logs; Telegram additionally when TELEGRAM_CHAT_ID is set.
 * The log line is the guarantee — an alert channel that is merely unconfigured
 * must not turn a stuck payment back into a silent one, which is the failure
 * this whole change exists to end.
 */
async function escalate(s: StrandedContract, reason: string): Promise<void> {
  const line =
    `[x402-release-retry] NEEDS A HUMAN contract=${s.contractId} provider=${s.providerAgentId} ` +
    `amount_raw=${s.agreedPriceRaw} attempts=${s.attempts} — ${reason}`;
  console.error(line);
  try {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) return;
    await sendTelegramMessage(
      chatId,
      `⚠️ *Payment release stuck*\n\n` +
        `Contract \`${s.contractId}\`\n` +
        `Provider \`${s.providerAgentId}\`\n` +
        `Amount ${(s.agreedPriceRaw / 1e6).toFixed(2)} USDC\n` +
        `Attempts ${s.attempts}\n\n` +
        `${reason}\n\nThe work was delivered and accepted. The provider is unpaid.`,
    );
  } catch (e) {
    console.error('[x402-release-retry] telegram escalation failed:', e);
  }
}

export async function runRetrySweepLive(): Promise<RetrySweepResult> {
  return runRetrySweep(
    {
      findStranded,
      release: releaseFor,
      finalize: async (s, txHash) =>
        finalizeSettledContract({
          contractId: s.contractId,
          satisfactionScore: s.satisfactionScore,
          releaseResult: txHash ? { txHash } : null,
        }),
      recordAttempt,
      escalate,
      now: () => Date.now(),
    },
    parseRetryMode(process.env.X402_RELEASE_RETRY_ENABLED),
  );
}

let timer: NodeJS.Timeout | null = null;

export function startReleaseRetryWorker(): { stop: () => void } {
  const mode = parseRetryMode(process.env.X402_RELEASE_RETRY_ENABLED);
  if (mode === 'off') {
    console.log('[x402-release-retry] disabled (X402_RELEASE_RETRY_ENABLED=off), skipping');
    return { stop: () => undefined };
  }
  const intervalMs = Number(process.env.X402_RELEASE_RETRY_POLL_MS ?? 60_000);
  console.log(`[x402-release-retry] started in ${mode} mode (poll ${intervalMs}ms)`);

  let running = false;
  timer = setInterval(async () => {
    if (running) return; // re-entrancy guard
    running = true;
    try {
      const r = await runRetrySweepLive();
      if (r.examined > 0) {
        console.log(
          `[x402-release-retry] mode=${r.mode} examined=${r.examined} eligible=${r.eligible} ` +
            `recovered=${r.recovered} stillFailing=${r.stillFailing} abandoned=${r.abandoned}` +
            (r.wouldAttempt.length ? ` wouldAttempt=${r.wouldAttempt.join(',')}` : ''),
        );
      }
    } catch (e) {
      console.error('[x402-release-retry] sweep threw:', e);
    } finally {
      running = false;
    }
  }, intervalMs);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
