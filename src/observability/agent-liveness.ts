/**
 * agent-liveness.ts — an agent is live because it pinged, not because it says so.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE OBSERVED FAILURE
 * ════════════════════════════════════════════════════════════════════════════════
 * [V sql 2026-08-04] All 12 rows in `agent_heartbeat` read `status = 'online'`
 * with `last_ping = 2026-07-17` — eighteen days stale. The status column is a
 * value the agent WROTE ABOUT ITSELF and then stopped updating; the timestamp is
 * the only field that decays on its own.
 *
 * So `status` is not merely inaccurate, it is structurally incapable of reporting
 * the one failure that matters. An agent that dies cannot write `status='offline'`
 * — the last thing it ever wrote stays true-looking forever. **A self-reported
 * liveness field is only ever wrong in the dangerous direction.**
 *
 * This is the same defect as `success_criteria = 'Pass default checks.'` and the
 * same defect the RepID provenance work addresses: a field that disguises absence
 * as a statement. The remedy is identical — never let a self-asserted value speak
 * for a fact that can be derived.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS AN AUDIT PROBLEM, NOT A COSMETIC ONE
 * ════════════════════════════════════════════════════════════════════════════════
 * `/api/health/agents` already computed `live` correctly from `last_ping` — and
 * then emitted the raw `status` field beside it. The response therefore carried a
 * correct answer and a contradicting one in the same object. A reader who trusts
 * the wrong field concludes the fleet is healthy; a reader who notices the
 * contradiction stops trusting every other field on the page.
 *
 * The fix is not to delete `status`. It is to LABEL it as what it is — a
 * self-report — and to make the derived state the one that answers the question.
 *
 * Pure over its inputs (clock injected) so staleness boundaries are testable.
 */

export type LivenessState =
  /** Pinged within the live window. */
  | 'live'
  /** Pinged, but longer ago than the live window — degraded, not necessarily dead. */
  | 'stale'
  /** Silent for so long that "still running" is not a credible reading. */
  | 'dead'
  /** Never pinged at all. Distinct from dead: nothing was ever observed. */
  | 'unknown';

/** Fresher than this and the agent counts as live. Matches the existing 5-minute check. */
export const LIVE_WINDOW_MIN = 5;

/**
 * Past this, report `dead` rather than `stale`.
 *
 * 60 minutes: long enough that a slow loop, a redeploy or a transient DB failure
 * does not get called dead, short enough that an 18-day silence can never be
 * described with the same word as a 6-minute one. The distinction exists so a
 * dashboard cannot flatten "briefly behind" and "gone since last month" into one
 * amber state — which is exactly how the current fleet looked healthy.
 */
export const DEAD_AFTER_MIN = 60;

export interface AgentLiveness {
  agentName: string;
  /** Derived from the timestamp. THIS is the answer to "is it running?". */
  state: LivenessState;
  live: boolean;
  minutesSinceLastPing: number | null;
  /**
   * What the row CLAIMS about itself. Retained for diagnosis, never authoritative,
   * and deliberately named so no caller mistakes it for the derived state.
   */
  selfReportedStatus: string | null;
  /**
   * True when the self-report and the derived state disagree — i.e. the row says
   * 'online' while the clock says otherwise. This is the field worth alerting on:
   * it means an agent died without being able to say so.
   */
  selfReportContradicted: boolean;
}

export interface HeartbeatRow {
  agent_name?: string | null;
  status?: string | null;
  last_ping?: string | Date | null;
}

function minutesSince(raw: unknown, nowMs: number): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const t = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  if (!Number.isFinite(t)) return null;
  // A ping from the future is a clock problem, not liveness evidence. Clamp to 0
  // rather than reporting a negative age, which would read as "very fresh".
  return Math.max(0, (nowMs - t) / 60000);
}

/** Derive one agent's liveness. `status` is read but never trusted. */
export function deriveLiveness(row: HeartbeatRow, nowMs: number = Date.now()): AgentLiveness {
  const mins = minutesSince(row.last_ping, nowMs);
  const selfReported = typeof row.status === 'string' && row.status.trim() !== '' ? row.status.trim() : null;

  let state: LivenessState;
  if (mins === null) state = 'unknown';
  else if (mins < LIVE_WINDOW_MIN) state = 'live';
  else if (mins < DEAD_AFTER_MIN) state = 'stale';
  else state = 'dead';

  // The contradiction that matters: it claims to be up, the clock says it is not.
  const claimsUp = selfReported !== null && /^(online|running|active|up|healthy)$/i.test(selfReported);
  const selfReportContradicted = claimsUp && state !== 'live';

  return {
    agentName: typeof row.agent_name === 'string' ? row.agent_name : '',
    state,
    live: state === 'live',
    minutesSinceLastPing: mins === null ? null : Number(mins.toFixed(1)),
    selfReportedStatus: selfReported,
    selfReportContradicted,
  };
}

export interface FleetLiveness {
  total: number;
  live: number;
  stale: number;
  dead: number;
  unknown: number;
  uptimePct: number;
  /**
   * How many rows claim to be up while the clock disagrees. Surfaced at fleet
   * level because it is the number that says "your health page is lying", which
   * a per-agent view makes easy to miss.
   */
  contradictions: number;
  agents: AgentLiveness[];
}

export function summarizeFleet(rows: HeartbeatRow[], nowMs: number = Date.now()): FleetLiveness {
  const agents = rows.map((r) => deriveLiveness(r, nowMs));
  const count = (s: LivenessState) => agents.filter((a) => a.state === s).length;
  const live = count('live');
  return {
    total: agents.length,
    live,
    stale: count('stale'),
    dead: count('dead'),
    unknown: count('unknown'),
    // Uptime is over the DERIVED state. Computing it from self-reported status is
    // how a fleet silent for 18 days reported 100%.
    uptimePct: agents.length ? Math.round((live / agents.length) * 100) : 0,
    contradictions: agents.filter((a) => a.selfReportContradicted).length,
    agents,
  };
}
