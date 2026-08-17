/**
 * health-probe — the pure core of the only liveness signal that comes from OUTSIDE an agent.
 *
 * Lives in `src/` (not `scripts/`) because the in-process worker imports it and `dist/` only
 * builds `src/`. A worker importing from `scripts/` compiles fine and then fails at runtime in
 * production — exactly the "verify the call path, not the component" trap.
 *
 * Every other liveness surface in this system is derived from work an agent CHOSE to do:
 * `agent_heartbeat.last_ping` (writes removed 2026-07-17, starved), `trinity_agent_logs` (proves
 * it RAN, not that it is UP). Neither can tell "idle but healthy" from "gone" — which is how
 * `v_fleet_truth` came to report 12 healthy agents as dead while three answered HTTP 200.
 *
 * NO I/O BEYOND THE PROBE ITSELF. It returns rows; the caller persists them.
 */

/** Per-probe budget. Generous: we are asking "are you alive", not "are you fast". */
export const DEFAULT_TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS) || 12_000;

/**
 * The fleet. Names match `agent_heartbeat.agent_name` so `v_fleet_truth` joins without a
 * translation table — a mapping layer is one more place for the names to drift apart.
 */
export const TRINITY_AGENTS = [
  'trinity-orch', 'trinity-w3c', 'trinity-shofet',
  'trinity-torch', 'trinity-veritas', 'trinity-gcm',
  'trinity-chesed', 'trinity-mel', 'trinity-apm',
  'trinity-sophia', 'trinity-nexus', 'trinity-hdm',
] as const;

export const healthUrl = (agent: string) => `https://${agent}-production.up.railway.app/health`;

export interface ProbeRow {
  agent_name: string;
  url: string;
  /** NULL = the request never completed (DNS/TLS/timeout). NOT the same fact as a 5xx. */
  http_status: number | null;
  ok: boolean;
  latency_ms: number;
  error: string | null;

  // ─── THE /health BODY ──────────────────────────────────────────────────────
  //
  // Recording the status code alone is what made this probe blind. Agent
  // presence writes to `agent_heartbeat` were switched off in 2026-07
  // (HEARTBEAT_MODE='off') to shed ~8.6M writes/day, and the replacement is the
  // body of this very response: `{alive, loopCount, lastIterationAt, ...}` read
  // from process memory. It was being fetched and discarded, leaving the one bit
  // that was never enough — did it answer.
  //
  // Measured 2026-08-17: twelve agents at HTTP 200, zero repid_score_events and
  // zero hal_classifications. From `ok` alone that is indistinguishable from a
  // fully working fleet.
  //
  // EVERY FIELD IS NULLABLE AND NULL MEANS "NOT OBSERVED" — never 0. A
  // zero-valued loop_count is a claim about the agent; a NULL is the absence of
  // one, and collapsing them is the defect this whole surface exists to avoid.

  /** `alive` as the agent reported it. Self-asserted — corroborate, never trust alone. */
  alive: boolean | null;
  /** Iterations since process start. Freshness matters more than magnitude. */
  loop_count: number | null;
  /** When the loop last advanced. STALE HERE + a 200 IS the hung-loop signature. */
  last_iteration_at: string | null;
  current_task_id: string | null;
  uptime_sec: number | null;
  /** Real deployed commit SHA on Railway. Answers "which code is this actually". */
  code_version: string | null;
  /**
   * Why the body could not be read, when it could not.
   *
   * Distinguishes "answered 200 with something we cannot parse" from "answered
   * 200 with no body at all" — different faults with different fixes, and both
   * are invisible if the failure is only ever recorded as a NULL column.
   */
  body_error: string | null;
}

/** Every body field absent. The shape a row takes when nothing was observed. */
const NO_BODY = {
  alive: null,
  loop_count: null,
  last_iteration_at: null,
  current_task_id: null,
  uptime_sec: null,
  code_version: null,
} as const;

const asNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** ISO string if it parses as a real instant, else null. Never a raw passthrough. */
const asInstant = (v: unknown): string | null => {
  if (typeof v !== 'string' && !(v instanceof Date)) return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * Parse a /health body into probe columns. PURE, and never throws.
 *
 * Exported for tests: this is the part with judgement in it, and a parser only
 * exercised through a live socket is a parser nobody has actually tested.
 */
export function parseHealthBody(raw: string): Pick<
  ProbeRow,
  'alive' | 'loop_count' | 'last_iteration_at' | 'current_task_id' | 'uptime_sec' | 'code_version' | 'body_error'
> {
  if (!raw || !raw.trim()) return { ...NO_BODY, body_error: 'empty body' };
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Truncated: the point is to identify the shape, not to store a page of HTML.
    return { ...NO_BODY, body_error: `unparseable body: ${raw.slice(0, 80)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...NO_BODY, body_error: `body is ${Array.isArray(parsed) ? 'an array' : typeof parsed}, expected an object` };
  }
  const loop = asNum(parsed.loopCount);
  const iter = asInstant(parsed.lastIterationAt);
  return {
    alive: typeof parsed.alive === 'boolean' ? parsed.alive : null,
    loop_count: loop,
    last_iteration_at: iter,
    current_task_id:
      parsed.currentTaskId === null || parsed.currentTaskId === undefined
        ? null
        : String(parsed.currentTaskId),
    uptime_sec: asNum(parsed.uptimeSec),
    code_version: typeof parsed.codeVersion === 'string' ? parsed.codeVersion : null,
    // A 200 whose body carries neither field is an agent on a build that predates
    // the in-memory liveness signal. Say that, rather than leaving two NULLs that
    // read the same as "we did not look".
    body_error:
      loop === null && iter === null
        ? 'body parsed but carries neither loopCount nor lastIterationAt'
        : null,
  };
}

/** Refuse to buffer an unbounded body from a host that may be misbehaving. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Probe one agent. NEVER throws.
 *
 * A prober that can throw stops probing the rest of the fleet on the first bad host, and a
 * monitoring gap is indistinguishable from an outage. Every failure becomes a ROW, not an
 * exception — the failure is the data. Reading the body does not change that: a body that
 * cannot be read yields `body_error`, and the status columns stay exactly as accurate as
 * they were before.
 */
export async function probeOne(agent: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProbeRow> {
  const url = healthUrl(agent);
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctl.signal });
    // Latency is the time to ANSWER, taken before the body is drained, so adding
    // the read does not silently inflate a number people compare across time.
    const latency = Date.now() - started;

    let body: ReturnType<typeof parseHealthBody>;
    try {
      const text = await res.text();
      body =
        text.length > MAX_BODY_BYTES
          ? { ...NO_BODY, body_error: `body exceeds ${MAX_BODY_BYTES} bytes` }
          : parseHealthBody(text);
    } catch (e: any) {
      body = { ...NO_BODY, body_error: `body read failed: ${String(e?.message ?? e)}` };
    }

    return {
      agent_name: agent,
      url,
      http_status: res.status,
      // 2xx only. A 404 means the route is gone — a real finding, not a pass.
      ok: res.status >= 200 && res.status < 300,
      latency_ms: latency,
      error: res.ok ? null : `HTTP ${res.status}`,
      ...body,
    };
  } catch (e: any) {
    return {
      agent_name: agent,
      url,
      http_status: null, // unreachable — distinct from "answered badly"
      ok: false,
      latency_ms: Date.now() - started,
      error: e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e?.message ?? e),
      ...NO_BODY,
      // The request never completed, so there was no body to fail at. Recording a
      // body_error here would invent a second fault from one.
      body_error: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the whole fleet in parallel. Always resolves; failures are rows, never exceptions. */
export async function probeFleet(
  agents: readonly string[] = TRINITY_AGENTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProbeRow[]> {
  return Promise.all(agents.map((a) => probeOne(a, timeoutMs)));
}

/** One-line summary for a log. Pure, so it is testable and cannot itself throw. */
export function summarise(rows: readonly ProbeRow[]): string {
  const up = rows.filter((r) => r.ok).length;
  const unreachable = rows.filter((r) => !r.ok && r.http_status === null).length;
  const down = rows.length - up - unreachable;
  return `${up}/${rows.length} up` + (down ? `, ${down} down` : '') +
    (unreachable ? `, ${unreachable} unreachable` : '');
}
