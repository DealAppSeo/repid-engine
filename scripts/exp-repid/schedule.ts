/**
 * Scheduled SHADOW settle for experimental RepID (t12-exp-v1). One tick per invocation; the scheduler is
 * whatever calls it (a cron). NOT ARMED ANYWHERE: no cron file names this script.
 *
 *   EXP_REPID_SCHEDULE_ENABLED=1 EXPERIMENTAL_REPID_MODE=shadow npx ts-node scripts/exp-repid/schedule.ts
 *
 * Gates, in order, each writes nothing:
 *   disabled      EXP_REPID_SCHEDULE_ENABLED is not exactly '1' (the default).
 *   mode_refused  EXPERIMENTAL_REPID_MODE is not exactly 'shadow'. A schedule never writes active rows;
 *                 'active' is refused here even though the manual settle path accepts it.
 *
 * EXACTLY ONCE. Overlapping ticks and replays need no lock: every movement is one insert, and the table's
 * unique (domain, dimension, evidence_id, mode) and (…, evidence_hash, mode) indexes refuse a second one.
 * A refused duplicate is `already_consumed`, which a tick counts as a no-op, not a failure. Only
 * `store_error` fails the tick (exit 1). tests/experimental-repid/schedule-exactly-once.test.ts proves it.
 */
import {
  ACTIVE_VERSIONS,
  experimentalRepidMode,
  knownAnswerEvidence,
  loadKnownAnswerRows,
  settleExperimental,
  type ExperimentalStore,
  type KnownAnswerRow,
} from '../../src/services/experimental-repid';

export const SCHEDULE_FLAG = 'EXP_REPID_SCHEDULE_ENABLED';

export type TickResult =
  | { status: 'disabled' }
  | { status: 'mode_refused'; mode: string }
  | { status: 'ran'; rows: number; tally: Record<string, number>; failed: boolean };

export async function scheduledSettleTick(deps: {
  enabled?: string | undefined;
  mode?: string | undefined;
  loadRows?: () => Promise<KnownAnswerRow[]>;
  store?: ExperimentalStore;
} = {}): Promise<TickResult> {
  const enabled = 'enabled' in deps ? deps.enabled : process.env[SCHEDULE_FLAG];
  if (enabled !== '1') return { status: 'disabled' };
  const raw = 'mode' in deps ? deps.mode : process.env.EXPERIMENTAL_REPID_MODE;
  // Exact match on purpose: experimentalRepidMode() maps a typo to shadow, which is fine for a person at a
  // shell and wrong for an unattended schedule.
  if ((raw ?? '').trim().toLowerCase() !== 'shadow' || experimentalRepidMode(raw) !== 'shadow') {
    return { status: 'mode_refused', mode: String(raw ?? '') };
  }
  const rows = await (deps.loadRows ?? (() => loadKnownAnswerRows()))();
  const tally: Record<string, number> = {};
  for (const r of rows) {
    const evidence = knownAnswerEvidence(r);
    for (const version of ACTIVE_VERSIONS) {
      const res = await settleExperimental({ agentId: r.subject_agent_id, evidence, version }, { mode: 'shadow', store: deps.store });
      const key = `${version}:${res.status === 'refused' ? `refused:${res.reason}` : res.status}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
  }
  return { status: 'ran', rows: rows.length, tally, failed: Object.keys(tally).some((k) => k.endsWith('store_error')) };
}

if (require.main === module) {
  scheduledSettleTick()
    .then((res) => {
      console.log(JSON.stringify(res));
      if (res.status === 'ran' && res.failed) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}
