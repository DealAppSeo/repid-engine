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
}

/**
 * Probe one agent. NEVER throws.
 *
 * A prober that can throw stops probing the rest of the fleet on the first bad host, and a
 * monitoring gap is indistinguishable from an outage. Every failure becomes a ROW, not an
 * exception — the failure is the data.
 */
export async function probeOne(agent: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ProbeRow> {
  const url = healthUrl(agent);
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ctl.signal });
    return {
      agent_name: agent,
      url,
      http_status: res.status,
      // 2xx only. A 404 means the route is gone — a real finding, not a pass.
      ok: res.status >= 200 && res.status < 300,
      latency_ms: Date.now() - started,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (e: any) {
    return {
      agent_name: agent,
      url,
      http_status: null, // unreachable — distinct from "answered badly"
      ok: false,
      latency_ms: Date.now() - started,
      error: e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e?.message ?? e),
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
