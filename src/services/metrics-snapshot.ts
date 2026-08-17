/**
 * METRICS TRUTH — the public /api/v1/metrics snapshot.
 *
 * WHAT THIS REPLACES (2026-08-17). The public metrics payload was a mix of real
 * counts and hardcoded literals presented in the same object, indistinguishable to
 * any reader:
 *
 *   src/index.ts:382 (the LIVE handler)   hal_approval_rate: 99.4
 *   src/routes/telegram.ts:261 (a copy)   hal_approval_rate: 99.4
 *   src/routes/v1.ts:107 (dead, shadowed) uptime_pct 99.9, avg_response_ms 124,
 *                                         hal_veto_rate_24h 0.994,
 *                                         hallucination_catch_rate 0.12,
 *                                         status "operational", llm_providers 2,
 *                                         grace_pool_pct 0.20,
 *                                         active_stakes_usdc 500000,
 *                                         jubilee_next = now + 30d (per request)
 *
 * Measured against the database on 2026-08-17, the literals were not merely stale,
 * several were inverted: the real 24h average call latency was ~7x the advertised
 * 124ms, and `hal_approval_rate: 99.4` sat against an all-time HAL ledger in which
 * the *veto* decision is the majority one. A number nobody computes cannot go stale
 * in a direction anyone notices — that is the defect, not the specific values.
 *
 * THE RULE THIS FILE ENFORCES. Every numeric field is `number | null`, and `null`
 * is never a value — it is the absence of one, always accompanied by an entry in
 * `measurement` saying why. Three outcomes, never two:
 *
 *   measured   — a query ran and returned this number. `basis` names the denominator
 *                or sample size, `window` and `source` name the ruler (a measurement
 *                without its ruler is not a result).
 *   unmeasured — no data in the window, or the sample hit its cap so the answer would
 *                only be a lower bound. The field is null.
 *   failed     — the query errored. The field is null.
 *
 * The last one is the point. The previous code read `data?.length || 0`, so a failed
 * query and an empty table both published `0` — a database outage rendered as a
 * confident measurement of zero. `null` cannot be mistaken for zero by a consumer;
 * `0` from a broken query already was.
 *
 * NO STATUS CONSTANT. The old payload carried `status: "operational"`, a literal that
 * had no path to any other value — structurally the same defect as a heartbeat column
 * an agent must be alive to set to 'offline'. It is gone rather than derived: what a
 * caller actually needs is per-field provenance, and `measurement.<field>.status` is
 * that, and it does go to 'failed'.
 *
 * COST. These aggregate over tables that are large and growing (score events are
 * six figures, LLM call logs are hundreds of thousands), on an endpoint that is
 * public and unauthenticated. Two protections, both deliberate:
 *   1. Counts use PostgREST `head: true` exact counts — the count is computed in
 *      Postgres and no rows cross the wire. The old code fetched rows and counted
 *      them in JS, which is both a large transfer per request and silently WRONG
 *      once the row set exceeds PostgREST's max-rows cap: measured 2026-08-17, the
 *      distinct-provider count taken over the first 1000 rows was 4 against 20 in
 *      the full table.
 *   2. Everything is behind a process-level TTL cache, so a request flood costs one
 *      database round per TTL per instance, not one per request.
 *
 * Cost of one cache miss, measured with EXPLAIN ANALYZE on 2026-08-17 (the ruler:
 * 152,164 score events, 486,376 call log rows). The queries run concurrently, so the
 * miss costs about the slowest, not the sum:
 *
 *      count(*) repid_score_events                    387 ms   index-only scan
 *      count(*) where llm_provider is not null        101 ms   index-only scan
 *      llm_call_log, 24h window                     70-2068 ms  cold vs warm
 *      repid_score_events, 24h window                14-82 ms   cold vs warm
 *      repid_agents count / vdr rows                   < 5 ms
 *
 * Two of those scale with TOTAL table size rather than with the window, and the 24h
 * llm_call_log scan is slow for a structural reason: the only index covering that
 * column is a composite led by `provider`, so a `created_at` predicate walks the whole
 * index. Unbounded on a public unauthenticated route, that is a denial-of-service
 * lever; behind the TTL it is one such scan per minute per instance. If these grow
 * enough to matter, the fix is an index on `created_at` or a materialized rollup —
 * NOT a wider cache, and never a literal.
 * Where an aggregate genuinely needs rows (a distinct count, an average, a sum),
 * the fetch is capped and a truncated sample reports `unmeasured`, never a lower
 * bound dressed up as a total.
 */

import { db as defaultDb } from '../db';

export type MeasurementStatus = 'measured' | 'unmeasured' | 'failed';

export interface Measurement {
  status: MeasurementStatus;
  /** Time window the number covers, e.g. '24h' or 'all_time'. */
  window?: string;
  /** Table or process facility the number came from. */
  source?: string;
  /** Denominator / sample size behind a rate or average. */
  basis?: number;
  /** Why the value is null. Present iff status !== 'measured'. */
  reason?: string;
}

export interface MetricsSnapshot {
  agents: number | null;
  active_agents_24h: number | null;
  vdr: number | null;
  decisions: number | null;
  providers: number | null;
  hallucinations: number | null;
  hallucination_catch_rate: number | null;
  hal_approval_rate: number | null;
  hal_veto_rate_24h: number | null;
  avg_response_ms: number | null;
  process_uptime_s: number;
  /** Deployment identifiers, not measurements — see note at the constants. */
  staking_contract: string;
  identity_registry: string;
  as_of: string;
  measurement: Record<string, Measurement>;
}

/**
 * Deployed contract addresses. These are IDENTIFIERS, not measurements — a contract
 * address is a fact about the deployment, and a literal is the correct way to state
 * one. They carry no `measurement` entry for that reason. Both are the canonical
 * Base Sepolia deployments used across this codebase (see src/config/network.ts and
 * src/services/agent-registration-file.ts) and are documented as published here by
 * docs/USER_GUIDE_FIRST_5_MINUTES.md.
 */
const STAKING_CONTRACT = '0xd35331Bf94b1A4F4CAf595951056C288ce58C4fA';
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

/**
 * Row cap for the aggregates that cannot be pushed into Postgres through PostgREST
 * (distinct counts, averages, sums). Hitting the cap makes the result a lower bound,
 * so it is reported `unmeasured` rather than published as a total.
 */
const SAMPLE_CAP = 5000;

const DEFAULT_TTL_MS = 60_000;

function ttlMs(): number {
  const raw = Number(process.env.METRICS_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

interface CacheEntry {
  snapshot: MetricsSnapshot;
  expiresAt: number;
}
let cache: CacheEntry | null = null;
/** In-flight dedup: a burst of concurrent requests share one database round. */
let inFlight: Promise<MetricsSnapshot> | null = null;

/** Test seam — drops the cache so a test observes its own stubbed database. */
export function resetMetricsCache(): void {
  cache = null;
  inFlight = null;
}

function hoursAgoIso(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

/**
 * Exact count computed in Postgres (`head: true` sends no rows back).
 * Returns null on error — never 0, which is the whole point.
 */
async function exactCount(
  build: () => any,
): Promise<{ value: number | null; error: string | null }> {
  try {
    const { count, error } = await build();
    if (error) return { value: null, error: error.message ?? String(error) };
    if (typeof count !== 'number') {
      return { value: null, error: 'count missing from response' };
    }
    return { value: count, error: null };
  } catch (e: any) {
    return { value: null, error: e?.message ?? String(e) };
  }
}

/** Capped row fetch for aggregates PostgREST cannot compute server-side. */
async function cappedRows(
  build: () => any,
): Promise<{ rows: any[] | null; truncated: boolean; error: string | null }> {
  try {
    const { data, error } = await build();
    if (error) return { rows: null, truncated: false, error: error.message ?? String(error) };
    const rows = Array.isArray(data) ? data : [];
    return { rows, truncated: rows.length >= SAMPLE_CAP, error: null };
  } catch (e: any) {
    return { rows: null, truncated: false, error: e?.message ?? String(e) };
  }
}

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

async function computeSnapshot(db: any): Promise<MetricsSnapshot> {
  const since24h = hoursAgoIso(24);
  const measurement: Record<string, Measurement> = {};

  const [
    agentsCount,
    eventsTotal,
    decisionsCount,
    hallucinationsCount,
    vdrRows,
    activeRows,
    llmRows,
    halRows,
  ] = await Promise.all([
    // agents — exact count, no rows transferred.
    exactCount(() => db.from('repid_agents').select('*', { count: 'exact', head: true })),
    // total score events — denominator for the hallucination catch rate.
    exactCount(() => db.from('repid_score_events').select('*', { count: 'exact', head: true })),
    // decisions — score events that recorded which LLM produced them.
    exactCount(() =>
      db
        .from('repid_score_events')
        .select('*', { count: 'exact', head: true })
        .not('llm_provider', 'is', null),
    ),
    // hallucinations — served by the partial index on (hallucination_caught) WHERE true.
    exactCount(() =>
      db
        .from('repid_score_events')
        .select('*', { count: 'exact', head: true })
        .eq('hallucination_caught', true),
    ),
    // vdr — PostgREST cannot SUM, so the column is fetched and summed here, capped.
    cappedRows(() => db.from('repid_agents').select('vdr_count').limit(SAMPLE_CAP)),
    // active agents — derived from EVIDENCE (an agent that emitted a score event in the
    // window) rather than from repid_agents.last_active_at, a column something must
    // remember to write. Measured 2026-08-17: only 32 of 176 agents had it set at all.
    cappedRows(() =>
      db.from('repid_score_events').select('agent_id').gt('created_at', since24h).limit(SAMPLE_CAP),
    ),
    // latency + provider count, one pass over the 24h call log.
    cappedRows(() =>
      db
        .from('llm_call_log')
        .select('provider,latency_ms,status')
        .gt('created_at', since24h)
        .limit(SAMPLE_CAP),
    ),
    // HAL decisions in the window.
    cappedRows(() =>
      db
        .from('repid_score_events')
        .select('hal_decision')
        .gt('created_at', since24h)
        .not('hal_decision', 'is', null)
        .limit(SAMPLE_CAP),
    ),
  ]);

  // --- agents ---------------------------------------------------------------
  let agents: number | null = agentsCount.value;
  measurement.agents = agentsCount.error
    ? { status: 'failed', source: 'repid_agents', reason: agentsCount.error }
    : { status: 'measured', window: 'all_time', source: 'repid_agents' };

  // --- vdr ------------------------------------------------------------------
  let vdr: number | null = null;
  if (vdrRows.error) {
    measurement.vdr = { status: 'failed', source: 'repid_agents.vdr_count', reason: vdrRows.error };
  } else if (vdrRows.truncated) {
    measurement.vdr = {
      status: 'unmeasured',
      source: 'repid_agents.vdr_count',
      reason: `agent count exceeded the ${SAMPLE_CAP}-row sample cap; a partial sum would be a lower bound`,
    };
  } else {
    vdr = (vdrRows.rows ?? []).reduce((s: number, r: any) => s + (Number(r?.vdr_count) || 0), 0);
    measurement.vdr = {
      status: 'measured',
      window: 'all_time',
      source: 'repid_agents.vdr_count',
      basis: (vdrRows.rows ?? []).length,
    };
  }

  // --- decisions ------------------------------------------------------------
  const decisions = decisionsCount.value;
  measurement.decisions = decisionsCount.error
    ? {
        status: 'failed',
        source: 'repid_score_events.llm_provider',
        reason: decisionsCount.error,
      }
    : { status: 'measured', window: 'all_time', source: 'repid_score_events.llm_provider' };

  // --- hallucinations + catch rate -----------------------------------------
  const hallucinations = hallucinationsCount.value;
  measurement.hallucinations = hallucinationsCount.error
    ? {
        status: 'failed',
        source: 'repid_score_events.hallucination_caught',
        reason: hallucinationsCount.error,
      }
    : {
        status: 'measured',
        window: 'all_time',
        source: 'repid_score_events.hallucination_caught',
      };

  let hallucinationCatchRate: number | null = null;
  if (hallucinationsCount.error || eventsTotal.error) {
    measurement.hallucination_catch_rate = {
      status: 'failed',
      source: 'repid_score_events',
      reason: hallucinationsCount.error ?? eventsTotal.error ?? 'query failed',
    };
  } else if (!eventsTotal.value) {
    measurement.hallucination_catch_rate = {
      status: 'unmeasured',
      source: 'repid_score_events',
      reason: 'no score events to divide by',
    };
  } else {
    hallucinationCatchRate = round((hallucinations as number) / eventsTotal.value, 4);
    measurement.hallucination_catch_rate = {
      status: 'measured',
      window: 'all_time',
      source: 'repid_score_events.hallucination_caught',
      basis: eventsTotal.value,
    };
  }

  // --- active agents (24h) --------------------------------------------------
  let activeAgents24h: number | null = null;
  if (activeRows.error) {
    measurement.active_agents_24h = {
      status: 'failed',
      source: 'repid_score_events.agent_id',
      reason: activeRows.error,
    };
  } else if (activeRows.truncated) {
    measurement.active_agents_24h = {
      status: 'unmeasured',
      window: '24h',
      source: 'repid_score_events.agent_id',
      reason: `window exceeded the ${SAMPLE_CAP}-row sample cap; a distinct count over a truncated sample is a lower bound, not a total`,
    };
  } else {
    const ids = new Set((activeRows.rows ?? []).map((r: any) => r?.agent_id).filter(Boolean));
    activeAgents24h = ids.size;
    measurement.active_agents_24h = {
      status: 'measured',
      window: '24h',
      source: 'repid_score_events.agent_id',
      basis: (activeRows.rows ?? []).length,
    };
  }

  // --- providers + avg response time (24h) ---------------------------------
  let providers: number | null = null;
  let avgResponseMs: number | null = null;
  if (llmRows.error) {
    const failed: Measurement = {
      status: 'failed',
      source: 'llm_call_log',
      reason: llmRows.error,
    };
    measurement.providers = failed;
    measurement.avg_response_ms = failed;
  } else if (llmRows.truncated) {
    const capped: Measurement = {
      status: 'unmeasured',
      window: '24h',
      source: 'llm_call_log',
      reason: `window exceeded the ${SAMPLE_CAP}-row sample cap; the result would describe a truncated sample, not the window`,
    };
    measurement.providers = capped;
    measurement.avg_response_ms = capped;
  } else {
    const rows = llmRows.rows ?? [];
    const names = new Set(rows.map((r: any) => r?.provider).filter(Boolean));
    providers = names.size;
    measurement.providers = {
      status: 'measured',
      window: '24h',
      source: 'llm_call_log.provider',
      basis: rows.length,
    };

    // Latency is averaged over SUCCESSFUL calls only — a timeout's latency measures
    // the timeout, not the service, and mixing them reports a slower system as faster
    // the more it fails.
    const latencies = rows
      .filter((r: any) => String(r?.status ?? '').toLowerCase() === 'success')
      .map((r: any) => Number(r?.latency_ms))
      .filter((n: number) => Number.isFinite(n));
    if (latencies.length === 0) {
      measurement.avg_response_ms = {
        status: 'unmeasured',
        window: '24h',
        source: 'llm_call_log.latency_ms',
        reason: 'no successful calls with a recorded latency in the window',
      };
    } else {
      avgResponseMs = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      measurement.avg_response_ms = {
        status: 'measured',
        window: '24h',
        source: 'llm_call_log.latency_ms',
        basis: latencies.length,
      };
    }
  }

  // --- HAL approval / veto rate (24h) --------------------------------------
  // Decision strings the engine actually emits, observed in the ledger: 'clean',
  // 'flagged', 'vetoed', 'APPROVE'. Matched case-insensitively because both cases
  // are present — an exact-match list would silently drop one of them (LESSONS 5).
  // 'flagged' is neither an approval nor a veto, so the two rates deliberately do
  // NOT sum to 1: reporting `approval = 1 - veto` would classify every flag as an
  // approval.
  let halApprovalRate: number | null = null;
  let halVetoRate24h: number | null = null;
  if (halRows.error) {
    const failed: Measurement = {
      status: 'failed',
      source: 'repid_score_events.hal_decision',
      reason: halRows.error,
    };
    measurement.hal_approval_rate = failed;
    measurement.hal_veto_rate_24h = failed;
  } else if (halRows.truncated) {
    const capped: Measurement = {
      status: 'unmeasured',
      window: '24h',
      source: 'repid_score_events.hal_decision',
      reason: `window exceeded the ${SAMPLE_CAP}-row sample cap; a rate over a truncated sample is not the window's rate`,
    };
    measurement.hal_approval_rate = capped;
    measurement.hal_veto_rate_24h = capped;
  } else {
    const decisionsIn = (halRows.rows ?? [])
      .map((r: any) => String(r?.hal_decision ?? '').toLowerCase())
      .filter(Boolean);
    if (decisionsIn.length === 0) {
      const none: Measurement = {
        status: 'unmeasured',
        window: '24h',
        source: 'repid_score_events.hal_decision',
        reason: 'no HAL decisions recorded in the window',
      };
      measurement.hal_approval_rate = none;
      measurement.hal_veto_rate_24h = none;
    } else {
      const approved = decisionsIn.filter((d) => d === 'clean' || d === 'approve').length;
      const vetoed = decisionsIn.filter((d) => d === 'vetoed').length;
      halApprovalRate = round((approved / decisionsIn.length) * 100, 2);
      halVetoRate24h = round(vetoed / decisionsIn.length, 4);
      const m: Measurement = {
        status: 'measured',
        window: '24h',
        source: 'repid_score_events.hal_decision',
        basis: decisionsIn.length,
      };
      measurement.hal_approval_rate = m;
      measurement.hal_veto_rate_24h = { ...m };
    }
  }

  // --- process uptime -------------------------------------------------------
  // Seconds since THIS process started. Not an availability percentage: a process
  // cannot report the time it was not running, which is exactly why the old
  // `uptime_pct: 99.9` was unmeasurable here and is not reproduced. This number is
  // read from the runtime and is always real.
  measurement.process_uptime_s = { status: 'measured', source: 'process.uptime()' };

  return {
    agents,
    active_agents_24h: activeAgents24h,
    vdr,
    decisions,
    providers,
    hallucinations,
    hallucination_catch_rate: hallucinationCatchRate,
    hal_approval_rate: halApprovalRate,
    hal_veto_rate_24h: halVetoRate24h,
    avg_response_ms: avgResponseMs,
    process_uptime_s: Math.round(process.uptime()),
    staking_contract: STAKING_CONTRACT,
    identity_registry: IDENTITY_REGISTRY,
    as_of: new Date().toISOString(),
    measurement,
  };
}

/**
 * The public snapshot, TTL-cached per process. `db` is injectable so tests drive it
 * with a stub instead of the live client.
 */
export async function getMetricsSnapshot(db: any = defaultDb): Promise<MetricsSnapshot> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.snapshot;
  if (inFlight) return inFlight;

  inFlight = computeSnapshot(db)
    .then((snapshot) => {
      cache = { snapshot, expiresAt: Date.now() + ttlMs() };
      return snapshot;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
