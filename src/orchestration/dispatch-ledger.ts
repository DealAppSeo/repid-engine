/**
 * dispatch-ledger.ts — the capability ledger: what each lane has actually been shown to do.
 *
 * Append-only JSONL, one row per finished ticket. Aggregates (n, verified pass rate, median time,
 * cost, top failure reasons) are derived from the rows, never stored, so a row cannot be edited
 * into a better record. Keyed by task class × runner × model version × packet version.
 *
 * A pass counts only when someone OTHER than the runner verified it. A self-reported pass is
 * counted in n and never in the pass rate.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export type Outcome = 'pass' | 'fail' | 'not_checked';

export interface LedgerRow {
  at: string;
  task_id: string;
  task_class: string;
  runner: string;
  model_version: string;
  packet_version: string;
  outcome: Outcome;
  /** Who checked the outcome. A pass with no verifier, or verified by the runner itself, is not a verified pass. */
  verified_by: string | null;
  duration_ms: number;
  cost_usd: number;
  failure_reason?: string;
}

export interface LaneKey {
  task_class: string;
  runner: string;
  model_version: string;
  packet_version: string;
}

export interface LaneSummary extends LaneKey {
  n: number;
  verified_passes: number;
  verified_pass_rate: number;
  median_ms: number;
  mean_cost_usd: number;
  top_failures: Array<{ reason: string; count: number }>;
}

const OUTCOMES: readonly string[] = ['pass', 'fail', 'not_checked'];

export function rowProblems(r: Partial<LedgerRow>): string[] {
  const out: string[] = [];
  for (const k of ['at', 'task_id', 'task_class', 'runner', 'model_version', 'packet_version'] as const) {
    if (typeof r[k] !== 'string' || !r[k]!.trim()) out.push(`${k} is missing`);
  }
  if (!OUTCOMES.includes(String(r.outcome))) out.push(`outcome ${String(r.outcome)} is not pass|fail|not_checked`);
  if (r.verified_by !== null && typeof r.verified_by !== 'string') out.push('verified_by must be a name or null');
  if (typeof r.duration_ms !== 'number' || !(r.duration_ms >= 0)) out.push('duration_ms must be a non-negative number');
  if (typeof r.cost_usd !== 'number' || !(r.cost_usd >= 0)) out.push('cost_usd must be a non-negative number');
  if (r.outcome !== 'pass' && (typeof r.failure_reason !== 'string' || !r.failure_reason.trim())) out.push('a non-pass needs a failure_reason');
  return out;
}

/** Append one row. Refuses a malformed row rather than writing something the reader will skip. */
export function appendRow(file: string, row: LedgerRow): void {
  const p = rowProblems(row);
  if (p.length) throw new Error(`ledger row refused: ${p.join('; ')}`);
  appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}

/** Read every row. A malformed line is counted and reported, never silently dropped. */
export function readRows(file: string): { rows: LedgerRow[]; malformed: number[] } {
  if (!existsSync(file)) return { rows: [], malformed: [] };
  const rows: LedgerRow[] = [];
  const malformed: number[] = [];
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const r = JSON.parse(line) as LedgerRow;
      if (rowProblems(r).length) malformed.push(i + 1);
      else rows.push(r);
    } catch {
      malformed.push(i + 1);
    }
  });
  return { rows, malformed };
}

const keyOf = (r: LaneKey) => [r.task_class, r.runner, r.model_version, r.packet_version].join('\0');
const isVerifiedPass = (r: LedgerRow) => r.outcome === 'pass' && !!r.verified_by && r.verified_by.trim().toLowerCase() !== r.runner.trim().toLowerCase();

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function summarize(rows: readonly LedgerRow[]): LaneSummary[] {
  const groups = new Map<string, LedgerRow[]>();
  for (const r of rows) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  return [...groups.values()].map((g) => {
    const first = g[0]!;
    const passes = g.filter(isVerifiedPass).length;
    const fails = new Map<string, number>();
    for (const r of g) if (r.outcome !== 'pass' && r.failure_reason) fails.set(r.failure_reason, (fails.get(r.failure_reason) ?? 0) + 1);
    return {
      task_class: first.task_class, runner: first.runner, model_version: first.model_version, packet_version: first.packet_version,
      n: g.length,
      verified_passes: passes,
      verified_pass_rate: passes / g.length,
      median_ms: median(g.map((r) => r.duration_ms)),
      mean_cost_usd: g.reduce((a, r) => a + r.cost_usd, 0) / g.length,
      top_failures: [...fails].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 3),
    };
  });
}

export type RouteResult =
  | { lane: LaneSummary; reason: string }
  | { lane: null; reason: string };

/**
 * The cheapest lane with demonstrated, independently verified success on this task class.
 * With no evidence it says so; it never falls back to a guess.
 */
export function routeLane(rows: readonly LedgerRow[], taskClass: string, opts: { minPassRate?: number; minVerifiedPasses?: number } = {}): RouteResult {
  const minRate = opts.minPassRate ?? 0.5;
  const minPasses = opts.minVerifiedPasses ?? 1;
  const forClass = summarize(rows).filter((s) => s.task_class === taskClass);
  if (forClass.length === 0) return { lane: null, reason: `no evidence: n=0 for task class ${taskClass}` };
  const proven = forClass.filter((s) => s.verified_passes >= minPasses && s.verified_pass_rate >= minRate);
  if (proven.length === 0) {
    const n = forClass.reduce((a, s) => a + s.n, 0);
    return { lane: null, reason: `no demonstrated success: n=${n} for ${taskClass}, none at >= ${minPasses} independently verified passes and rate >= ${minRate}` };
  }
  proven.sort((a, b) => a.mean_cost_usd - b.mean_cost_usd || b.verified_pass_rate - a.verified_pass_rate || b.n - a.n);
  const best = proven[0]!;
  return {
    lane: best,
    reason: `${best.runner}@${best.model_version}: cheapest proven lane, mean $${best.mean_cost_usd.toFixed(4)}, ${best.verified_passes}/${best.n} independently verified`,
  };
}
