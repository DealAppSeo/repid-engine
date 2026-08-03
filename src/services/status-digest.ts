/**
 * status-digest.ts — the thing the Controller app was supposed to be.
 *
 * One scheduled message that answers, in order of how much Sean actually cares:
 *   1. Is anyone out there who isn't us?
 *   2. Did the loop run, and did real money move?
 *   3. What needs a human?
 *
 * WHY THE FIRST SECTION IS FIRST, AND WHY IT WILL READ ZERO. The question that
 * prompted this was "is anyone trying it, or is it just bots?" npm download counts
 * cannot answer that — 386 downloads in 30 days, 318 of them on two consecutive
 * days across two packages simultaneously, is the signature of a publish event and
 * registry mirrors. Downloads measure fetches; they cannot distinguish a person
 * from a proxy.
 *
 * An authenticated API call can. A mirror cannot hold a key, register an agent, or
 * settle a contract. So this digest counts USE, not fetch, and says so — including
 * saying that npm is unmeasurable rather than quoting a number that flatters.
 *
 * HONESTY RULES THAT APPLY HERE AS MUCH AS TO ANY PUBLIC SURFACE. This report goes
 * to the person making decisions from it, which makes flattering it worse than
 * flattering a landing page:
 *   · "external" is a stated heuristic, not a fact, and the digest names it.
 *   · Zero is printed as zero. No "no new signups yet!" softening.
 *   · A number we cannot measure is labelled unmeasurable rather than omitted —
 *     an omitted row reads as "fine", a labelled one reads as "unknown".
 *   · The 104 "active agents" figure is NOT reported as a headline, because ~92 of
 *     them are our own mocks, smoke tests and April demo personas.
 */

import { db } from '../db';

/**
 * Is this agent plausibly not ours?
 *
 * A HEURISTIC, and the digest labels it as one. Everything we have ever created
 * follows a known naming shape, plus a set of April demo personas that predate the
 * convention. Anything else is worth a look — a false positive costs a glance, a
 * false negative hides the first real user.
 */
const OURS_PREFIXES = ['trinity-', 'smoke', 'test-agent', 'a7smoke', 'my_production', 'phase-n-', 'proda7'];
const OURS_EXACT = new Set(
  [
    'HUMAN', 'MEDIATOR', 'NEWCOMER', 'MENTOR', 'ORACLE', 'SAGE', 'RESEARCHER',
    'CONTRARIAN', 'SKEPTIC', 'GUARDIAN', 'SEAN', 'ATLAS', 'demo-openai-agent',
  ].map((s) => s.toLowerCase()),
);

export function looksExternal(agentName: string | null | undefined): boolean {
  const n = String(agentName ?? '').trim().toLowerCase();
  if (!n) return false;
  if (OURS_EXACT.has(n)) return false;
  return !OURS_PREFIXES.some((p) => n.startsWith(p));
}

export interface DigestData {
  generated_at: string;
  reach: {
    external_agents_all_time: number;
    external_agents_7d: number;
    self_serve_keys: number;
    npm_note: string;
  };
  loop: {
    settled_all_time: number;
    settled_24h: number;
    usdc_moved_24h: string;
    real_settlements_all_time: number;
    onchain_rep_writes: number;
  };
  money: {
    llm_spend_24h: string;
    llm_calls_24h: number;
    free_tier_pct: number | null;
  };
  alerts: string[];
}

function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

export async function buildDigest(): Promise<DigestData> {
  const alerts: string[] = [];

  // ── 1. reach ────────────────────────────────────────────────────────────
  const { data: agents } = await db
    .from('repid_agents')
    .select('agent_name, created_at')
    .eq('lifecycle_status', 'active');
  const externals = (agents ?? []).filter((a: any) => looksExternal(a.agent_name));
  const weekAgo = Date.now() - 7 * 864e5;
  const externals7d = externals.filter((a: any) => new Date(a.created_at).getTime() > weekAgo);

  const { count: selfServeKeys } = await db
    .from('agent_api_keys')
    .select('*', { count: 'exact', head: true })
    .eq('name', 'self-serve')
    .is('revoked_at', null);

  // ── 2. the loop ─────────────────────────────────────────────────────────
  const { count: settledAll } = await db
    .from('service_contracts')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'settled');
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const { count: settled24h } = await db
    .from('service_contracts')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'settled')
    .gte('settled_at', dayAgo);

  const { data: settle24 } = await db
    .from('x402_settlements')
    .select('amount')
    .eq('is_simulated', false)
    .eq('status', 'settled')
    .gte('delivered_at', dayAgo);
  const moved = (settle24 ?? []).reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0) / 1e6;

  const { count: realSettlements } = await db
    .from('x402_settlements')
    .select('*', { count: 'exact', head: true })
    .eq('is_simulated', false);
  const { count: repWrites } = await db
    .from('erc8004_reputation_writes')
    .select('*', { count: 'exact', head: true });

  // ── 3. money ────────────────────────────────────────────────────────────
  const { data: calls } = await db
    .from('llm_call_log')
    .select('cost_usd')
    .gte('created_at', dayAgo);
  const callRows = calls ?? [];
  const spend = callRows.reduce((s: number, r: any) => s + Number(r.cost_usd ?? 0), 0);
  const freeCalls = callRows.filter((r: any) => Number(r.cost_usd ?? 0) === 0).length;
  const freePct = callRows.length > 0 ? Math.round((freeCalls / callRows.length) * 100) : null;

  // ── 4. what needs a human ───────────────────────────────────────────────
  const { data: hitl } = await db
    .from('validation_queue')
    .select('created_at, metadata')
    .eq('status', 'processing');
  const hitlOld = (hitl ?? []).filter(
    (r: any) =>
      r.metadata?.hitl_request_id != null && Date.now() - new Date(r.created_at).getTime() > 864e5,
  ).length;
  if (hitlOld > 0) alerts.push(`${hitlOld} HITL item(s) waiting over 24h`);

  // Delivered and accepted, but the authorization is still unspent — the exact
  // state the release-retry worker exists to heal. If it appears here, the worker
  // is off or has given up.
  const { data: fulfilled } = await db
    .from('service_contracts')
    .select('id, buyer_satisfaction_score')
    .eq('status', 'fulfilled');
  const fulfilledIds = (fulfilled ?? [])
    .filter((c: any) => Number(c.buyer_satisfaction_score ?? 0) > 0)
    .map((c: any) => String(c.id));
  let stranded = 0;
  if (fulfilledIds.length > 0) {
    const { data: auths } = await db
      .from('x402_settlements')
      .select('idempotency_key')
      .eq('status', 'authorized')
      .in('idempotency_key', fulfilledIds);
    stranded = (auths ?? []).length;
  }
  if (stranded > 0) {
    alerts.push(`${stranded} delivered+accepted contract(s) UNPAID — provider is owed`);
  }

  const { count: failures } = await db
    .from('x402_settlement_failures')
    .select('*', { count: 'exact', head: true })
    .is('resolved_at', null);
  if ((failures ?? 0) > 0) alerts.push(`${failures} unresolved payment-release failure(s)`);

  // Proof-worthy backlog only. The ~40k churn rows are deliberately excluded.
  const { count: economicProofs } = await db
    .from('repid_proof_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending')
    .not('contract_id', 'is', null);
  if ((economicProofs ?? 0) > 0) {
    alerts.push(`${economicProofs} economic proof job(s) queued and unproven`);
  }

  return {
    generated_at: new Date().toISOString(),
    reach: {
      external_agents_all_time: externals.length,
      external_agents_7d: externals7d.length,
      self_serve_keys: selfServeKeys ?? 0,
      npm_note:
        'npm downloads are NOT a usage signal — mirrors, CI and scanners are counted and cannot be ' +
        'separated. Only authenticated use is countable, and that is the number above.',
    },
    loop: {
      settled_all_time: settledAll ?? 0,
      settled_24h: settled24h ?? 0,
      usdc_moved_24h: usd(moved),
      real_settlements_all_time: realSettlements ?? 0,
      onchain_rep_writes: repWrites ?? 0,
    },
    money: {
      llm_spend_24h: usd(spend),
      llm_calls_24h: callRows.length,
      free_tier_pct: freePct,
    },
    alerts,
  };
}

/**
 * Telegram HTML. Deliberately plain: a digest that needs decoding is a digest
 * nobody reads twice.
 */
export function renderDigest(d: DigestData): string {
  const L: string[] = [];
  const head = d.alerts.length === 0 ? '🟢' : '🟠';
  L.push(`${head} <b>HyperDAG status</b> — ${d.generated_at.slice(0, 16).replace('T', ' ')} UTC`);
  L.push('');

  L.push('<b>IS ANYONE OUT THERE</b>');
  L.push(`external agents: <b>${d.reach.external_agents_all_time}</b> all-time · ${d.reach.external_agents_7d} this week`);
  L.push(`self-serve keys issued: <b>${d.reach.self_serve_keys}</b>`);
  if (d.reach.external_agents_all_time === 0) {
    L.push('<i>nobody outside the project has registered an agent yet</i>');
  }
  L.push('');

  L.push('<b>THE LOOP</b>');
  L.push(`settled contracts: <b>${d.loop.settled_all_time}</b> all-time · ${d.loop.settled_24h} in 24h`);
  L.push(`real USDC moved (24h): <b>${d.loop.usdc_moved_24h}</b>`);
  L.push(`on-chain reputation writes: ${d.loop.onchain_rep_writes}`);
  L.push('');

  L.push('<b>COST</b>');
  L.push(
    `LLM: ${d.money.llm_spend_24h} over ${d.money.llm_calls_24h} calls` +
      (d.money.free_tier_pct != null ? ` · ${d.money.free_tier_pct}% free tier` : ''),
  );
  L.push('');

  if (d.alerts.length === 0) {
    L.push('<b>NEEDS YOU</b>');
    L.push('nothing.');
  } else {
    L.push('<b>⚠ NEEDS YOU</b>');
    for (const a of d.alerts) L.push(`• ${a}`);
  }
  L.push('');
  L.push(`<i>"external" is a naming heuristic, not proof. ${d.reach.npm_note}</i>`);

  return L.join('\n');
}

/** Build it, send it. Returns the digest so the cron log carries the numbers. */
export async function runStatusDigest(): Promise<{ sent: boolean; digest: DigestData; error?: string }> {
  const digest = await buildDigest();
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.warn('[status-digest] TELEGRAM_CHAT_ID not set — digest built but not sent');
    return { sent: false, digest, error: 'TELEGRAM_CHAT_ID not configured' };
  }
  const { sendTelegramMessage } = await import('../routes/telegram.js');
  const r = await sendTelegramMessage(chatId, renderDigest(digest));
  if (!r.ok) console.warn(`[status-digest] telegram send failed: ${r.error}`);
  return { sent: r.ok, digest, error: r.error };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * In-process daily scheduler.
 *
 * WHY NOT THE CRON ENDPOINT. /internal-cron/status-digest exists and works, but it
 * needs CRON_TRIGGER_TOKEN set plus an external monitor to call it — and the
 * evidence says that path is not in use: repid_telemetry_snapshots holds exactly
 * ONE cron_trigger row ever, from 2026-05-26. Wiring the digest to a trigger
 * nobody pulls would mean shipping a report that never arrives.
 *
 * The engine already runs its own schedulers (HITL expiration, release retry), so
 * this needs no secret and no third party. The endpoint stays for whenever an
 * external scheduler is actually wired.
 *
 * IDEMPOTENT ACROSS RESTARTS. A redeploy must not re-send today's digest — a
 * report that arrives twice trains you to skim it. The last-sent time lives in
 * repid_telemetry_snapshots, the same table the cron handler uses, so both paths
 * share one notion of "already sent today".
 */
const DIGEST_TRIGGER = 'status-digest';
const DIGEST_MIN_INTERVAL_MS = 23 * 60 * 60 * 1000;

export const STATUS_DIGEST_ENABLED = process.env.STATUS_DIGEST_ENABLED === 'true';

async function lastDigestAt(): Promise<number | null> {
  try {
    const { data } = await db
      .from('repid_telemetry_snapshots')
      .select('snapshot_at')
      .eq('metric_family', 'cron_trigger')
      .eq('metric_name', DIGEST_TRIGGER)
      .order('snapshot_at', { ascending: false })
      .limit(1);
    const at = (data ?? [])[0]?.snapshot_at;
    return at ? new Date(at).getTime() : null;
  } catch {
    // Unreadable history → err toward NOT sending. A missed digest is recoverable
    // tomorrow; a duplicate one costs the report its credibility.
    return Date.now();
  }
}

export async function maybeSendDigest(): Promise<{ sent: boolean; reason?: string }> {
  const last = await lastDigestAt();
  if (last != null && Date.now() - last < DIGEST_MIN_INTERVAL_MS) {
    return { sent: false, reason: 'already sent within the window' };
  }
  const r = await runStatusDigest();
  try {
    await db.from('repid_telemetry_snapshots').insert({
      snapshot_at: new Date().toISOString(),
      metric_family: 'cron_trigger',
      metric_name: DIGEST_TRIGGER,
      metric_value: { ok: r.sent, summary: r.digest, error: r.error ?? null },
      metadata: { snapshot_type: 'cron_trigger', source: 'in-process-scheduler' },
    });
  } catch {
    /* logging is best-effort; the digest already went out */
  }
  return { sent: r.sent, reason: r.error };
}

let digestTimer: NodeJS.Timeout | null = null;

export function startStatusDigest(): { stop: () => void } {
  if (!STATUS_DIGEST_ENABLED) {
    console.log('[status-digest] disabled (STATUS_DIGEST_ENABLED not true), skipping');
    return { stop: () => undefined };
  }
  // Check hourly, send at most daily. Hourly ticks make the send time robust to
  // restarts without needing to persist a schedule.
  const everyMs = Number(process.env.STATUS_DIGEST_CHECK_MS ?? 60 * 60 * 1000);
  console.log(`[status-digest] enabled — checking every ${Math.round(everyMs / 60000)}m, sending at most daily`);

  let running = false;
  digestTimer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await maybeSendDigest();
      if (r.sent) console.log('[status-digest] sent');
    } catch (e) {
      console.error('[status-digest] scheduler threw:', e);
    } finally {
      running = false;
    }
  }, everyMs);

  return {
    stop: () => {
      if (digestTimer) clearInterval(digestTimer);
      digestTimer = null;
    },
  };
}
