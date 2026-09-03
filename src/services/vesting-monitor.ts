/**
 * Periodic check: is any earned RepID stranded past its own vesting cliff?
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS RUNS IN THE SERVICE AND NOT IN CI
 * ════════════════════════════════════════════════════════════════════════════════
 * `scripts/verify/vesting-not-stranded.ts` answers this on demand, and CI would be
 * the obvious home for it — except CI's database is the disposable TEST project.
 * Run there it would find no stranded balance because there are no agents, and
 * report a green that proves nothing about production. That is the defect this
 * whole family of checks exists to remove, so wiring it into CI would have been
 * the bug wearing the fix's clothes.
 *
 * This process already holds production credentials and already runs periodic
 * monitors. It is the only place the question can be asked of the real data
 * without adding a secret anywhere.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT IT FOUND, AND WHY IT NEEDED TO EXIST [MEASURED 2026-09-03]
 * ════════════════════════════════════════════════════════════════════════════════
 * Nothing releases `vested_repid` into `current_repid` when a cliff ends — no code
 * path and no database function, verified against `pg_proc` and every trigger on
 * the agents table. Balances whose cliffs expired MONTHS ago are still held, some
 * on agents still sitting at exactly the starting RepID.
 *
 * It went unnoticed for that long because a stranded balance is silent from every
 * direction: the score is a plausible number, the row looks healthy, and no query
 * anyone runs joins the balance to the date. Nothing was broken enough to notice.
 * This is the query nobody was running, on a schedule.
 *
 * IT WRITES NOTHING TO THE AGENT. Crediting the balance moves real scores in an
 * append-only ledger, retroactively, and is a decision with an owner. This reports.
 * The only write it causes is an operator alert, through the pager whose RECORD
 * channel needs no secret (`operator-pager.ts`) — the reason that channel exists is
 * so a finding like this one cannot be lost while somebody configures push.
 *
 * That alert is a real write, which is why the caller in `index.ts` is behind the
 * emergency-halt gate like every other tick loop. The first version was not, on the
 * argument that a read-only monitor needs no gate; the argument was wrong on its own
 * terms and the pin caught it.
 */
import { db } from '../db';
import { deriveVestingState } from './vesting-status';
import { pageOperator } from './operator-pager';

/** How long past a cliff a balance may sit before it counts as stranded. */
export const VESTING_GRACE_MS =
  Number(process.env['VESTING_GRACE_HOURS'] ?? 24) * 3_600_000;

export interface VestingMonitorResult {
  /** Three outcomes, never two: a read that failed is not a clean result. */
  checked: boolean;
  holders: number;
  vesting: number;
  stranded: number;
  stranded_repid: number;
  oldest_stranded_cliff: string | null;
  undated: number;
  error?: string;
}

/** Last completed result, for `/health`. `null` until the first run finishes. */
let last: VestingMonitorResult | null = null;
export function lastVestingCheck(): VestingMonitorResult | null {
  return last;
}
export function _resetVestingMonitor(): void {
  last = null;
}

export async function checkStrandedVesting(
  now: number = Date.now(),
): Promise<VestingMonitorResult> {
  try {
    const { data, error } = await db
      .from('repid_agents')
      .select('id, agent_name, current_repid, vested_repid, vesting_cliff_ends_at')
      .gt('vested_repid', 0);

    if (error) {
      // NOT_CHECKED. A monitor that cannot read its subject must not report zero
      // stranded — that is indistinguishable from a clean run and is the exact
      // collapse this codebase keeps paying for.
      last = {
        checked: false,
        holders: 0,
        vesting: 0,
        stranded: 0,
        stranded_repid: 0,
        oldest_stranded_cliff: null,
        undated: 0,
        error: error.message,
      };
      console.error(`[vesting-monitor] NOT_CHECKED — could not read agents: ${error.message}`);
      return last;
    }

    const rows = (data ?? []) as Array<Record<string, any>>;
    const stranded = rows.filter((r) => {
      if (deriveVestingState(r, now) !== 'MATURED') return false;
      return now - new Date(r['vesting_cliff_ends_at']).getTime() > VESTING_GRACE_MS;
    });

    const cliffs = stranded
      .map((r) => new Date(r['vesting_cliff_ends_at']).getTime())
      .filter((t) => Number.isFinite(t));

    last = {
      checked: true,
      holders: rows.length,
      vesting: rows.filter((r) => deriveVestingState(r, now) === 'VESTING').length,
      stranded: stranded.length,
      stranded_repid: stranded.reduce((a, r) => a + (Number(r['vested_repid']) || 0), 0),
      oldest_stranded_cliff: cliffs.length ? new Date(Math.min(...cliffs)).toISOString() : null,
      undated: rows.filter((r) => deriveVestingState(r, now) === 'HELD').length,
    };

    if (stranded.length > 0) {
      // A STABLE reason string. The counts go in the detail payload, never in the
      // dedupe key — a reason that changes as the number drifts would defeat the
      // pager's cooldown and produce one alert per cycle forever.
      pageOperator(
        'degraded',
        'vested RepID is past its cliff and has not been credited',
        {
          agents: stranded.length,
          repid: last.stranded_repid,
          oldest_cliff: last.oldest_stranded_cliff,
          note: 'read-only finding; crediting the balance is a scoring decision, not a fix this monitor may apply',
        },
      );
    }

    return last;
  } catch (e: any) {
    last = {
      checked: false,
      holders: 0,
      vesting: 0,
      stranded: 0,
      stranded_repid: 0,
      oldest_stranded_cliff: null,
      undated: 0,
      error: e?.message ?? String(e),
    };
    console.error(`[vesting-monitor] NOT_CHECKED — threw: ${last.error}`);
    return last;
  }
}
