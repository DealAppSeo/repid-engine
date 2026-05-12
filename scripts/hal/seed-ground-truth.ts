/**
 * CC Sprint 10 Phase 5 — HAL ground-truth label seeding tooling.
 *
 * IMPORTANT (schema reality vs sprint-dispatcher assumption):
 *   The sprint plan assumed a `prompt_id` column. The real hal_ground_truth_labels
 *   schema uses a 3-COLUMN COMPOUND UNIQUE: (source_table, source_id, labeled_by).
 *   This is actually cleaner — it permits multiple labelers for the same row, so
 *   human + LLM-judge labels can coexist for the same hal_runner_results entry.
 *
 *   CSV columns expected: source_table, source_id, is_hallucination,
 *                         ground_truth_confidence, labeled_by, rationale
 *
 * Modes:
 *   --from-csv <path>          Seed from CSV (UPSERT on the 3-col compound key).
 *   --from-runner-results --interactive
 *                              Walk recent hal_runner_results rows; prompt Sean.
 *   --export-template <path>   Write a CSV template with headers.
 *   --stats                    Show current label count + breakdown by labeled_by.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../../src/config';

const VALID_SOURCE_TABLES = new Set(['hal_runner_results', 'hal_evaluations', 'hal_classifications']);

interface CsvRow {
  source_table: string;
  source_id: string;
  is_hallucination: boolean;
  ground_truth_confidence: number;
  labeled_by: string;
  rationale: string | null;
}

export function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0]!.split(',').map((s) => s.trim().toLowerCase());
  const idx = {
    source_table: header.indexOf('source_table'),
    source_id: header.indexOf('source_id'),
    is_hallucination: header.indexOf('is_hallucination'),
    ground_truth_confidence: header.indexOf('ground_truth_confidence'),
    labeled_by: header.indexOf('labeled_by'),
    rationale: header.indexOf('rationale'),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0 && k !== 'rationale') throw new Error(`CSV missing required column: ${k}`);
  }
  const out: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const sourceTable = cells[idx.source_table]?.trim() ?? '';
    if (!VALID_SOURCE_TABLES.has(sourceTable)) {
      throw new Error(`Row ${i + 1}: invalid source_table='${sourceTable}'. Allowed: ${[...VALID_SOURCE_TABLES].join(', ')}`);
    }
    const confRaw = cells[idx.ground_truth_confidence]?.trim() ?? '';
    const conf = Number(confRaw);
    if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
      throw new Error(`Row ${i + 1}: ground_truth_confidence must be 0..1, got '${confRaw}'`);
    }
    const isHallStr = (cells[idx.is_hallucination]?.trim() ?? '').toLowerCase();
    if (!['true', 'false', 't', 'f', '1', '0', 'yes', 'no'].includes(isHallStr)) {
      throw new Error(`Row ${i + 1}: is_hallucination must be true/false, got '${isHallStr}'`);
    }
    out.push({
      source_table: sourceTable,
      source_id: cells[idx.source_id]?.trim() ?? '',
      is_hallucination: ['true', 't', '1', 'yes'].includes(isHallStr),
      ground_truth_confidence: conf,
      labeled_by: cells[idx.labeled_by]?.trim() ?? '',
      rationale: idx.rationale >= 0 ? (cells[idx.rationale]?.trim() ?? null) : null,
    });
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = ''; let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuote = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"' && cur.length === 0) inQuote = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

export const TEMPLATE_CSV = [
  'source_table,source_id,is_hallucination,ground_truth_confidence,labeled_by,rationale',
  '# Valid source_table values: hal_runner_results | hal_evaluations | hal_classifications',
  '# is_hallucination: true | false',
  '# ground_truth_confidence: 0.0 .. 1.0',
  '# labeled_by: short identifier (e.g., sean, gpt4-judge, automated-spot-check)',
  '# rationale: free-text optional',
  '# Example rows below — delete the # to enable:',
  '# hal_runner_results,abc-123,true,0.95,sean,"Made up a fake API endpoint"',
  '# hal_runner_results,def-456,false,0.80,sean,"Statement matches public knowledge"',
  '',
].join('\n');

export interface StatsSummary {
  total: number;
  by_labeled_by: Array<{ labeled_by: string; cnt: number }>;
  by_source_table: Array<{ source_table: string; cnt: number }>;
  by_is_hallucination: Array<{ is_hallucination: boolean; cnt: number }>;
}

export function formatStats(s: StatsSummary): string {
  const lines: string[] = [];
  lines.push(`HAL ground-truth labels: ${s.total} total`);
  if (s.total === 0) {
    lines.push('  (no labels yet; export a template + populate to start)');
    return lines.join('\n');
  }
  lines.push('  by labeled_by:');
  for (const r of s.by_labeled_by) lines.push(`    ${r.labeled_by.padEnd(28)} ${r.cnt}`);
  lines.push('  by source_table:');
  for (const r of s.by_source_table) lines.push(`    ${r.source_table.padEnd(28)} ${r.cnt}`);
  lines.push('  by is_hallucination:');
  for (const r of s.by_is_hallucination) lines.push(`    ${String(r.is_hallucination).padEnd(28)} ${r.cnt}`);
  return lines.join('\n');
}

async function getStats(db: SupabaseClient): Promise<StatsSummary> {
  const { count } = await db.from('hal_ground_truth_labels').select('*', { count: 'exact', head: true });
  if (!count) {
    return { total: 0, by_labeled_by: [], by_source_table: [], by_is_hallucination: [] };
  }
  const { data } = await db.from('hal_ground_truth_labels').select('labeled_by, source_table, is_hallucination');
  const byLabeled = new Map<string, number>();
  const bySource = new Map<string, number>();
  const byHall = new Map<boolean, number>();
  for (const r of (data ?? []) as any[]) {
    byLabeled.set(r.labeled_by, (byLabeled.get(r.labeled_by) ?? 0) + 1);
    bySource.set(r.source_table, (bySource.get(r.source_table) ?? 0) + 1);
    byHall.set(r.is_hallucination, (byHall.get(r.is_hallucination) ?? 0) + 1);
  }
  return {
    total: count,
    by_labeled_by: [...byLabeled.entries()].map(([labeled_by, cnt]) => ({ labeled_by, cnt })).sort((a, b) => b.cnt - a.cnt),
    by_source_table: [...bySource.entries()].map(([source_table, cnt]) => ({ source_table, cnt })).sort((a, b) => b.cnt - a.cnt),
    by_is_hallucination: [...byHall.entries()].map(([is_hallucination, cnt]) => ({ is_hallucination, cnt })),
  };
}

async function seedFromCsv(csvPath: string, db: SupabaseClient): Promise<{ inserted: number; updated: number; errors: string[] }> {
  const text = fs.readFileSync(csvPath, 'utf-8');
  const rows = parseCsv(text);
  console.log(`[seed] parsed ${rows.length} rows from ${csvPath}`);
  const out = { inserted: 0, updated: 0, errors: [] as string[] };
  for (const r of rows) {
    const { error, data } = await db.from('hal_ground_truth_labels').upsert(
      { ...r },
      { onConflict: 'source_table,source_id,labeled_by' },
    ).select('id').single();
    if (error) { out.errors.push(`(${r.source_table},${r.source_id},${r.labeled_by}) — ${error.message}`); continue; }
    if (data) out.inserted++;
  }
  return out;
}

async function seedInteractive(db: SupabaseClient, labeledBy: string): Promise<{ labeled: number; skipped: number }> {
  const { data: rows } = await db.from('hal_runner_results')
    .select('id, run_id, prompt_id, generated_answer, hal_score, hal_vetoed, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (!rows || rows.length === 0) { console.log('[seed] no hal_runner_results to label'); return { labeled: 0, skipped: 0 }; }
  const { data: existing } = await db.from('hal_ground_truth_labels')
    .select('source_id')
    .eq('source_table', 'hal_runner_results')
    .eq('labeled_by', labeledBy);
  const already = new Set<string>((existing ?? []).map((r: any) => r.source_id));
  const toLabel = (rows as any[]).filter((r) => !already.has(r.id));
  console.log(`[seed] ${toLabel.length} candidate hal_runner_results rows not yet labeled by ${labeledBy}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
  let labeled = 0, skipped = 0;
  try {
    for (const r of toLabel) {
      console.log('\n────────────────────────────────────────');
      console.log(`run_id:    ${r.run_id}`);
      console.log(`prompt_id: ${r.prompt_id}`);
      console.log(`hal_score: ${r.hal_score}   vetoed: ${r.hal_vetoed}`);
      console.log(`answer:    ${String(r.generated_answer ?? '').slice(0, 240)}`);
      const ans = (await ask('Is this a hallucination? [y]es / [n]o / [s]kip / [q]uit: ')).trim().toLowerCase();
      if (ans === 'q') break;
      if (ans === 's' || ans === '') { skipped++; continue; }
      if (ans !== 'y' && ans !== 'n') { console.log('  (unrecognized; skipped)'); skipped++; continue; }
      const confStr = (await ask('Confidence 0..1 (default 0.9): ')).trim();
      const conf = confStr === '' ? 0.9 : Number(confStr);
      if (!Number.isFinite(conf) || conf < 0 || conf > 1) { console.log('  (bad confidence; skipped)'); skipped++; continue; }
      const rationale = (await ask('Rationale (optional, ENTER to skip): ')).trim() || null;
      const { error } = await db.from('hal_ground_truth_labels').upsert(
        {
          source_table: 'hal_runner_results',
          source_id: r.id,
          is_hallucination: ans === 'y',
          ground_truth_confidence: conf,
          labeled_by: labeledBy,
          rationale,
        },
        { onConflict: 'source_table,source_id,labeled_by' },
      );
      if (error) { console.log(`  insert failed: ${error.message}`); skipped++; continue; }
      labeled++;
      console.log(`  ✓ labeled (${labeled} total this session)`);
    }
  } finally {
    rl.close();
  }
  return { labeled, skipped };
}

interface CliArgs {
  mode: 'stats' | 'export-template' | 'from-csv' | 'from-runner-results' | 'help';
  path?: string;
  labeledBy?: string;
  interactive: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { mode: 'help', interactive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stats') out.mode = 'stats';
    else if (a === '--export-template') { out.mode = 'export-template'; out.path = argv[++i]; }
    else if (a === '--from-csv') { out.mode = 'from-csv'; out.path = argv[++i]; }
    else if (a === '--from-runner-results') { out.mode = 'from-runner-results'; }
    else if (a === '--interactive') { out.interactive = true; }
    else if (a === '--labeled-by') { out.labeledBy = argv[++i]; }
  }
  return out;
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const db = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });

    if (args.mode === 'stats') {
      const s = await getStats(db); console.log(formatStats(s)); return;
    }
    if (args.mode === 'export-template') {
      if (!args.path) { console.error('--export-template requires a path'); process.exit(2); }
      fs.writeFileSync(args.path, TEMPLATE_CSV, 'utf-8');
      console.log(`Wrote template to ${path.resolve(args.path)}`);
      return;
    }
    if (args.mode === 'from-csv') {
      if (!args.path) { console.error('--from-csv requires a path'); process.exit(2); }
      const r = await seedFromCsv(args.path, db);
      console.log(`Inserted/Upserted: ${r.inserted}  Errors: ${r.errors.length}`);
      for (const e of r.errors) console.log(`  ERR: ${e}`);
      return;
    }
    if (args.mode === 'from-runner-results' && args.interactive) {
      const labeledBy = args.labeledBy ?? 'sean';
      const r = await seedInteractive(db, labeledBy);
      console.log(`\nInteractive session done: labeled=${r.labeled} skipped=${r.skipped}`);
      return;
    }
    console.log(`Usage:
  --stats
  --export-template <path>
  --from-csv <path>
  --from-runner-results --interactive [--labeled-by <name>]

CSV columns: source_table, source_id, is_hallucination, ground_truth_confidence, labeled_by, rationale
Uniqueness: (source_table, source_id, labeled_by)
`);
  })().catch((e) => { console.error('seed-ground-truth crashed:', e); process.exit(1); });
}
