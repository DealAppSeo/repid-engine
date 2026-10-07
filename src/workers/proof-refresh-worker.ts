/**
 * proof-refresh-worker — re-prove an IDLE agent's unchanged score before its served proof ages
 * past the freshness rule.
 *
 * WHY THIS EXISTS. A postcard proof is only made on a score event (the score-event routes enqueue
 * a `repid_proof_queue` job and POST `{agent_id, score}` to `${ZKP_SERVICE_URL}/zkp/repid-proof`).
 * An agent that stops scoring keeps a proof that still attests its CURRENT score, but the proof
 * itself ages. `GET /api/v1/repid/:agentId/proof` serves the latest real proof, and the trustshell
 * cold-install gate (`zkrepid.freshness`) fails anything older than the 7-day
 * rule in `src/zkp/proof-freshness.ts` (one constant, shared with trustshell). MEASURED 2026-10-04 by CC2:
 * trinity-sophia's proof was 10 days old because she had not scored since, not because the
 * pipeline was broken.
 *
 * WHAT IT DOES, and nothing more. Each tick: select agents whose latest real proof is older than
 * `PROOF_REFRESH_MAX_AGE_DAYS` (default 6 — one day inside the 7-day rule), oldest first, at most
 * `PROOF_REFRESH_MAX_AGENTS` (default 25). For each, re-prove `current_repid` through the SAME
 * two steps the score-event route uses: insert a `repid_proof_queue` job bound to the agent's
 * latest score event, then POST the score to the postcard prover. It writes nothing else — no
 * score, no event, no proof row of its own.
 *
 * GUARDS
 *
 * 1. DEFAULT OFF (`PROOF_REFRESH_ENABLED`). Zero change at merge; Sean flips it on Railway.
 * 2. HONOURS THE L0 HALT, like every other mutating loop (`shouldParkForHalt`).
 * 3. RE-ENTRANCY GUARD — a slow prover cannot stack ticks.
 * 4. BOUNDED. At most N agents per tick, and an agent with ANY proof-queue job younger than one
 *    interval is skipped, so a restart loop cannot re-enqueue the same agents on every boot.
 * 5. NEVER PROVES A SCORE IT CANNOT BIND. The drain proves the job's event `repid_after`, so the
 *    job is only enqueued when the latest event's `repid_after` equals `current_repid`. Otherwise
 *    the agent is skipped and logged (`score_mismatch`) — proving a different number than the one
 *    we claim to refresh would be a fabricated attestation.
 * 6. NO PRIOR REAL PROOF → SKIP. First proofs come from registration/genesis, not from here.
 *
 * IT CANNOT BREAK A REQUEST. Every path is caught and logged; a prover error is reported as a
 * prover error and never thrown into the server.
 */
import crypto from 'crypto';
import { db } from '../db';
import { pgQuery } from '../db/direct-pg';
import { shouldParkForHalt } from '../services/emergency-halt';
import { PINNED_PROVER_URL } from '../config/prover';

const WORKER = 'proof-refresh';

export const DEFAULT_MAX_AGE_DAYS = 6;
export const DEFAULT_MAX_AGENTS = 25;
/** 6h: four chances a day to catch an agent between day 6 and day 7. */
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** First tick lands a few minutes after boot, not at boot (crash-loop safety). */
const FIRST_TICK_DELAY_MS = 5 * 60 * 1000;
const PROVER_TIMEOUT_MS = 30_000;
const DEFAULT_PROVER_URL = PINNED_PROVER_URL;

export interface RefreshCandidate {
  agent_id: string;
  agent_name: string | null;
  current_repid: number | null;
  last_proof_at: string | null;
  event_id: string | null;
  repid_after: number | null;
}

export type RefreshDecision =
  | { action: 'refresh'; agentId: string; agentName: string | null; score: number; eventId: string }
  | { action: 'skip'; agentId: string; reason: 'no_prior_real_proof' | 'fresh' | 'no_score_event' | 'score_mismatch' | 'over_bound' };

export interface RefreshConfig {
  maxAgeDays: number;
  maxAgents: number;
  intervalMs: number;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Literal `process.env.NAME` reads so the generated env registry discovers every knob. */
export function readConfig(): RefreshConfig {
  return {
    maxAgeDays: positiveNumber(process.env.PROOF_REFRESH_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS),
    maxAgents: Math.floor(positiveNumber(process.env.PROOF_REFRESH_MAX_AGENTS, DEFAULT_MAX_AGENTS)),
    intervalMs: positiveNumber(process.env.PROOF_REFRESH_INTERVAL_MS, DEFAULT_INTERVAL_MS),
  };
}

/**
 * Selection. Oldest proof first, real proofs only (same predicate the served route prefers:
 * plonky3_range_check with proof bytes), stale past `maxAgeDays`, and no proof-queue job for the
 * agent inside the dedupe window. The latest score event rides along so the decision below can
 * bind the job to it. LIMIT is the bound; `decide` enforces it again.
 */
export const SELECT_CANDIDATES_SQL = `
SELECT a.id AS agent_id, a.agent_name, a.current_repid,
       p.last_proof_at, e.id AS event_id, e.repid_after
  FROM repid_agents a
  JOIN LATERAL (
    SELECT max(z.created_at) AS last_proof_at
      FROM repid_zkp_proofs z
     WHERE z.agent_id = a.id
       AND z.is_real IS TRUE
       AND z.scheme = 'plonky3_range_check'
       AND z.proof_bytes IS NOT NULL
  ) p ON p.last_proof_at IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT s.id, s.repid_after
      FROM repid_score_events s
     WHERE s.agent_id = a.id
     ORDER BY s.created_at DESC
     LIMIT 1
  ) e ON true
 WHERE p.last_proof_at < now() - make_interval(secs => $1)
   AND NOT EXISTS (
     SELECT 1 FROM repid_proof_queue q
      WHERE q.agent_id = a.id
        AND q.created_at > now() - make_interval(secs => $3)
   )
 ORDER BY p.last_proof_at ASC
 LIMIT $2`;

/** Pure: turn candidate rows into decisions. Re-checks every rule the SQL applies. */
export function decide(rows: RefreshCandidate[], cfg: RefreshConfig, now: Date = new Date()): RefreshDecision[] {
  const cutoff = now.getTime() - cfg.maxAgeDays * 86_400_000;
  const sorted = [...rows].sort((x, y) => Date.parse(x.last_proof_at ?? '') - Date.parse(y.last_proof_at ?? ''));
  const out: RefreshDecision[] = [];
  let taken = 0;
  for (const r of sorted) {
    const proofAt = r.last_proof_at ? Date.parse(r.last_proof_at) : NaN;
    if (!Number.isFinite(proofAt)) {
      out.push({ action: 'skip', agentId: r.agent_id, reason: 'no_prior_real_proof' });
      continue;
    }
    if (proofAt >= cutoff) {
      out.push({ action: 'skip', agentId: r.agent_id, reason: 'fresh' });
      continue;
    }
    if (!r.event_id || r.repid_after == null || r.current_repid == null) {
      out.push({ action: 'skip', agentId: r.agent_id, reason: 'no_score_event' });
      continue;
    }
    const score = Math.round(Number(r.current_repid));
    if (Math.round(Number(r.repid_after)) !== score) {
      out.push({ action: 'skip', agentId: r.agent_id, reason: 'score_mismatch' });
      continue;
    }
    if (taken >= cfg.maxAgents) {
      out.push({ action: 'skip', agentId: r.agent_id, reason: 'over_bound' });
      continue;
    }
    taken++;
    out.push({ action: 'refresh', agentId: r.agent_id, agentName: r.agent_name, score, eventId: r.event_id });
  }
  return out;
}

export interface RefreshDeps {
  query: (sql: string, params: unknown[]) => Promise<RefreshCandidate[]>;
  enqueue: (row: { job_id: string; agent_id: string; event_id: string; status: 'pending'; zkp_service_url: string }) => Promise<{ error: { message: string } | null }>;
  fetchImpl: typeof fetch;
  proverUrl: string;
  isHalted: () => Promise<boolean>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

function defaultDeps(): RefreshDeps {
  return {
    query: (sql, params) => pgQuery<any>(sql, params as any[], { retries: 1, label: 'proofRefreshCandidates' }),
    enqueue: async (row) => {
      const { error } = await db.from('repid_proof_queue').insert(row);
      return { error: error ? { message: error.message } : null };
    },
    fetchImpl: (...a) => fetch(...a),
    proverUrl: process.env.ZKP_SERVICE_URL || DEFAULT_PROVER_URL,
    isHalted: () => shouldParkForHalt(db, WORKER),
    log: (m) => console.log(`[${WORKER}] ${m}`),
    warn: (m) => console.error(`[${WORKER}] ${m}`),
  };
}

export interface TickSummary {
  ran: boolean;
  candidates: number;
  enqueued: number;
  proverOk: number;
  proverFailed: number;
  skipped: Record<string, number>;
}

let running = false;

/** One tick. Never throws. Returns what it did so the log line and the tests read the same thing. */
export async function runOnce(cfg: RefreshConfig = readConfig(), deps: RefreshDeps = defaultDeps()): Promise<TickSummary> {
  const summary: TickSummary = { ran: false, candidates: 0, enqueued: 0, proverOk: 0, proverFailed: 0, skipped: {} };
  if (process.env.PROOF_REFRESH_ENABLED !== 'true') return summary;
  if (running) {
    deps.warn('previous tick still running — skipping (re-entrancy guard)');
    return summary;
  }
  running = true;
  try {
    if (await deps.isHalted()) return summary;
    summary.ran = true;

    const rows = await deps.query(SELECT_CANDIDATES_SQL, [
      Math.round(cfg.maxAgeDays * 86_400),
      cfg.maxAgents,
      Math.round(cfg.intervalMs / 1000),
    ]);
    summary.candidates = rows.length;

    const base = deps.proverUrl.replace(/\/+$/, '');
    for (const d of decide(rows, cfg)) {
      if (d.action === 'skip') {
        summary.skipped[d.reason] = (summary.skipped[d.reason] ?? 0) + 1;
        if (d.reason === 'score_mismatch' || d.reason === 'no_score_event') {
          deps.log(`skip ${d.agentId}: ${d.reason}`);
        }
        continue;
      }

      const jobId = crypto.randomUUID();
      const { error } = await deps.enqueue({
        job_id: jobId,
        agent_id: d.agentId,
        event_id: d.eventId,
        status: 'pending',
        zkp_service_url: base,
      });
      if (error) {
        // Do not POST a job the queue does not know about — same rule as the register path.
        deps.warn(`enqueue failed for ${d.agentId}: ${error.message}`);
        continue;
      }
      summary.enqueued++;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROVER_TIMEOUT_MS);
      try {
        const res = await deps.fetchImpl(`${base}/zkp/repid-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: d.agentId, score: d.score, metadata: { job_id: jobId, refresh: true } }),
          signal: controller.signal,
        });
        if (res.ok) {
          summary.proverOk++;
        } else {
          summary.proverFailed++;
          deps.warn(`prover HTTP ${res.status} for ${d.agentId} (job ${jobId} stays queued)`);
        }
      } catch (e: any) {
        summary.proverFailed++;
        deps.warn(`prover call failed for ${d.agentId} (job ${jobId} stays queued): ${e?.message ?? e}`);
      } finally {
        clearTimeout(timer);
      }
    }

    deps.log(
      `tick: ${summary.candidates} candidates, ${summary.enqueued} enqueued, prover ok ${summary.proverOk} / failed ${summary.proverFailed}, ` +
        `skipped ${JSON.stringify(summary.skipped)}`,
    );
  } catch (e: any) {
    // Never propagate: this runs on a timer beside the request path.
    deps.warn(`tick failed: ${e?.message ?? e}`);
  } finally {
    running = false;
  }
  return summary;
}

let firstTimer: NodeJS.Timeout | null = null;
let timer: NodeJS.Timeout | null = null;

/** Start the loop. No-op unless `PROOF_REFRESH_ENABLED === 'true'`. */
export function startProofRefreshWorker(cfg: RefreshConfig = readConfig()): boolean {
  if (process.env.PROOF_REFRESH_ENABLED !== 'true') return false;
  if (timer || firstTimer) return true; // idempotent

  firstTimer = setTimeout(() => {
    firstTimer = null;
    void runOnce(cfg);
    timer = setInterval(() => { void runOnce(cfg); }, cfg.intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }, FIRST_TICK_DELAY_MS);
  if (typeof firstTimer.unref === 'function') firstTimer.unref();
  console.log(
    `[${WORKER}] started (every ${Math.round(cfg.intervalMs / 1000)}s, max ${cfg.maxAgents} agents, proofs older than ${cfg.maxAgeDays}d)`,
  );
  return true;
}

/** For tests and graceful shutdown. */
export function stopProofRefreshWorker(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
  running = false;
}
