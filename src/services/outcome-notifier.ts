import { db } from '../db';
import { sendTelegramMessage } from '../routes/telegram';

/**
 * T3 outcome nudge (modular, flag-gated, default OFF).
 *
 * When a contract settles, `service_outcome_pending` gets a row that becomes
 * ELIGIBLE at settle+24h. This module reads that queue and sends the Telegram
 * prompt: "You used <service> — did it hold up? 👍/👌/👎". It NEVER penalizes;
 * silence stays absence-neutral. The endpoint (POST /contracts/:id/outcome) is
 * the real deliverable — this is a thin add-on.
 *
 * Gating:
 *   T3_OUTCOME_NUDGE_ENABLED=true   → the notifier will actually send.
 *   (default / unset / anything else) → no-op; nothing is sent.
 *
 * The prompt goes to the shared operator/HITL channel (TELEGRAM_CHAT_ID), the
 * same channel every other alert in this codebase uses — there is no per-agent
 * chat_id column on repid_agents. Wiring a per-buyer chat_id is a Sean-lane
 * follow-up (needs a schema add + a buyer→chat mapping).
 */

const NUDGE_FLAG = 'T3_OUTCOME_NUDGE_ENABLED';

export function outcomeNudgeEnabled(): boolean {
  return process.env[NUDGE_FLAG] === 'true';
}

/**
 * Register a pending-outcome for a settled contract. Idempotent (unique on
 * contract_id). Safe no-op if the flag is off OR the table is absent — the T3
 * endpoint remains fully functional without any of this. Never throws into the
 * caller's happy path; failures are logged.
 */
export async function registerPendingOutcome(contract: {
  id: string;
  buyer_agent_id: string;
  provider_agent_id: string;
  settled_at?: string | null;
}): Promise<void> {
  if (!outcomeNudgeEnabled()) return;
  try {
    const settledAt = contract.settled_at ? new Date(contract.settled_at) : new Date();
    const eligibleAt = new Date(settledAt.getTime() + 24 * 60 * 60 * 1000);
    const expiresAt = new Date(settledAt.getTime() + 7 * 24 * 60 * 60 * 1000);

    const { error } = await db.from('service_outcome_pending').insert({
      contract_id: contract.id,
      buyer_agent_id: contract.buyer_agent_id,
      provider_agent_id: contract.provider_agent_id,
      settled_at: settledAt.toISOString(),
      eligible_at: eligibleAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: 'pending',
    });
    // 23505 = duplicate (already registered) — that's fine, idempotent.
    if (error && error.code !== '23505') {
      console.error('[outcome-notifier] registerPendingOutcome failed:', error.message);
    }
  } catch (e: any) {
    console.error('[outcome-notifier] registerPendingOutcome error:', e?.message ?? String(e));
  }
}

export interface NudgeSweepResult {
  enabled: boolean;
  eligible: number;
  sent: number;
  errors: number;
}

/**
 * Sweep the pending queue: for every row that is eligible (now >= eligible_at),
 * not yet expired, and still 'pending', send the Telegram nudge and mark it
 * 'notified'. Rows past expires_at are marked 'expired' (absence-neutral — no
 * score effect). Intended to be called on an interval by a worker/cron; kept as
 * a plain function so it can also be invoked from a script or a test.
 */
export async function sweepOutcomeNudges(limit = 50): Promise<NudgeSweepResult> {
  const result: NudgeSweepResult = { enabled: outcomeNudgeEnabled(), eligible: 0, sent: 0, errors: 0 };
  if (!result.enabled) return result;

  const nowIso = new Date().toISOString();
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // Expire the stale ones first (past the 7d window, never rated).
  await db
    .from('service_outcome_pending')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lt('expires_at', nowIso);

  const { data: rows, error } = await db
    .from('service_outcome_pending')
    .select('id, contract_id, provider_agent_id, buyer_agent_id')
    .eq('status', 'pending')
    .lte('eligible_at', nowIso)
    .gte('expires_at', nowIso)
    .limit(limit);

  if (error) {
    console.error('[outcome-notifier] sweep query failed:', error.message);
    return result;
  }
  result.eligible = rows?.length ?? 0;
  if (!chatId || !rows?.length) return result;

  for (const row of rows) {
    try {
      // Look up a friendly service name; fall back to the contract id.
      let serviceName = `contract ${String(row.contract_id).slice(0, 8)}`;
      try {
        const { data: c } = await db
          .from('service_contracts')
          .select('service_id, agent_services(service_type)')
          .eq('id', row.contract_id)
          .maybeSingle();
        const svcType = (c as any)?.agent_services?.service_type;
        if (typeof svcType === 'string' && svcType.trim()) serviceName = svcType;
      } catch { /* best-effort name; non-fatal */ }

      const html =
        `You used <b>${serviceName}</b> — did it hold up in use?\n` +
        `👍 good  ·  👌 ok  ·  👎 bad\n` +
        `<code>POST /api/v1/contracts/${row.contract_id}/outcome</code>`;

      const send = await sendTelegramMessage(chatId, html, {
        inline_keyboard: [[
          { text: '👍 good', callback_data: `t3_outcome:${row.contract_id}:good` },
          { text: '👌 ok', callback_data: `t3_outcome:${row.contract_id}:ok` },
          { text: '👎 bad', callback_data: `t3_outcome:${row.contract_id}:bad` },
        ]],
      });

      if (send.ok) {
        await db
          .from('service_outcome_pending')
          .update({ status: 'notified', notified_at: new Date().toISOString() })
          .eq('id', row.id);
        result.sent++;
      } else {
        result.errors++;
        console.error('[outcome-notifier] telegram send failed:', send.error);
      }
    } catch (e: any) {
      result.errors++;
      console.error('[outcome-notifier] nudge error:', e?.message ?? String(e));
    }
  }
  return result;
}
