/**
 * VALIDATION LOOP WRITEBACK — Phase 2 bilateral RepID writeback
 * feat/cc-2026-06-17-validation-loop
 *
 * Wire peer_verification_queue terminal verdicts into repid_score_events for
 * BOTH agents (validator β + source α) — fully staged behind a feature flag.
 *
 * XC DEFENSES (VALIDATION_LOOP_BILATERAL_DEFENSES_v0.md §1–§5) implemented:
 *   D-1  anchor-gated reward   — full tier reward only when claim has a HAL anchor
 *   D-3  collusion cap         — skip reward when mutual-verify pair > 25/7d
 *   D-4  HMAC-bind verifier    — idempotency key binds verifier UUID explicitly
 *   D-5  diminishing returns   — reward multiplier = 1/sqrt(N verified in 24h)
 *   D-WT idempotency keys      — peer_verify:{id}:validator / peer_verify:{id}:source
 *
 * DEFAULT OFF: VALIDATION_WRITEBACK_ENABLED=false (env default).
 * Nothing moves RepID until Sean co-signs and sets this flag to "true".
 */

import { pgQuery } from '../db/direct-pg';
import { db } from '../db';
import { ScoreEventResult } from '../scoring/pipeline';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Micro-bootstrap reward for an unanchored verified claim (D-1) */
const MICRO_REWARD = 3;
/** Tier-1 validator reward when claim IS anchor-backed (D-1) */
const ANCHOR_REWARD_T1 = 40;
/** Full validator reward when claim is anchor-backed AND anchor agrees (D-1) */
const ANCHOR_REWARD_FULL = 120;
/** Source alpha reward on verified (tier-based) */
const SOURCE_VERIFIED_DELTA = 40;
/** Source alpha slash on sustained disputed */
const SOURCE_DISPUTED_DELTA = -30;
/** Validator penalty when β's verdict is later overturned */
const VALIDATOR_PENALTY_DELTA = -20;
/** Max mutual verified verifications per pair per 7-day window (D-3) */
const COLLUSION_CAP = 25;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationWritebackResult {
  skipped: boolean;
  skip_reason?: string;
  idempotent_replay?: boolean;
  validator_event?: ScoreEventResult;
  source_event?: ScoreEventResult;
  collusion_capped?: boolean;
  anchor_found?: boolean;
  diminishing_multiplier?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// D-3: Collusion cap — reject reward when mutual pair exceeds cap in 7d window
// ─────────────────────────────────────────────────────────────────────────────

async function isCollusionCapExceeded(
  verifierAgentId: string,
  sourceAgentId: string,
): Promise<boolean> {
  try {
    const rows = await pgQuery<{ n: string }>(
      `WITH mutual AS (
         SELECT count(*) AS n
         FROM peer_verification_queue
         WHERE verification_status = 'verified'
           AND completed_at > now() - interval '7 days'
           AND (
             (source_agent_id = $1 AND verifier_agent_id = $2)
             OR (source_agent_id = $2 AND verifier_agent_id = $1)
           )
       )
       SELECT COALESCE((SELECT n FROM mutual), 0) AS n`,
      [sourceAgentId, verifierAgentId],
      { label: 'validation-writeback-collusion-cap', retries: 1 },
    );
    const count = parseInt(rows[0]?.n ?? '0', 10);
    return count >= COLLUSION_CAP;
  } catch (err: any) {
    // XC GATE (§"Secondary seam — collusion check fail-open"): fail-CLOSED. If the cap cannot be
    // verified, treat the pair as capped (skip the validator reward) rather than pay out blind —
    // a check outage must not become a gaming path. An honest verifier loses at most one reward on
    // a transient DB error; a colluding ring cannot exploit a check failure.
    console.warn('[validation-writeback] collusion cap check failed → fail-closed (treating as capped):', err.message);
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D-5: Diminishing returns — 1/sqrt(N verified in last 24h)
// ─────────────────────────────────────────────────────────────────────────────

async function getRewardMultiplier(verifierAgentId: string): Promise<number> {
  try {
    const rows = await pgQuery<{ n: string }>(
      `SELECT count(*) AS n
       FROM peer_verification_queue
       WHERE verifier_agent_id = $1
         AND verification_status IN ('verified', 'disputed')
         AND completed_at > now() - interval '24 hours'`,
      [verifierAgentId],
      { label: 'validation-writeback-diminishing', retries: 1 },
    );
    const count = Math.max(1, parseInt(rows[0]?.n ?? '1', 10));
    return Math.round((1.0 / Math.sqrt(count)) * 10000) / 10000;
  } catch (err: any) {
    console.warn('[validation-writeback] diminishing returns check failed, multiplier=1:', err.message);
    return 1.0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D-1: Anchor-gated reward — check if source_response_id maps to a HAL anchor
// ─────────────────────────────────────────────────────────────────────────────

async function claimHasAnchor(sourceResponseId: string | null): Promise<boolean> {
  if (!sourceResponseId) return false;
  try {
    const { data: htc } = await db
      .from('hal_test_cases')
      .select('id')
      .eq('id', sourceResponseId)
      .maybeSingle();
    if (htc) return true;
    // Also check hal_canary_cases if it exists (best-effort)
    try {
      const { data: hcc } = await db
        .from('hal_canary_cases')
        .select('id')
        .eq('id', sourceResponseId)
        .maybeSingle();
      if (hcc) return true;
    } catch {
      // table may not exist yet — ignore
    }
    return false;
  } catch (err: any) {
    console.warn('[validation-writeback] anchor check failed, treating as unanchored:', err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency: check if this pvq row was already written back
// ─────────────────────────────────────────────────────────────────────────────

async function isAlreadyWrittenBack(pvqId: string | number): Promise<boolean> {
  try {
    const rows = await pgQuery<{ count: string }>(
      `SELECT count(*) AS count
       FROM repid_score_events
       WHERE idempotency_key LIKE $1`,
      [`peer_verify:${pvqId}:%`],
      { label: 'validation-writeback-idempotency-check', retries: 1 },
    );
    return parseInt(rows[0]?.count ?? '0', 10) > 0;
  } catch (err: any) {
    console.warn('[validation-writeback] idempotency check failed:', err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main: emit bilateral RepID events for a terminal peer_verification_queue row
// ─────────────────────────────────────────────────────────────────────────────

export async function emitBilateralWriteback(params: {
  pvqId: string | number;
  verdict: 'verified' | 'disputed';
  verifierAgentId: string;
  sourceAgentId: string;
  sourceResponseId: string | null;
  claimText: string | null;
}): Promise<ValidationWritebackResult> {
  const { pvqId, verdict, verifierAgentId, sourceAgentId, sourceResponseId, claimText } = params;

  // Guard: flag must be explicitly enabled
  const enabled = (process.env.VALIDATION_WRITEBACK_ENABLED ?? 'false').toLowerCase() === 'true';
  if (!enabled) {
    return {
      skipped: true,
      skip_reason: 'VALIDATION_WRITEBACK_ENABLED=false (flag default-off; set to "true" to enable)',
    };
  }

  // D-WT: idempotency — skip if already written back for this pvq row
  const alreadyDone = await isAlreadyWrittenBack(pvqId);
  if (alreadyDone) {
    return { skipped: false, idempotent_replay: true };
  }

  const base = `peer_verify:${pvqId}`;

  // ── D-3: Collusion cap ──────────────────────────────────────────────────
  const collusionCapped = await isCollusionCapExceeded(verifierAgentId, sourceAgentId);

  // ── D-5: Diminishing returns ────────────────────────────────────────────
  const diminishingMultiplier = await getRewardMultiplier(verifierAgentId);

  // ── D-1: Anchor check ───────────────────────────────────────────────────
  const anchorFound = await claimHasAnchor(sourceResponseId);

  // ── Compute deltas ───────────────────────────────────────────────────────
  let validatorDelta: number;
  let validatorEventType: string;

  if (verdict === 'verified') {
    if (collusionCapped) {
      // D-3: cap tripped — skip validator reward entirely
      validatorDelta = 0;
      validatorEventType = 'VALIDATOR_REWARD';
    } else if (anchorFound) {
      // D-1: anchor found — full reward, scaled by diminishing returns
      validatorDelta = Math.round(ANCHOR_REWARD_FULL * diminishingMultiplier);
      validatorEventType = 'VALIDATOR_REWARD';
    } else {
      // D-1: no anchor — micro-bootstrap reward, still scaled
      validatorDelta = Math.round(MICRO_REWARD * diminishingMultiplier);
      validatorEventType = 'VALIDATOR_REWARD';
    }
  } else {
    // disputed: validator penalty for a blind/wrong default
    validatorDelta = VALIDATOR_PENALTY_DELTA;
    validatorEventType = 'VALIDATOR_PENALTY';
  }

  const sourceDelta = verdict === 'verified' ? SOURCE_VERIFIED_DELTA : SOURCE_DISPUTED_DELTA;
  const sourceEventType = verdict === 'verified' ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED';

  const commonMeta = {
    peer_verification_queue_id: pvqId,
    source_response_id: sourceResponseId,
    claim_text: claimText ? claimText.slice(0, 200) : null,
    verdict,
    anchor_found: anchorFound,
    collusion_capped: collusionCapped,
    diminishing_multiplier: diminishingMultiplier,
    writeback_version: 'v1',
  };

  // ── Emit validator event (direct INSERT only) ────────────────────────────
  // D-4: idempotency key binds verifier UUID explicitly (prevents HMAC impersonation replay).
  // XC GATE (XC_WRITEBACK_GATE_ATWB_VERDICT.md §"runScoreEvent + direct-INSERT conflict"):
  // the prior runScoreEvent pre-call that lived here was REMOVED. It (1) inserted under the
  // SAME idempotency_key, so the canonical VALIDATOR_REWARD row below was silently skipped in
  // production; (2) wrote event_type='HAL_SCORE_EVENT', re-firing repid_score_events_peer_verify
  // _trigger → spurious pvq re-enqueue (recursion); (3) applied a HAL-computed delta, not the
  // canonical D-1/D-5 peer-verify delta. The direct INSERT below + the peer_verify:% partial
  // unique index are the single correct write path.
  const validatorKey = `${base}:validator:${verifierAgentId}`;

  // Insert the canonical peer-verify scored events via applyValidationEvent-shaped insert
  // (direct DB insert to ensure event_type accuracy — runScoreEvent always writes HAL_SCORE_EVENT)
  let validatorPvEvent: ScoreEventResult | undefined;
  let sourcePvEvent: ScoreEventResult | undefined;

  if (!collusionCapped || verdict === 'disputed') {
    const validatorPvRows = await pgQuery<{ n: string }>(
      `SELECT count(*) AS n FROM repid_score_events WHERE idempotency_key = $1`,
      [validatorKey],
      { label: 'validation-writeback-validator-idempotency', retries: 1 },
    );
    if (parseInt(validatorPvRows[0]?.n ?? '0', 10) === 0 && validatorDelta !== 0) {
      // Fetch agent repid before
      const agentRows = await pgQuery<{ current_repid: string; tier: string }>(
        `SELECT current_repid, tier FROM repid_agents WHERE id = $1`,
        [verifierAgentId],
        { label: 'validation-writeback-validator-agent', retries: 1 },
      );
      const validatorBefore = parseInt(agentRows[0]?.current_repid ?? '1000', 10);
      const validatorAfter = Math.max(10, Math.min(10000, validatorBefore + validatorDelta));

      const validatorInsertRows = await pgQuery<{ id: string }>(
        `INSERT INTO repid_score_events
           (agent_id, event_type, delta, repid_before, repid_after,
            repid_delta_calculated, repid_delta_applied,
            hal_score, hal_decision, idempotency_key, task_domain, metadata)
         VALUES ($1, $2, $3, $4, $5, $3, $3, 0.5, 'clean', $6, 'peer_verification',
                 $7::jsonb)
         RETURNING id`,
        [
          verifierAgentId,
          validatorEventType,
          validatorDelta,
          validatorBefore,
          validatorAfter,
          validatorKey,
          JSON.stringify({ ...commonMeta, role: 'validator' }),
        ],
        { label: 'validation-writeback-validator-insert' },
      );

      if (validatorInsertRows[0]?.id) {
        // Update agent repid (WRITER_DIRECT_APPLY)
        const WRITER_DIRECT_APPLY = process.env.WRITER_DIRECT_APPLY !== 'false';
        if (WRITER_DIRECT_APPLY) {
          await pgQuery(
            `UPDATE repid_agents SET current_repid = $1, last_updated = now()
             WHERE id = $2`,
            [validatorAfter, verifierAgentId],
            { label: 'validation-writeback-validator-repid-update' },
          );
        }
        validatorPvEvent = {
          score_event_id: parseInt(validatorInsertRows[0].id, 10),
          hal_score: 0.5,
          hal_decision: 'clean',
          signals: {},
          repid_delta_calculated: validatorDelta,
          repid_delta_applied: validatorDelta,
          old_repid: validatorBefore,
          new_repid: validatorAfter,
          zk_proof_triggered: false,
          zk_proof_id: null,
          reason: `peer_verify bilateral writeback (validator) verdict=${verdict}`,
        };
      }
    }
  }

  // ── Emit source event ────────────────────────────────────────────────────
  const sourceKey = `${base}:source:${sourceAgentId}`;
  const sourcePvRows = await pgQuery<{ n: string }>(
    `SELECT count(*) AS n FROM repid_score_events WHERE idempotency_key = $1`,
    [sourceKey],
    { label: 'validation-writeback-source-idempotency', retries: 1 },
  );
  if (parseInt(sourcePvRows[0]?.n ?? '0', 10) === 0) {
    const srcAgentRows = await pgQuery<{ current_repid: string }>(
      `SELECT current_repid FROM repid_agents WHERE id = $1`,
      [sourceAgentId],
      { label: 'validation-writeback-source-agent', retries: 1 },
    );
    const sourceBefore = parseInt(srcAgentRows[0]?.current_repid ?? '1000', 10);
    const sourceAfter = Math.max(10, Math.min(10000, sourceBefore + sourceDelta));

    const sourceInsertRows = await pgQuery<{ id: string }>(
      `INSERT INTO repid_score_events
         (agent_id, event_type, delta, repid_before, repid_after,
          repid_delta_calculated, repid_delta_applied,
          hal_score, hal_decision, idempotency_key, task_domain, metadata)
       VALUES ($1, $2, $3, $4, $5, $3, $3, 0.5, 'clean', $6, 'peer_verification',
               $7::jsonb)
       RETURNING id`,
      [
        sourceAgentId,
        sourceEventType,
        sourceDelta,
        sourceBefore,
        sourceAfter,
        sourceKey,
        JSON.stringify({ ...commonMeta, role: 'source' }),
      ],
      { label: 'validation-writeback-source-insert' },
    );

    if (sourceInsertRows[0]?.id) {
      const WRITER_DIRECT_APPLY = process.env.WRITER_DIRECT_APPLY !== 'false';
      if (WRITER_DIRECT_APPLY) {
        await pgQuery(
          `UPDATE repid_agents SET current_repid = $1, last_updated = now()
           WHERE id = $2`,
          [sourceAfter, sourceAgentId],
          { label: 'validation-writeback-source-repid-update' },
        );
      }
      sourcePvEvent = {
        score_event_id: parseInt(sourceInsertRows[0].id, 10),
        hal_score: 0.5,
        hal_decision: 'clean',
        signals: {},
        repid_delta_calculated: sourceDelta,
        repid_delta_applied: sourceDelta,
        old_repid: sourceBefore,
        new_repid: sourceAfter,
        zk_proof_triggered: false,
        zk_proof_id: null,
        reason: `peer_verify bilateral writeback (source) verdict=${verdict}`,
      };
    }
  }

  return {
    skipped: false,
    validator_event: validatorPvEvent,
    source_event: sourcePvEvent,
    collusion_capped: collusionCapped,
    anchor_found: anchorFound,
    diminishing_multiplier: diminishingMultiplier,
  };
}

/**
 * DRY-RUN WORKED EXAMPLE — for the gate report.
 * Does NOT write to any table; returns what WOULD happen.
 * Call this from tests or a CLI script with a real pvq row.
 */
export async function dryRunWriteback(params: {
  pvqId: string | number;
  verdict: 'verified' | 'disputed';
  verifierAgentId: string;
  sourceAgentId: string;
  sourceResponseId: string | null;
  claimText: string | null;
}) {
  const { pvqId, verdict, verifierAgentId, sourceAgentId, sourceResponseId, claimText } = params;

  const anchorFound = await claimHasAnchor(sourceResponseId);
  const collusionCapped = await isCollusionCapExceeded(verifierAgentId, sourceAgentId);
  const diminishingMultiplier = await getRewardMultiplier(verifierAgentId);

  // Fetch current repid for both agents
  const getRepid = async (agentId: string): Promise<number> => {
    try {
      const rows = await pgQuery<{ current_repid: string }>(
        `SELECT current_repid FROM repid_agents WHERE id = $1`,
        [agentId],
        { label: 'dry-run-repid-fetch', retries: 1 },
      );
      return parseInt(rows[0]?.current_repid ?? '1000', 10);
    } catch { return 1000; }
  };

  const validatorBefore = await getRepid(verifierAgentId);
  const sourceBefore = await getRepid(sourceAgentId);

  let validatorDelta: number;
  let validatorEventType: string;
  if (verdict === 'verified') {
    if (collusionCapped) {
      validatorDelta = 0;
      validatorEventType = 'VALIDATOR_REWARD (blocked by D-3 collusion cap)';
    } else if (anchorFound) {
      validatorDelta = Math.round(ANCHOR_REWARD_FULL * diminishingMultiplier);
      validatorEventType = 'VALIDATOR_REWARD (anchor-backed full)';
    } else {
      validatorDelta = Math.round(MICRO_REWARD * diminishingMultiplier);
      validatorEventType = 'VALIDATOR_REWARD (micro-bootstrap — no anchor)';
    }
  } else {
    validatorDelta = VALIDATOR_PENALTY_DELTA;
    validatorEventType = 'VALIDATOR_PENALTY';
  }

  const sourceDelta = verdict === 'verified' ? SOURCE_VERIFIED_DELTA : SOURCE_DISPUTED_DELTA;
  const sourceEventType = verdict === 'verified' ? 'VALIDATION_PASSED' : 'VALIDATION_FAILED';

  return {
    pvq_id: pvqId,
    verdict,
    anchor_found: anchorFound,
    collusion_capped: collusionCapped,
    diminishing_multiplier: diminishingMultiplier,
    idempotency_keys: {
      validator: `peer_verify:${pvqId}:validator:${verifierAgentId}`,
      source: `peer_verify:${pvqId}:source:${sourceAgentId}`,
    },
    would_emit: [
      {
        agent: 'validator (β)',
        agent_id: verifierAgentId,
        event_type: validatorEventType,
        delta: validatorDelta,
        repid_before: validatorBefore,
        repid_after: Math.max(10, Math.min(10000, validatorBefore + validatorDelta)),
      },
      {
        agent: 'source (α)',
        agent_id: sourceAgentId,
        event_type: sourceEventType,
        delta: sourceDelta,
        repid_before: sourceBefore,
        repid_after: Math.max(10, Math.min(10000, sourceBefore + sourceDelta)),
      },
    ],
    dry_run: true,
    note: 'No DB writes. Set VALIDATION_WRITEBACK_ENABLED=true + co-sign to go live.',
  };
}
