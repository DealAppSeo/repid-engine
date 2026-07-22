/**
 * cosign-consumer.ts — the missing consumer for the `awaiting_cosign` dispatch stage.
 *
 * BACKGROUND (P0.6, longest-open dispatch gap): the auto-dispatch loop parks a finished
 * task at `status = 'awaiting_cosign'` and waits for a DISJOINT co-signer to sign off the
 * artifact before the task may be called `done`. Nothing on `origin/main` ever flips those
 * tasks forward, so they pile up forever. This module is that flip — and ONLY that flip.
 *
 * FAIL-CLOSED (the whole point): a task advances to `done` ONLY when a real co-sign PASS by an
 * agent that is provably NOT the producer is present on the row. Any missing field, any
 * self-cosign, any non-PASS verdict, any malformed record, any DB error → the task is LEFT
 * where it is (never marked done). "When in doubt, do not advance." A stuck task is a safe
 * state; a wrongly-`done` task is a trust breach (RULE-4 / no fake-pass steers state).
 *
 * SHADOW-FIRST + FLAG-GATED: the whole consumer is dark unless `COSIGN_CONSUMER_ENABLED=true`.
 * Default OFF changes zero live behavior — this file is additive and is NOT wired into the
 * boot path (src/index.ts) on purpose. Run it explicitly via scripts/dispatch/cosign-consumer.ts.
 *
 * NO NEW STATUS VALUES ARE INVENTED on the not-advance path — we do not write a status the DB
 * CHECK constraint may reject, and we do not touch prod DDL. Not-advance == leave the row alone.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

// ---- config (all env-driven, safe defaults) --------------------------------
/** Master switch. DEFAULT OFF — must be the literal string 'true' to run. */
export const cosignConsumerEnabled = (): boolean =>
  (process.env.COSIGN_CONSUMER_ENABLED || 'false').toLowerCase() === 'true';

/** The status the dispatch loop parks tasks at while they await a co-sign. */
export const awaitingStatus = (): string => process.env.COSIGN_AWAITING_STATUS || 'awaiting_cosign';
/** The status a co-signed task graduates to. */
export const doneStatus = (): string => process.env.COSIGN_DONE_STATUS || 'done';

const POLL_INTERVAL_MS = parseInt(process.env.COSIGN_CONSUMER_POLL_MS || '300000', 10);
const BATCH = parseInt(process.env.COSIGN_CONSUMER_BATCH || '25', 10);

/**
 * Verdict tokens that count as an explicit PASS. Everything else fails closed.
 * DELIBERATELY TIGHT: bare 'ok' and the stringy 'true' were removed — an ambiguous
 * acknowledgement ('ok') or a coerced-to-string boolean is NOT an explicit positive
 * verdict. A genuine boolean verdict `=== true` is handled separately (see isPassVerdict).
 */
const PASS_TOKENS = new Set(['pass', 'passed', 'verified', 'approved', 'confirmed', 'accept', 'accepted']);

/**
 * Is this verdict an explicit positive PASS? Only two things qualify:
 *   - a genuine boolean `true` (a structured verdict field), or
 *   - one of the explicit PASS token strings above.
 * Everything else — `false`, null, numbers, the string 'true', 'ok', '', unknown tokens — HOLDS.
 */
const isPassVerdict = (verdict: string | boolean | null | undefined): boolean => {
  if (verdict === true) return true; // genuine structured boolean PASS
  if (typeof verdict !== 'string') return false; // false / null / number / object → hold
  return PASS_TOKENS.has(norm(verdict));
};

// ---- pure, DB-free decision core (unit-testable) ---------------------------

/** A co-sign record distilled from a task row: who signed and what they said. */
export interface CosignRecord {
  cosigner: string | null;
  /** Either an explicit verdict token, or a genuine boolean verdict. */
  verdict: string | boolean | null;
}

/** The minimal shape the decision needs — decoupled from the full DB row. */
export interface CosignTask {
  id: number | string;
  /**
   * EVERY present producer identity on the row — the union of {claimed_by, completed_by,
   * agent_assigned}. Disjointness is checked against ALL of them, not just the first non-null,
   * so a co-signer that matches any producer field is rejected. Empty array = producer unknown.
   */
  producers: string[];
  /** The artifact under review (artifact_url / external_artifact_url). */
  artifactUrl: string | null;
  /** The disjoint co-sign, if any. */
  cosign: CosignRecord | null;
}

export interface CosignDecision {
  advance: boolean;
  reason: string;
}

const norm = (s: string | null | undefined): string => (s || '').trim().toLowerCase();

/** Preserve a genuine boolean verdict; otherwise stringify (or null). Keeps `true`/`false` distinct
 * from the strings 'true'/'false' so only a real structured boolean can PASS via isPassVerdict. */
const normVerdict = (v: unknown): string | boolean | null =>
  typeof v === 'boolean' ? v : v != null ? String(v) : null;

/**
 * The fail-closed gate. Returns advance:true ONLY when every condition holds:
 *  1. an artifact exists to co-sign,
 *  2. a co-sign record with a named co-signer exists,
 *  3. at least one producer identity is known (else disjointness is unprovable → fail closed),
 *  4. the co-signer is DISJOINT from EVERY present producer identity — it must match NONE of
 *     {claimed_by, completed_by, agent_assigned} (no self-cosign / rubber-stamp), case-insensitive,
 *  5. the verdict is an explicit PASS token, or a genuine boolean `true`.
 * Any other case → advance:false with a reason. Never throws.
 */
export function evaluateCosign(task: CosignTask): CosignDecision {
  if (!task || !task.artifactUrl) return { advance: false, reason: 'no-artifact' };
  const cosign = task.cosign;
  if (!cosign || !cosign.cosigner) return { advance: false, reason: 'no-cosign-record' };

  // Collect every present producer identity (defensive: tolerate a non-array/garbage field).
  const producers = (Array.isArray(task.producers) ? task.producers : []).filter((p) => norm(p) !== '');
  if (producers.length === 0) return { advance: false, reason: 'unknown-producer:disjointness-unprovable' };

  // Disjointness is the load-bearing check: the co-signer must not match ANY producer field.
  const signer = norm(cosign.cosigner);
  const clash = producers.find((p) => norm(p) === signer);
  if (clash) {
    return { advance: false, reason: `self-cosign-not-disjoint:${clash}` };
  }
  if (!isPassVerdict(cosign.verdict)) {
    return { advance: false, reason: `cosign-not-pass:${cosign.verdict ?? 'null'}` };
  }
  return { advance: true, reason: `cosign-pass by ${cosign.cosigner}` };
}

/**
 * Distill a co-sign record from a raw trinity_tasks row. Tolerant + defensive: any parse
 * surprise returns null (→ fail closed). Recognized sources, in priority order:
 *   1. metadata.cosign  = { cosigner|agent|verifier, verdict|result|vote }
 *   2. signatures[]     = [{ agent|cosigner, verdict|result }, ...] — first disjoint-looking entry
 * We do NOT trust `verified_by` alone: it records who looked, not a PASS verdict.
 */
export function extractCosignRecord(row: any): CosignRecord | null {
  try {
    const md = row?.metadata;
    const c = md && typeof md === 'object' ? (md.cosign ?? md.co_sign) : null;
    if (c && typeof c === 'object') {
      const cosigner = c.cosigner ?? c.agent ?? c.verifier ?? c.reviewer ?? null;
      const verdict = c.verdict ?? c.result ?? c.vote ?? c.decision ?? null;
      if (cosigner || verdict != null) {
        return { cosigner: cosigner ? String(cosigner) : null, verdict: normVerdict(verdict) };
      }
    }
    const sigs = row?.signatures;
    if (Array.isArray(sigs)) {
      for (const s of sigs) {
        if (s && typeof s === 'object') {
          const cosigner = s.cosigner ?? s.agent ?? s.verifier ?? s.reviewer ?? null;
          const verdict = s.verdict ?? s.result ?? s.vote ?? s.decision ?? null;
          if (cosigner || verdict != null) {
            return { cosigner: cosigner ? String(cosigner) : null, verdict: normVerdict(verdict) };
          }
        }
      }
    }
    return null;
  } catch {
    return null; // malformed → fail closed
  }
}

/**
 * Map a raw trinity_tasks row to the decision shape. Producers = EVERY present identity among
 * {claimed_by, completed_by, agent_assigned} (not just the first non-null) — disjointness is then
 * checked against all of them, so a co-signer matching any producer field is rejected.
 */
export function toCosignTask(row: any): CosignTask {
  const producers = [row?.claimed_by, row?.completed_by, row?.agent_assigned]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '');
  return {
    id: row?.id,
    producers,
    artifactUrl: row?.artifact_url ?? row?.external_artifact_url ?? null,
    cosign: extractCosignRecord(row),
  };
}

// ---- DB runner (thin; leans on the pure core) ------------------------------

export interface SweepResult {
  scanned: number;
  advanced: number;
  held: number;
}

/**
 * One pass: read a batch of awaiting-cosign tasks, decide each, and flip ONLY the passing
 * ones to `done`. The UPDATE is guarded on the awaiting status (`.eq('status', ...)`) so a
 * concurrent flip can't double-advance. Held tasks are left untouched (no status invented).
 */
export async function processAwaitingCosign(db: SupabaseClient): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, advanced: 0, held: 0 };
  const awaiting = awaitingStatus();

  const { data: rows, error } = await db
    .from('trinity_tasks')
    .select('*')
    .eq('status', awaiting)
    .limit(BATCH);

  if (error) {
    // Read failure is a fail-closed no-op, not a crash.
    console.error(`[CosignConsumer] read error (holding all): ${error.message}`);
    return result;
  }
  if (!rows || rows.length === 0) return result;

  for (const row of rows) {
    result.scanned += 1;
    const decision = evaluateCosign(toCosignTask(row));

    if (!decision.advance) {
      result.held += 1;
      console.log(`[CosignConsumer] HOLD task ${row.id}: ${decision.reason}`);
      continue;
    }

    // Advance — guarded so we only win the flip if the row is still awaiting.
    const nowIso = new Date().toISOString();
    const { data: updated, error: upErr } = await db
      .from('trinity_tasks')
      .update({ status: doneStatus(), completed_at: nowIso, verified_at: nowIso, updated_at: nowIso })
      .eq('id', row.id)
      .eq('status', awaiting)
      .select('id')
      .maybeSingle();

    if (upErr) {
      // Write failure → fail closed: it stays awaiting, gets retried next sweep.
      result.held += 1;
      console.error(`[CosignConsumer] advance FAILED task ${row.id} (holding): ${upErr.message}`);
      continue;
    }
    if (!updated) {
      // Lost the race (already flipped by another worker) — not an error.
      result.held += 1;
      console.log(`[CosignConsumer] task ${row.id} no longer awaiting (raced) — skipped`);
      continue;
    }
    result.advanced += 1;
    console.log(`[CosignConsumer] ADVANCE task ${row.id} → ${doneStatus()}: ${decision.reason}`);
  }

  return result;
}

// ---- interval lifecycle (opt-in) -------------------------------------------

let consumerInterval: NodeJS.Timeout | null = null;

/** Start the polling loop — NO-OP unless COSIGN_CONSUMER_ENABLED=true. */
export function startCosignConsumer(db: SupabaseClient): void {
  if (!cosignConsumerEnabled()) {
    console.log('[CosignConsumer] Disabled (COSIGN_CONSUMER_ENABLED != true) — not starting.');
    return;
  }
  if (consumerInterval) clearInterval(consumerInterval);
  console.log(
    `[CosignConsumer] Starting loop: status '${awaitingStatus()}' → '${doneStatus()}' every ${POLL_INTERVAL_MS}ms (fail-closed).`
  );
  consumerInterval = setInterval(() => {
    processAwaitingCosign(db).catch((e) => console.error('[CosignConsumer] sweep error:', e?.message));
  }, POLL_INTERVAL_MS);
  if (consumerInterval && typeof consumerInterval.unref === 'function') consumerInterval.unref();
}

export function stopCosignConsumer(): void {
  if (consumerInterval) {
    clearInterval(consumerInterval);
    consumerInterval = null;
    console.log('[CosignConsumer] Loop stopped.');
  }
}
