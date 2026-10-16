/**
 * RepID delta-conformance checker — READ-ONLY. Compares every recent repid_score_events row with
 * the delta the code says it should carry (src/scoring/delta-conformance.ts) and lists each deviation.
 *
 *   npx ts-node scripts/repid/delta-conformance.ts --live [--days 7] [--out report.json]
 *       SELECTs only (repid_score_events + service_contracts for the deliverable verdict), with the
 *       engine's own client. Needs SUPABASE_URL + a service key, exactly like the engine.
 *   npx ts-node scripts/repid/delta-conformance.ts --json rows.json [--out report.json]
 *       Rows from a file, for an agent that can SELECT but not hold a key. Produce them with:
 *         SELECT e.id, e.event_type, e.delta, e.repid_before, e.repid_after, e.repid_delta_calculated,
 *                e.repid_delta_applied, e.hal_decision, e.hal_score, e.hallucination_caught, e.is_shadow,
 *                e.metadata, e.contract_id, e.created_at,
 *                c.result->>'verdict' AS contract_verdict, (c.result->>'confident')::boolean AS contract_confident
 *         FROM repid_score_events e LEFT JOIN service_contracts c ON c.id = e.contract_id
 *         WHERE e.created_at > now() - interval '7 days' ORDER BY e.id;
 *       (--json cannot see the x402 simulated flag; a 0-delta row on a simulated contract then reads
 *       as a deviation. --live resolves it.)
 *
 * Exit 0 = every checked row conforms · 1 = at least one deviation · 2 = could not run.
 * NOT_CHECKED rows are listed with their reason and never counted as conforming.
 * Daily schedule: run with --live from any host that already holds the engine env (a cron is Sean's
 * to add — Railway is not this script's to touch).
 */
import { readFileSync, writeFileSync } from 'fs';
import { checkRows, DELTA_SPEC, type ScoreEventRow, type ConformanceReport } from '../../src/scoring/delta-conformance';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fromFlat(r: any): ScoreEventRow {
  const { contract_verdict, contract_confident, contract_simulated, ...rest } = r;
  const contract = r.contract ?? (r.contract_id
    ? { verdict: contract_verdict ?? null, confident: contract_confident ?? null, simulated: contract_simulated ?? null }
    : null);
  return { ...rest, metadata: typeof rest.metadata === 'string' ? JSON.parse(rest.metadata) : rest.metadata, contract };
}

async function liveRows(days: number): Promise<ScoreEventRow[]> {
  const { db } = await import('../../src/db');
  const { contractRowIsSimulated } = await import('../../src/services/validation-repid-delta');
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('repid_score_events')
      .select('id, event_type, delta, repid_before, repid_after, repid_delta_calculated, repid_delta_applied, hal_decision, hal_score, hallucination_caught, is_shadow, metadata, contract_id, created_at')
      .gte('created_at', since).order('id').range(from, from + 999);
    if (error) throw new Error(`SELECT repid_score_events failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const ids = [...new Set(rows.map((r) => r.contract_id).filter(Boolean))];
  const contracts = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from('service_contracts')
      .select('id, result, metadata, payload, x402_payment_id').in('id', ids.slice(i, i + 200));
    if (error) throw new Error(`SELECT service_contracts failed: ${error.message}`);
    for (const c of data ?? []) contracts.set(c.id, c);
  }
  return Promise.all(rows.map(async (r) => {
    const c = r.contract_id ? contracts.get(r.contract_id) : undefined;
    return {
      ...r,
      contract: c ? { verdict: c.result?.verdict ?? null, confident: c.result?.confident ?? null, simulated: await contractRowIsSimulated(c) } : null,
    } as ScoreEventRow;
  }));
}

export function renderMarkdown(rep: ConformanceReport, label: string): string {
  const lines = [
    `# RepID delta conformance — ${label}`,
    '',
    `rows ${rep.rows} · verdicts ${rep.verdicts} · CONFORMS ${rep.conforms} · DEVIATES ${rep.deviates} · NOT_CHECKED ${rep.not_checked}`,
    '',
    '## Spec (rendered from the constants the writers use)',
    '| check | event | rule | source |',
    '|---|---|---|---|',
    ...DELTA_SPEC.map((s) => `| ${s.check} | ${s.event} | ${s.rule} | ${s.source} |`),
    '',
    '## Per check',
    '| check | CONFORMS | DEVIATES | NOT_CHECKED |',
    '|---|---|---|---|',
    ...Object.entries(rep.by_check).sort().map(([k, c]) => `| ${k} | ${c.CONFORMS} | ${c.DEVIATES} | ${c.NOT_CHECKED} |`),
    '',
    '## Deviations',
    ...(rep.deviations.length ? rep.deviations.map((d) => `- #${d.id} ${d.event_type} [${d.check}] ${d.reason}`) : ['- none']),
    '',
    '## Not checked',
    ...(rep.not_checked_rows.length ? rep.not_checked_rows.map((d) => `- #${d.id} ${d.event_type} [${d.check}] ${d.reason}`) : ['- none']),
  ];
  return lines.join('\n');
}

async function main(): Promise<number> {
  const json = arg('--json');
  const days = Number(arg('--days') ?? 7);
  let rows: ScoreEventRow[];
  if (json) rows = (JSON.parse(readFileSync(json, 'utf8')) as any[]).map(fromFlat);
  else if (process.argv.includes('--live')) rows = await liveRows(days);
  else { console.error('usage: --live [--days N] | --json rows.json  [--out report.json]'); return 2; }

  const rep = checkRows(rows);
  console.log(renderMarkdown(rep, json ? `rows from ${json}` : `last ${days} days (live SELECT)`));
  const out = arg('--out');
  if (out) writeFileSync(out, JSON.stringify(rep, null, 2));
  return rep.deviates > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(`[delta-conformance] could not run: ${e?.message ?? e}`); process.exit(2); });
}
