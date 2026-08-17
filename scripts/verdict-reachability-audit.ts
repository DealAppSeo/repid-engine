/**
 * verdict-reachability-audit.ts — wires `hal-verdict-reachability.ts` (a pure module with zero
 * runtime callers) to a REAL caller: the live database.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ════════════════════════════════════════════════════════════════════════════════
 * `reports/2026-08-17/LEDGER-VERDICT-REACHABILITY.md` measured 568 stored `hal_decision`
 * verdicts that no producer in this repo can emit (556 `clean` at risk >= 0.40, 12 `APPROVE`).
 * That measurement was a one-off `execute_sql` call — useful for the report, useless for
 * catching the NEXT bad row. This script is the difference: run it again later and it tells you
 * whether the writer that produced those 568 is still producing them.
 *
 * PURITY BOUNDARY, RESPECTED. `hal-verdict-reachability.ts` does no I/O — this script is the one
 * place that does, matching the split `zkrepid/index.ts` documents for the rest of this tree
 * (pure module + a named caller that owns the database).
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT "REGRESSION" MEANS HERE, PRECISELY
 * ════════════════════════════════════════════════════════════════════════════════
 * `BASELINE_UNREACHABLE` is the 568 measured on 2026-08-17. This script does NOT know which 568
 * rows those were (no id list was captured) — so it cannot say "a NEW bad row appeared" with
 * certainty. What it CAN say honestly: whether the unreachable COUNT has grown past baseline. A
 * shrinking or flat count is consistent with the writer being dormant or fixed; a growing count
 * means something is still emitting unreachable verdicts as of the moment this ran. That is a
 * weaker claim than "found a new bad row" and this script does not overstate it.
 *
 * Which writer produces the 556 + 12 remains UNIDENTIFIED (recorded in the report). This script
 * detects that the wound is still open; it does not diagnose it.
 *
 * Usage:
 *   npx ts-node scripts/verdict-reachability-audit.ts             # human-readable report
 *   npx ts-node scripts/verdict-reachability-audit.ts --json       # machine-readable, for a future CI gate
 *
 * Exit codes (checked by the caller, not asserted by a test — this hits a live database):
 *   0  unreachable count <= BASELINE_UNREACHABLE (no growth since 2026-08-17)
 *   1  unreachable count  > BASELINE_UNREACHABLE (growth — something is still writing bad verdicts)
 *   2  could not reach the database (NOT_CHECKED, not a false pass — see the top-level catch)
 */
import { db } from '../src/db';
import {
  partitionByReachability,
  type Reachability,
} from '../src/scoring/hal-verdict-reachability';

/** [V SQL 2026-08-17], reports/2026-08-17/LEDGER-VERDICT-REACHABILITY.md. Do not lower this to
 *  make a run look clean — it is the count that was ACTUALLY measured, not a target. */
export const BASELINE_UNREACHABLE = 568;
export const BASELINE_DATE = '2026-08-17';

/**
 * The regression decision, pulled out as a pure function so it can be tested without a database —
 * this script cannot be exercised end-to-end from a sandboxed session (`qnnpjhlxljtqyigedwkb.supabase.co`
 * is proxy-denied to direct fetch here; only the Supabase MCP tool's separate path reaches it — see
 * trinity-ecosystem/CLAUDE.md "Network, in cloud/remote sessions"). Verified live instead: this run
 * produced exit code 2 (NOT_CHECKED) rather than a false pass, which is the property that matters
 * when the database genuinely cannot be reached.
 */
export function computeVerdict(
  unreachableCount: number,
  baseline: number = BASELINE_UNREACHABLE,
): { regressed: boolean; growth: number; exitCode: 0 | 1 } {
  const growth = unreachableCount - baseline;
  const regressed = growth > 0;
  return { regressed, growth, exitCode: regressed ? 1 : 0 };
}

/** Supabase caps a single response; page through the full table rather than silently sampling. */
const PAGE_SIZE = 1000;

interface Row {
  hal_score: number | null;
  hal_decision: string | null;
}

async function fetchAllDecisionRows(): Promise<Row[]> {
  const rows: Row[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('repid_score_events')
      .select('hal_score, hal_decision')
      .not('hal_decision', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`[verdict-reachability-audit] query failed at offset ${from}: ${error.message}`);
    }
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

function reasonCounts(unreachable: Array<{ reachability: Reachability }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of unreachable) {
    const key = u.reachability.reason ?? 'UNKNOWN';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json');

  let rows: Row[];
  try {
    rows = await fetchAllDecisionRows();
  } catch (e) {
    // NOT_CHECKED, not FAILED — a database that can't be reached says nothing about whether the
    // guard would pass. Exit 2 keeps this distinguishable from exit 1 (a real regression).
    const msg = e instanceof Error ? e.message : String(e);
    if (json) {
      console.log(JSON.stringify({ verdict: 'NOT_CHECKED', reason: msg }, null, 2));
    } else {
      console.error(`NOT_CHECKED — could not reach the database: ${msg}`);
    }
    process.exit(2);
  }

  const partition = partitionByReachability(rows);
  const { regressed, growth, exitCode } = computeVerdict(partition.droppedCount);

  if (json) {
    console.log(
      JSON.stringify(
        {
          verdict: regressed ? 'REGRESSION' : 'NO_GROWTH',
          scanned: partition.total,
          reachable: partition.reachable.length,
          unreachable: partition.droppedCount,
          baseline: BASELINE_UNREACHABLE,
          baselineDate: BASELINE_DATE,
          growth,
          reasons: partition.reasons,
        },
        null,
        2,
      ),
    );
  } else {
    console.log('');
    console.log('VERDICT REACHABILITY AUDIT — src/scoring/hal-verdict-reachability.ts against the live DB');
    console.log('='.repeat(88));
    console.log(`rows with a hal_decision scanned : ${partition.total}`);
    console.log(`reachable                        : ${partition.reachable.length}`);
    console.log(`unreachable (no producer emits it): ${partition.droppedCount}`);
    console.log('  by reason:');
    for (const [reason, n] of Object.entries(partition.reasons)) {
      console.log(`    ${reason.padEnd(34)} ${n}`);
    }
    console.log('');
    console.log(`baseline (${BASELINE_DATE})              : ${BASELINE_UNREACHABLE}`);
    console.log(`growth since baseline             : ${growth >= 0 ? '+' : ''}${growth}`);
    console.log('');
    if (regressed) {
      console.log(
        `REGRESSION — ${growth} more unreachable verdicts than the ${BASELINE_DATE} baseline. ` +
          `Something is still writing verdicts deriveHalDecision cannot produce.`,
      );
    } else {
      console.log(
        `NO GROWTH — unreachable count is at or below the ${BASELINE_DATE} baseline. This does ` +
          `NOT mean the 568 are fixed; it means no MORE have appeared since they were measured.`,
      );
    }
    console.log('');
  }

  process.exit(exitCode);
}

// `require.main === module` guards `main()` so this file is importable (for `computeVerdict`) by
// a test without running the live-DB path as a side effect of import.
if (require.main === module) {
  main();
}
