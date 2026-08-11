/**
 * probe-agent-health — the only liveness signal in this system that comes from OUTSIDE the agent.
 *
 * Every other surface is derived from work an agent chose to do: `agent_heartbeat.last_ping`
 * (writes removed 2026-07-17, starved), `trinity_agent_logs` (proves it RAN, not that it is UP),
 * `trinity_swarm_health` (a view over the same). None can tell "idle but healthy" from "gone" —
 * which is exactly how `v_fleet_truth` came to report 12 healthy agents as dead while three of
 * them were answering HTTP 200.
 *
 * An HTTP GET against `/health` cannot be faked by a dead process. That is the whole point.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * - It does not decide anything. It records observations; `v_fleet_truth` reads them.
 * - It does not treat "unreachable" as "down". A DNS/TLS/timeout failure writes `http_status
 *   NULL`, a 500 writes `500`. The host answering badly and the host not answering are different
 *   facts, and collapsing them is how you get a monitoring surface that lies.
 * - It does not upsert. Each probe is a row, so a flap is distinguishable from an outage.
 *
 * Usage:  npx ts-node scripts/liveness-probes/probe-agent-health.ts [--dry-run]
 * Intended to run on a schedule (Railway cron, alongside the attestation minter).
 */
// NOTE: `src/db` is required LAZILY, inside main(), on purpose. Importing it at module scope runs
// config validation, which throws without Supabase credentials — and that would make `--dry-run`
// (a pure HTTP check that needs no database at all) impossible on a machine without them. A
// diagnostic tool must be runnable in the degraded situation you are trying to diagnose.

/** Per-probe budget. Generous: we are asking "are you alive", not "are you fast". */
const TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS) || 12_000;

/**
 * The fleet. Names match `agent_heartbeat.agent_name` so `v_fleet_truth` can join without a
 * translation table — a mapping layer is somewhere else for the names to drift.
 */
export const TRINITY_AGENTS = [
  'trinity-orch', 'trinity-w3c', 'trinity-shofet',
  'trinity-torch', 'trinity-veritas', 'trinity-gcm',
  'trinity-chesed', 'trinity-mel', 'trinity-apm',
  'trinity-sophia', 'trinity-nexus', 'trinity-hdm',
] as const;

export const healthUrl = (agent: string) =>
  `https://${agent}-production.up.railway.app/health`;

export interface ProbeRow {
  agent_name: string;
  url: string;
  http_status: number | null;
  ok: boolean;
  latency_ms: number;
  error: string | null;
}

/**
 * Probe one agent. NEVER throws — a prober that can crash stops probing the rest of the fleet,
 * and a monitoring gap looks identical to an outage.
 */
export async function probeOne(agent: string, timeoutMs = TIMEOUT_MS): Promise<ProbeRow> {
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
      // 2xx only. A 404 means the route is gone, which is a real finding, not a pass.
      ok: res.status >= 200 && res.status < 300,
      latency_ms: Date.now() - started,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (e: any) {
    // The request never completed. http_status stays NULL — unreachable, not "answered badly".
    return {
      agent_name: agent,
      url,
      http_status: null,
      ok: false,
      latency_ms: Date.now() - started,
      error: e?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(e?.message ?? e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the whole fleet in parallel. Always resolves; failures are rows, not exceptions. */
export async function probeFleet(agents: readonly string[] = TRINITY_AGENTS): Promise<ProbeRow[]> {
  return Promise.all(agents.map((a) => probeOne(a)));
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const rows = await probeFleet();

  for (const r of rows) {
    const status = r.ok ? 'UP  ' : r.http_status === null ? 'UNREACH' : 'DOWN';
    console.log(
      `${status} ${r.agent_name.padEnd(18)} ${String(r.http_status ?? '-').padStart(4)} ` +
        `${String(r.latency_ms).padStart(6)}ms${r.error ? '  ' + r.error : ''}`,
    );
  }

  const up = rows.filter((r) => r.ok).length;
  console.log(`\n${up}/${rows.length} up`);

  if (dryRun) {
    console.log('--dry-run: nothing written');
    return 0;
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { db } = require('../../src/db');
  const { error } = await db.from('agent_health_probes').insert(rows);
  if (error) {
    // A failed WRITE is not a failed probe. Say which one broke, or the next reader will
    // mistake a logging outage for a fleet outage.
    console.error(`probe results NOT persisted (probes themselves ran fine): ${error.message}`);
    return 1;
  }
  console.log(`wrote ${rows.length} probe rows`);
  return 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error('probe run failed:', e?.message ?? e);
    process.exit(1);
  });
}
