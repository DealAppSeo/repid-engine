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

// ═════════════════════════════════════════════════════════════════════════════
// PROGRESS — because a live loop is not a working loop
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything above answers "did it ping?". That question has a blind spot, and
// the blind spot has now cost four weeks of production.
//
// THE OBSERVED FAILURE [V sql 2026-08-17]. `trinity-mel` stopped producing on
// ~2026-06-19 and kept pinging until the fleet-wide stop on 07-17. For those
// four weeks `deriveLiveness` would have returned `state: 'live'`, `live: true`,
// and `selfReportContradicted: false` — every field correct, and the agent dead.
// It was the third-largest producer in the fleet at 688 events/day; it went to
// zero and nothing above could see it, because it never stopped pinging.
//
// Its own heartbeat row named the failure in two adjacent columns the whole
// time:
//
//     agent           loop_count   tasks_completed_session
//     trinity-mel        19,155              0
//     the other 11    4,271-4,388      380 - 2,078
//
// A loop iterating 4.4x harder than its peers and completing nothing. That is
// not liveness and it is not death — it is a THIRD state, and collapsing it into
// either is how it stayed invisible.
//
// This also closes the gap in the endpoint this logic was ported from. The
// Sprint 14 diagnostic classified an agent HEALTHY on `loop_count > 0` plus a
// fresh ping, which mel satisfied on both counts for four weeks. That endpoint
// was written for the Sprint 13 signature — a loop that never STARTED
// (loop_count == 0) — and a loop that starts and then spins forever is the
// opposite shape with the same consequence.
//
// ─── ON THE COUNTERS, HONESTLY ───────────────────────────────────────────────
//
// `loop_count` and `tasks_completed_session` are SESSION counters: they reset
// when the process restarts. So this is a snapshot heuristic, not a rate, and it
// cannot see a loop that spins, restarts, and spins again — each restart looks
// young. Reading progress across restarts needs a durable series, which is what
// production tables (`repid_score_events`, `hal_classifications`) provide and
// this module deliberately does not query: it stays pure over one row.
//
// That limit is why `SPIN_FLOOR_LOOPS` exists rather than a bare
// `completions === 0` test — a healthy agent that just booted has zero
// completions too, and calling it spinning would be a false alarm on every
// deploy.

/** What the loop is DOING, as distinct from whether it is pinging. */
export type ProgressState =
  /** Looping and completing work. */
  | 'producing'
  /**
   * Looping hard and completing nothing — the `trinity-mel` signature. The
   * dangerous state, because every ping-based check reads it as healthy.
   */
  | 'spinning'
  /** The loop has not iterated. Either just booted, or never started. */
  | 'not_looping'
  /** The columns are absent or null — say so rather than guessing. */
  | 'unknown';

/**
 * Loops below this are treated as a young session, never as spinning.
 *
 * Derived from the fleet's own ratio rather than picked: the eleven working
 * agents completed 380-2,078 tasks in 4,271-4,388 loops, i.e. one completion
 * every ~2-11 iterations. A healthy agent therefore has completions well before
 * 100 loops, while mel reached 19,155 with none. 100 is ~2 orders of magnitude
 * below mel and ~1 above the healthiest observed loops-per-completion, so it
 * separates the two populations without sitting near either.
 */
export const SPIN_FLOOR_LOOPS = 100;

export interface ProgressRow extends HeartbeatRow {
  loop_count?: number | null;
  tasks_completed_session?: number | null;
  tasks_failed_session?: number | null;
}

export interface AgentProgress {
  state: ProgressState;
  loopCount: number | null;
  completed: number | null;
  failed: number | null;
  /**
   * True only for `spinning`. Named as a finding rather than a status because it
   * is the one condition here worth waking somebody for.
   */
  spinningWithoutOutput: boolean;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Classify what the loop is doing. Pure over one heartbeat row. */
export function deriveProgress(row: ProgressRow): AgentProgress {
  const loopCount = num(row.loop_count);
  const completed = num(row.tasks_completed_session);
  const failed = num(row.tasks_failed_session);

  let state: ProgressState;
  if (loopCount === null) {
    // No counter at all. NOT `not_looping` — that would report an unwired agent
    // as a fault, which is the "absence disguised as a statement" defect again.
    state = 'unknown';
  } else if (loopCount <= 0) {
    state = 'not_looping';
  } else if (loopCount < SPIN_FLOOR_LOOPS) {
    // Young session. Too early to call it either way.
    state = completed !== null && completed > 0 ? 'producing' : 'unknown';
  } else if (completed === null) {
    state = 'unknown';
  } else if (completed > 0) {
    state = 'producing';
  } else {
    state = 'spinning';
  }

  return {
    state,
    loopCount,
    completed,
    failed,
    spinningWithoutOutput: state === 'spinning',
  };
}

/** Liveness and progress together — the two questions, never merged into one. */
export interface AgentHealth extends AgentLiveness {
  progress: AgentProgress;
  /**
   * Healthy requires BOTH: pinging recently AND making progress. A live agent
   * that is spinning is explicitly NOT healthy — that combination is the whole
   * reason this field exists rather than callers reading `live`.
   */
  healthy: boolean;
}

export function deriveHealth(row: ProgressRow, nowMs: number = Date.now()): AgentHealth {
  const liveness = deriveLiveness(row, nowMs);
  const progress = deriveProgress(row);
  return {
    ...liveness,
    progress,
    // `unknown` progress does not block healthy: an agent that pings and has no
    // counters wired is not evidence of a fault. `spinning` does block it.
    healthy: liveness.live && progress.state !== 'spinning' && progress.state !== 'not_looping',
  };
}

export interface FleetHealth extends FleetLiveness {
  healthy: number;
  /** Live, pinging, and producing nothing. The number that was missing. */
  spinning: number;
  notLooping: number;
  healthyPct: number;
  fleet: AgentHealth[];
}

export function summarizeFleetHealth(rows: ProgressRow[], nowMs: number = Date.now()): FleetHealth {
  const base = summarizeFleet(rows, nowMs);
  const fleet = rows.map((r) => deriveHealth(r, nowMs));
  const healthy = fleet.filter((a) => a.healthy).length;
  return {
    ...base,
    healthy,
    spinning: fleet.filter((a) => a.progress.state === 'spinning').length,
    notLooping: fleet.filter((a) => a.progress.state === 'not_looping').length,
    // Deliberately over `healthy`, not over `live`. Computing it from `live` is
    // what would have reported 100% through mel's four dead weeks.
    healthyPct: fleet.length ? Math.round((healthy / fleet.length) * 100) : 0,
    fleet,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// THE PROBE PATH — because `agent_heartbeat` is a retired table
// ═════════════════════════════════════════════════════════════════════════════
//
// EVERYTHING ABOVE READS `agent_heartbeat`, AND NOTHING HAS WRITTEN THAT TABLE
// SINCE 2026-07-17 22:18. Not a fault: agent presence writes were deliberately
// switched off (HEARTBEAT_MODE='off' in ConstitutionalAgentV4, "presence-write
// reduction", ~8.6M writes/day). Every one of its twelve rows is frozen — which
// means `deriveProgress` reads mel's 19,155/0 forever and would report
// `spinning` no matter what the fleet is doing. Right answer, dead input.
//
// This was shipped one commit earlier and is corrected here rather than quietly
// rewritten, because "the instrument reads a table nobody writes" is the exact
// class of defect the module above is about, and hiding the instance would be
// worse than the instance.
//
// `deriveProgress`/`deriveHealth` are KEPT: they are correct over their inputs
// and remain right for any caller holding genuine per-session counters. They
// must simply not be pointed at `agent_heartbeat` for a live answer.
//
// ─── WHAT REPLACED IT ────────────────────────────────────────────────────────
//
// Each agent serves GET /health from process memory:
//
//     { alive, loopCount, lastIterationAt, currentTaskId, uptimeSec, codeVersion }
//
// `lastIterationAt` is set at the TOP of every runLoop iteration and BEFORE the
// agent_controls idle gate, so it stays fresh while an agent is deliberately
// idled and goes stale only when the loop genuinely stops advancing. That makes
// staleness a HUNG-LOOP signal on a single sample — no second probe, no rate.
//
// The prober now records that body (`health-probe.ts`), so this classification
// runs over `agent_health_probes` rows.

/** What one /health probe establishes about the loop. */
export type LoopState =
  /** Answered, and the loop advanced recently. */
  | 'advancing'
  /**
   * Answered, and the loop has NOT advanced. The Sprint-13 signature and the
   * one this whole surface exists for: HTTP is green, the work is stopped.
   */
  | 'hung'
  /** Did not answer. The process itself is unreachable or erroring. */
  | 'down'
  /** Answered, but carried no loop signal — an old build, or an unreadable body. */
  | 'unknown';

/**
 * Past this, the loop is not advancing.
 *
 * 15 minutes. `lastIterationAt` is stamped before the idle gate, so a deliberately
 * paused agent keeps it fresh and only a genuinely stopped loop lets it age —
 * which means this does not need to accommodate slow work, only clock skew and a
 * missed probe or two. The external prober runs on a ~5-minute cadence, so 15
 * gives three windows before anything is called hung.
 */
export const LOOP_STALE_MIN = 15;

export interface HealthProbeRow {
  agent_name?: string | null;
  ok?: boolean | null;
  http_status?: number | null;
  alive?: boolean | null;
  loop_count?: number | null;
  last_iteration_at?: string | Date | null;
  code_version?: string | null;
  body_error?: string | null;
  probed_at?: string | Date | null;
}

export interface LoopHealth {
  agentName: string;
  state: LoopState;
  /** Answering HTTP. Kept separate from `healthy` so the two can disagree visibly. */
  responding: boolean;
  minutesSinceLastIteration: number | null;
  loopCount: number | null;
  codeVersion: string | null;
  /**
   * The agent's own `alive` flag. Self-asserted, so it is reported and never
   * consulted — the same reason `selfReportedStatus` exists above.
   */
  selfReportedAlive: boolean | null;
  /**
   * True when the agent answers 200 and claims alive while its loop is stale.
   * This is the alertable condition: a green monitor over a stopped fleet.
   */
  respondingButStopped: boolean;
  /** Why nothing could be concluded, when nothing could. */
  detail: string | null;
  healthy: boolean;
}

/** Classify one probe row. Pure; clock injected. */
export function deriveLoopHealth(row: HealthProbeRow, nowMs: number = Date.now()): LoopHealth {
  const agentName = typeof row.agent_name === 'string' ? row.agent_name : '';
  const responding = row.ok === true;
  const loopCount = typeof row.loop_count === 'number' && Number.isFinite(row.loop_count) ? row.loop_count : null;
  const selfReportedAlive = typeof row.alive === 'boolean' ? row.alive : null;
  const mins = minutesSince(row.last_iteration_at, nowMs);

  let state: LoopState;
  let detail: string | null = null;
  if (!responding) {
    state = 'down';
    detail = row.http_status === null || row.http_status === undefined
      ? 'the probe did not complete'
      : `answered HTTP ${row.http_status}`;
  } else if (mins === null) {
    // Answered, but told us nothing about its loop. NOT healthy-by-default and
    // NOT hung — an old build is a gap in observation, not a diagnosis.
    state = 'unknown';
    detail = typeof row.body_error === 'string' && row.body_error
      ? row.body_error
      : 'no lastIterationAt in the /health body';
  } else if (mins < LOOP_STALE_MIN) {
    state = 'advancing';
  } else {
    state = 'hung';
    detail = `loop last advanced ${Math.round(mins)} min ago while the process answered 200`;
  }

  return {
    agentName,
    state,
    responding,
    minutesSinceLastIteration: mins === null ? null : Number(mins.toFixed(1)),
    loopCount,
    codeVersion: typeof row.code_version === 'string' ? row.code_version : null,
    selfReportedAlive,
    respondingButStopped: responding && state === 'hung',
    detail,
    // Only `advancing` is healthy. `unknown` is deliberately NOT healthy here —
    // unlike the counter path above, where unknown means "an optional column is
    // unwired". Here it means the agent could not tell us whether it is working,
    // and this endpoint's entire job is to answer that.
    healthy: state === 'advancing',
  };
}

export interface FleetLoopHealth {
  total: number;
  healthy: number;
  hung: number;
  down: number;
  unknown: number;
  healthyPct: number;
  /** Answering 200 with a stopped loop. The number a status-code monitor cannot see. */
  respondingButStopped: number;
  agents: LoopHealth[];
}

export function summarizeFleetLoop(rows: HealthProbeRow[], nowMs: number = Date.now()): FleetLoopHealth {
  const agents = rows.map((r) => deriveLoopHealth(r, nowMs)).sort((a, b) => a.agentName.localeCompare(b.agentName));
  const count = (s: LoopState) => agents.filter((a) => a.state === s).length;
  const healthy = count('advancing');
  return {
    total: agents.length,
    healthy,
    hung: count('hung'),
    down: count('down'),
    unknown: count('unknown'),
    healthyPct: agents.length ? Math.round((healthy / agents.length) * 100) : 0,
    respondingButStopped: agents.filter((a) => a.respondingButStopped).length,
    agents,
  };
}
