/**
 * paid-tail-cost-order.ts — the canary for the cost-ordered tier-0 paid tail.
 *
 * WHAT CHANGED, AND WHY THIS EXISTS
 * ---------------------------------
 * `orderPaidTailByCost` (src/providers/router.ts) reorders the PAID tier-0 tail
 * cheapest-first, which swaps deepseek (0.27/1.10) ahead of cohere (0.50/1.50).
 * Nothing else about routing moves: same providers, same presence, same health and
 * cap logic — only the sequence in which the two dearest tier-0 providers are tried.
 *
 * This script reports what actually happened afterwards, so the change is MEASURED
 * rather than assumed. It reads `llm_call_log`, which is live and already carries
 * provider / model / cost_usd / status / created_at on every call.
 *
 * WHY NOT routing_decision_records: that table would give a per-decision arm label,
 * and it is the right long-term home — but its migration
 * (migrations/2026_08_17_routing_decision_records.sql) is UNAPPLIED. Reading a table
 * that does not exist would report "no data" as if it were "no effect". So this uses
 * the ledger that is genuinely there.
 *
 * WHAT THIS CAN AND CANNOT SAY
 * ----------------------------
 * It CAN say: how many calls each provider served in a window, at what cost, and
 * whether the cohere/deepseek split moved in the direction the change predicts.
 *
 * It CANNOT say the change CAUSED that. Traffic mix, provider health and prompt shape
 * all move on their own, and this is a before/after over time rather than a
 * randomised split — a real A/B needs the per-decision arm label above. The output
 * says so rather than implying causation, because a canary that overstates is worse
 * than no canary.
 *
 * EXIT CODES — the repo convention, three outcomes and never two:
 *   0  VERIFIED     — a window with calls in it was read and summarised.
 *   2  NOT_CHECKED  — no credentials, or no rows in the window. NOT "no effect".
 *   1  FAILED       — the query itself errored.
 *
 * USAGE
 *   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… npx ts-node scripts/canary/paid-tail-cost-order.ts
 *   … --since 2026-08-20T22:00:00Z    # cutover instant; splits the window before/after
 *   … --days 7                        # lookback (default 7)
 *
 * ROLLBACK, if the canary looks wrong: set ROUTER_PAID_TAIL_COST_ORDER=false on the
 * repid-engine service and redeploy. That restores gemini > cohere > deepseek exactly.
 */

import { createClient } from '@supabase/supabase-js';

/** The two providers whose relative order this change actually moved. */
const SWAPPED = ['deepseek', 'cohere'] as const;

interface CallRow {
  provider: string | null;
  cost_usd: number | null;
  status: string | null;
  created_at: string | null;
}

interface Bucket {
  calls: number;
  cost: number;
  ok: number;
}

/**
 * Did the request fail to REACH the database, as opposed to being rejected by it?
 *
 * Deliberately a small allowlist of transport signatures rather than a catch-all: an
 * unrecognised error stays FAILED, so a genuine query fault is never quietly downgraded
 * to "we did not look". Erring toward FAILED is the safe direction here — it prompts a
 * human to look, where a wrong NOT_CHECKED just goes unread.
 */
function isTransportError(message: string): boolean {
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network|socket hang up/i.test(
    message,
  );
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function tally(rows: CallRow[]): Map<string, Bucket> {
  const out = new Map<string, Bucket>();
  for (const r of rows) {
    const p = (r.provider ?? 'unknown').toLowerCase();
    const b = out.get(p) ?? { calls: 0, cost: 0, ok: 0 };
    b.calls += 1;
    b.cost += r.cost_usd ?? 0;
    if ((r.status ?? '').toLowerCase() === 'success') b.ok += 1;
    out.set(p, b);
  }
  return out;
}

function render(label: string, rows: CallRow[]): void {
  const t = tally(rows);
  if (t.size === 0) {
    console.log(`  ${label}: no calls`);
    return;
  }
  const total = rows.length;
  console.log(`  ${label} — ${total} calls`);
  const ordered = [...t.entries()].sort((a, b) => b[1].calls - a[1].calls);
  for (const [provider, b] of ordered) {
    const share = ((b.calls / total) * 100).toFixed(1).padStart(5);
    const okPct = b.calls > 0 ? ((b.ok / b.calls) * 100).toFixed(0) : '—';
    const mark = (SWAPPED as readonly string[]).includes(provider) ? ' <-- reordered' : '';
    console.log(
      `    ${provider.padEnd(12)} ${String(b.calls).padStart(6)} calls  ${share}%  ` +
        `$${b.cost.toFixed(4).padStart(9)}  ok ${okPct}%${mark}`,
    );
  }
}

/** The one comparison this change actually predicts: deepseek should be tried before cohere. */
function swapSummary(label: string, rows: CallRow[]): string {
  const t = tally(rows);
  const d = t.get('deepseek')?.calls ?? 0;
  const c = t.get('cohere')?.calls ?? 0;
  if (d + c === 0) return `  ${label}: neither reordered provider was reached — nothing to compare`;
  const pct = ((d / (d + c)) * 100).toFixed(1);
  return `  ${label}: deepseek ${d} vs cohere ${c} — deepseek is ${pct}% of the reordered pair`;
}

async function main(): Promise<number> {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.log('NOT_CHECKED — SUPABASE_URL and a service key are required to read llm_call_log.');
    return 2;
  }

  const days = Number(arg('days') ?? 7);
  const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const cutover = arg('since');

  const db = createClient(url, key);
  const { data, error } = await db
    .from('llm_call_log')
    .select('provider, cost_usd, status, created_at')
    .gte('created_at', windowStart)
    .order('created_at', { ascending: true })
    .limit(50_000);

  if (error) {
    // TRANSPORT failure is NOT_CHECKED, not FAILED. "We could not reach the ledger" and
    // "the ledger says the change went wrong" are different facts, and a canary that
    // reports the first as the second would send someone rolling back a healthy change.
    // A rejected QUERY (missing table, RLS, bad column) is a real failure and stays 1.
    if (isTransportError(error.message)) {
      console.log(`NOT_CHECKED — could not reach the database: ${error.message}`);
      console.log('This says nothing about the routing change. Re-run with reachable credentials.');
      return 2;
    }
    console.error(`FAILED — llm_call_log query errored: ${error.message}`);
    return 1;
  }

  const rows = (data ?? []) as CallRow[];
  console.log(`=== PAID-TAIL COST-ORDER CANARY — last ${days}d since ${windowStart} ===\n`);

  if (rows.length === 0) {
    console.log('NOT_CHECKED — the window contains no calls.');
    console.log('That is an ABSENCE of observation, not evidence the change had no effect.');
    return 2;
  }

  if (cutover) {
    const before = rows.filter((r) => (r.created_at ?? '') < cutover);
    const after = rows.filter((r) => (r.created_at ?? '') >= cutover);
    console.log(`Cutover: ${cutover}\n`);
    render('BEFORE', before);
    console.log('');
    render('AFTER', after);
    console.log('');
    console.log(swapSummary('BEFORE', before));
    console.log(swapSummary('AFTER ', after));
    if (before.length === 0 || after.length === 0) {
      console.log('\nNOT_CHECKED — one side of the cutover is empty; no comparison is possible.');
      return 2;
    }
  } else {
    render('WINDOW', rows);
    console.log('');
    console.log(swapSummary('WINDOW', rows));
    console.log('\n(no --since given, so this is a single window, not a before/after)');
  }

  console.log(
    '\nVERIFIED — the window was read and summarised. This is an OBSERVATION, not a\n' +
      'causal claim: traffic mix and provider health move independently of the routing\n' +
      'change, and this is a before/after over time rather than a randomised split.\n' +
      'Rollback: ROUTER_PAID_TAIL_COST_ORDER=false on the repid-engine service.',
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`FAILED — ${(e as Error).message}`);
    process.exit(1);
  });
