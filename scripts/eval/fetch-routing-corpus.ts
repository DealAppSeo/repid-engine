/**
 * fetch-routing-corpus.ts — materialise the joined (decision -> outcome) corpus as JSON.
 *
 * READ-ONLY. Two SELECTs, no writes, no DDL. Output feeds
 *   npx ts-node scripts/eval/anfis-lasso.ts --joined <out.json>
 *
 * THE JOIN
 * --------
 * `routing_decision_records` (decision features) LEFT JOIN `llm_call_log` (outcome) on
 * (call_id, provider). The join is done in this process rather than in SQL because
 * supabase-js has no join for two tables without a declared foreign key, and declaring one
 * would be schema change on `llm_call_log` — which this lane deliberately does not touch.
 *
 * LEFT, not INNER, and that matters. A decision with no matching outcome row is an
 * UNOBSERVED decision, not a failed one. It is emitted with `status: null` and dropped —
 * and COUNTED — by `buildRoutingCorpus`. An inner join would make the loss invisible.
 *
 * USAGE
 *   export SUPABASE_URL=... SUPABASE_SERVICE_KEY=...
 *   npx ts-node scripts/eval/fetch-routing-corpus.ts [out.json] [--since 2026-08-01]
 */

import * as fs from 'fs';
import * as path from 'path';
import { db } from '../../src/db';
import type { JoinedRoutingRow } from '../../src/decisioning/routing-corpus';

const DECISION_COLUMNS = [
  'call_id',
  'provider',
  'attempt',
  'chosen_tier',
  'chosen_cost_class',
  'reason',
  'chosen_position',
  'chain_len',
  'free_first_violated',
  'n_free_usable',
  'n_paid_usable',
  'n_unhealthy',
  'n_keyless',
  'n_cap_hit',
  'n_disabled',
  'n_excluded',
  'created_at',
].join(',');

const PAGE = 1000;

async function fetchDecisions(since?: string): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from('routing_decision_records')
      .select(DECISION_COLUMNS)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (since) q = q.gte('created_at', since);
    const { data, error } = await q;
    if (error) throw new Error(`routing_decision_records read failed: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** Outcome side, fetched by call_id in chunks so the IN list stays sane. */
async function fetchOutcomes(callIds: string[]): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  const CHUNK = 200;
  for (let i = 0; i < callIds.length; i += CHUNK) {
    const slice = callIds.slice(i, i + CHUNK);
    const { data, error } = await db
      .from('llm_call_log')
      .select('call_id,provider,status')
      .in('call_id', slice);
    if (error) throw new Error(`llm_call_log read failed: ${error.message}`);
    for (const r of data ?? []) {
      byKey.set(`${(r as any).call_id}|${(r as any).provider}`, (r as any).status);
    }
  }
  return byKey;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sinceIdx = argv.indexOf('--since');
  const since = sinceIdx >= 0 ? argv[sinceIdx + 1] : undefined;
  const outPath = path.resolve(argv.find((a) => !a.startsWith('--') && a !== since) ?? 'routing-corpus.json');

  const decisions = await fetchDecisions(since);
  console.log(`[fetch-routing-corpus] decision rows: ${decisions.length}`);
  if (decisions.length === 0) {
    // FAIL LOUD. An empty file that later fits to "no signal" is far worse than a stop here.
    console.error('[fetch-routing-corpus] NOT CHECKED — routing_decision_records is empty.');
    console.error('  The migration may be unapplied, or ROUTING_RECORD_PERSIST is off (its default).');
    process.exit(2);
  }

  const callIds = [...new Set(decisions.map((d) => d.call_id))];
  const outcomes = await fetchOutcomes(callIds);

  const rows: JoinedRoutingRow[] = decisions.map((d) => ({
    call_id: d.call_id,
    provider: d.provider,
    attempt: d.attempt,
    chosen_tier: d.chosen_tier,
    chosen_cost_class: d.chosen_cost_class,
    reason: d.reason,
    chosen_position: d.chosen_position ?? null,
    chain_len: d.chain_len,
    free_first_violated: !!d.free_first_violated,
    n_free_usable: d.n_free_usable,
    n_paid_usable: d.n_paid_usable,
    n_unhealthy: d.n_unhealthy,
    n_keyless: d.n_keyless,
    n_cap_hit: d.n_cap_hit,
    n_disabled: d.n_disabled,
    n_excluded: d.n_excluded,
    status: outcomes.get(`${d.call_id}|${d.provider}`) ?? null,
  }));

  const matched = rows.filter((r) => r.status !== null).length;
  const payload = {
    meta: {
      fetched_at: new Date().toISOString(),
      since: since ?? null,
      decision_rows: rows.length,
      matched_outcome_rows: matched,
      unmatched_rows: rows.length - matched,
      join_key: '(call_id, provider)',
    },
    rows,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(
    `[fetch-routing-corpus] wrote ${outPath} — ${rows.length} decisions, ` +
      `${matched} with an outcome, ${rows.length - matched} UNOBSERVED (dropped at fit time)`,
  );
}

main().catch((e) => {
  console.error('[fetch-routing-corpus] failed:', e?.message ?? e);
  process.exit(1);
});
