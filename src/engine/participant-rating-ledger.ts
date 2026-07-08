/**
 * participant-rating-ledger.ts — the append-only writer for the participant-rating
 * graph + the RepID-dogfood accountability ledger (Trust Harness M3 + Part B).
 *
 * SHADOW-FIRST (the DISCIPLINE this sprint is built on):
 *   PARTICIPANT_RATING_MODE=shadow  (DEFAULT) → COMPUTE the ledger row + the would-be
 *     RepID delta, LOG it, and return it. Do NOT insert to the DB, do NOT mutate any
 *     live current_repid. Zero live RepID change. This is a pure measurement.
 *   PARTICIPANT_RATING_MODE=live   (Sean-gated) → insert the row into
 *     participant_rating_ledger (migrations/2026-07-08-participant-rating-ledger.sql).
 *     Even in live mode this writer NEVER mutates repid_agents.current_repid — it only
 *     records the rating edge / the would-be delta. Promoting a verified dogfood delta
 *     into live RepID is a SEPARATE, explicitly-gated step through the RepID engine.
 *
 * WHY A NEW TABLE (reuse was checked first): repid_score_events.event_type is a
 * CHECK-constrained whitelist that rejects a participant-rating event type, and its
 * agent_id is a FK to repid_agents — but LLM/SLM ratees are not agents. So the rating
 * graph needs its own sink. The RepID engine (repid_score_events) remains the sink for
 * AGENT score changes; this table is the RATING-EDGE log. See the migration header.
 *
 * The 5 laws are enforced in participant-rating.ts (validateRatingEdge / edgeWeight /
 * aggregateRatings). This module is the persistence + dogfood bridge; it re-runs the
 * L1/L2/L5 validation before writing so an invalid edge can NEVER be persisted.
 */

import {
  RatingEdge,
  RatingPolicy,
  validateRatingEdge,
  edgeWeight,
  assertFamilyDisjoint,
  VerificationStrength,
} from './participant-rating';

export type ParticipantRatingMode = 'shadow' | 'live';

/**
 * Resolve the mode from env. SHADOW-FIRST: anything other than the explicit
 * 'live' resolves to 'shadow' — live is never incidental (mirrors the deception
 * gate's shadow-first posture in repid-update.ts).
 */
export function participantRatingMode(): ParticipantRatingMode {
  return (process.env.PARTICIPANT_RATING_MODE || '').toLowerCase() === 'live' ? 'live' : 'shadow';
}

/** The row shape written to participant_rating_ledger (mirrors the migration columns). */
export interface ParticipantRatingLedgerRow {
  rater_id: string;
  rater_kind: string;
  rater_family: string | null;
  rater_repid_at_event: number | null;
  ratee_id: string;
  ratee_kind: string;
  ratee_family: string | null;
  verification_strength: VerificationStrength;
  engagement_receipt_ref: string;
  axes: Record<string, number>;
  stake_usd: number;
  rater_bonded: boolean;
  edge_weight: number;
  collusion_flagged: boolean;
  family_conflict_flagged: boolean;
  work_ref: string | null;
  verified_by: string | null;
  repid_delta: number | null;
  repid_applied: boolean;
  mode: ParticipantRatingMode;
  note: string | null;
  metadata: Record<string, unknown> | null;
}

export interface WriteResult {
  /** whether the edge passed the 5-law validation and was accepted for the ledger. */
  accepted: boolean;
  /** the codes of any laws that rejected the edge (empty when accepted). */
  violations: string[];
  /** the row that was (shadow) computed or (live) inserted; null when rejected. */
  row: ParticipantRatingLedgerRow | null;
  /** the resolved mode. */
  mode: ParticipantRatingMode;
  /** true only when a real DB insert happened (live mode + accepted). */
  persisted: boolean;
}

/**
 * Turn a validated RatingEdge into a ledger row. Pure — no DB, no env side-effects
 * beyond reading the flag. `dogfood` carries the Part-B accountability fields (the
 * agent-work reference, the decorrelated reviewer, and the would-be RepID delta).
 */
export function edgeToLedgerRow(
  edge: RatingEdge,
  mode: ParticipantRatingMode,
  opts: {
    collusionFlagged?: boolean;
    familyConflictFlagged?: boolean;
    dogfood?: { workRef: string; verifiedBy: string; repidDelta: number };
    note?: string;
    metadata?: Record<string, unknown>;
    now?: number;
  } = {},
): ParticipantRatingLedgerRow {
  const w = edgeWeight(
    edge,
    { collusionContaminated: opts.collusionFlagged, unbondedDiscount: false },
    opts.now,
  ).weight;

  // Only the measured axes go in — never a collapsed score (L5).
  const axes: Record<string, number> = {};
  for (const [k, v] of Object.entries(edge.axes)) {
    if (typeof v === 'number') axes[k] = v;
  }

  return {
    rater_id: edge.rater.id,
    rater_kind: edge.rater.kind,
    rater_family: edge.rater.family ?? null,
    rater_repid_at_event: typeof edge.rater.repId === 'number' ? edge.rater.repId : null,
    ratee_id: edge.ratee.id,
    ratee_kind: edge.ratee.kind,
    ratee_family: edge.ratee.family ?? null,
    verification_strength: edge.verificationStrength,
    engagement_receipt_ref: edge.engagementReceiptRef,
    axes,
    stake_usd: typeof edge.stakeUsd === 'number' ? edge.stakeUsd : 0,
    rater_bonded: edge.raterBonded === true,
    edge_weight: w,
    collusion_flagged: opts.collusionFlagged === true,
    family_conflict_flagged: opts.familyConflictFlagged === true,
    // SHADOW-FIRST: in shadow mode repid_applied is ALWAYS false — the delta is a
    // measurement, never mutated into live current_repid. In live mode this writer
    // STILL records the edge only; promoting a delta into live RepID is a separate
    // gated step, so repid_applied stays false here regardless of mode.
    work_ref: opts.dogfood?.workRef ?? null,
    verified_by: opts.dogfood?.verifiedBy ?? null,
    repid_delta: opts.dogfood ? opts.dogfood.repidDelta : null,
    repid_applied: false,
    mode,
    note: opts.note ?? edge.note ?? null,
    metadata: opts.metadata ?? null,
  };
}

/**
 * Record a rating edge to the ledger. SHADOW-FIRST by default.
 *   - Re-runs the 5-law validation (L1/L2/L5 hard gate); an INVALID edge is
 *     REJECTED — never logged as a rating, never inserted.
 *   - shadow mode: logs the would-be row + returns it; NO DB write, NO score change.
 *   - live mode:   inserts into participant_rating_ledger; still NO score change.
 *
 * `db` is injected (the caller passes the supabase client) so this module holds no
 * hard DB dependency and stays unit-testable without a live connection.
 */
export async function recordRatingEdge(
  edge: RatingEdge,
  opts: {
    db?: { from: (t: string) => any };
    policy?: RatingPolicy;
    dogfood?: { workRef: string; verifiedBy: string; repidDelta: number };
    collusionFlagged?: boolean;
    familyConflictFlagged?: boolean;
    note?: string;
    metadata?: Record<string, unknown>;
    now?: number;
  } = {},
): Promise<WriteResult> {
  const mode = participantRatingMode();
  const validation = validateRatingEdge(edge, opts.policy);

  if (!validation.valid) {
    // REJECTED — an invalid edge is never a rating (L1/L2/L5). Log loudly, no write.
    console.warn(
      `[participant-rating] REJECTED edge ${edge.rater.id}→${edge.ratee.id}: ${validation.violations.join(', ')}`,
    );
    return { accepted: false, violations: validation.violations, row: null, mode, persisted: false };
  }

  const row = edgeToLedgerRow(edge, mode, {
    collusionFlagged: opts.collusionFlagged,
    familyConflictFlagged: opts.familyConflictFlagged,
    dogfood: opts.dogfood,
    note: opts.note,
    metadata: opts.metadata,
    now: opts.now,
  });

  if (mode === 'shadow') {
    // Pure measurement — log the would-be row, mutate nothing.
    console.log(
      `[participant-rating:shadow] would record ${row.rater_id}→${row.ratee_id} ` +
      `(${row.verification_strength}, w=${row.edge_weight.toFixed(4)}` +
      (row.repid_delta != null ? `, would-be RepID Δ=${row.repid_delta}, applied=false` : '') +
      `) — receipt=${row.engagement_receipt_ref}`,
    );
    return { accepted: true, violations: [], row, mode, persisted: false };
  }

  // live mode — insert the edge (still NO current_repid mutation).
  if (!opts.db) {
    console.warn('[participant-rating:live] no db injected — cannot persist; returning row un-persisted.');
    return { accepted: true, violations: [], row, mode, persisted: false };
  }
  const { error } = await opts.db.from('participant_rating_ledger').insert(row);
  if (error) {
    // fail-loud (RULE-11): never silently swallow a ledger write failure.
    throw new Error(`[participant-rating] ledger insert FAILED for ${row.rater_id}→${row.ratee_id}: ${error.message}`);
  }
  return { accepted: true, violations: [], row, mode, persisted: true };
}

/**
 * Batch-record a set of edges. Runs the L4 family-disjoint check across the batch
 * FIRST (a single edge cannot see the full rater set), flags the conflicted edges,
 * and records each. Returns the per-edge write results. SHADOW-FIRST like the
 * single-edge path.
 */
export async function recordRatingEdges(
  edges: RatingEdge[],
  opts: {
    db?: { from: (t: string) => any };
    policy?: RatingPolicy;
    note?: string;
    metadata?: Record<string, unknown>;
    now?: number;
  } = {},
): Promise<WriteResult[]> {
  // L4 family-disjoint over the whole batch (a same-family sole rater is flagged).
  const conflicted = new Set(assertFamilyDisjoint(edges).conflicted);
  const results: WriteResult[] = [];
  for (const e of edges) {
    results.push(
      await recordRatingEdge(e, {
        ...opts,
        familyConflictFlagged: conflicted.has(e),
      }),
    );
  }
  return results;
}
