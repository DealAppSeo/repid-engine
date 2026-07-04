import { Router, Request, Response } from 'express';
import { db } from '../db';
import { pgQuery } from '../db/direct-pg';
import { emitPeerVerifyScoreEvents } from '../services/peer-verify-score';
import {
  peerVerifyPanelEnabled,
  resolvePanel,
  PANEL_PROVIDER_HINTS,
} from '../services/peer-verify-consensus';
import crypto from 'crypto';

// CC2 2026-05-27: HMAC-gated POST /respond for Gemini's peer_verify task handler.
//
// History: a substantively-complete /respond existed in this file but it was
// (1) racy — fetch-then-update across two round trips, (2) returned 400 on
// already-processed (sprint asks for 409), (3) shipped with a hardcoded literal
// fallback secret in getAgentPrivateKey (insecure when env unset), and (4) had
// a try/catch around crypto.timingSafeEqual that fell back to plain `==`
// (defeats timing-safety). This rewrite fixes all four while preserving the
// existing dataToSign shape (the contract Gemini's caller is built against —
// see tests/peer-verification.test.ts line 226–234) and the per-agent secret
// scheme (so an in-flight Gemini caller is not broken).
//
// HMAC SECRET RESOLUTION (in order):
//   1. PEER_VERIFY_HMAC_SECRET  ← sprint-spec primary
//   2. <AGENT>_PRIVATE_KEY      ← existing per-agent scheme (back-compat)
//   3. TRUSTRAILS_HMAC_SECRET   ← existing global fallback (back-compat)
//   Each candidate that exists is tried in turn. If none verify the signature →
//   401. There is NO hardcoded literal fallback — the function returns
//   undefined if all three env candidates are unset, which is the right failure
//   mode (no silent forgery vector).
//
// dataToSign (UNCHANGED for Gemini back-compat):
//   `${queue_id}:${verifier_response_id}:${verdict}`
//   The verifier_agent_id is NOT bound in the signature today; flagged as a
//   follow-on hardening (would require Gemini-side caller coordination).

const router = Router();

// Helper to get agent private key from env (per-agent scheme).
// Returns undefined when no per-agent or global env secret is set.
// Sprint 2026-05-27: removed the hardcoded literal fallback
// ('trinity-default-sbt-secret') — it was a forge-anyone-with-source vector.
export function getAgentPrivateKey(agentName: string): string | undefined {
  // Map "trinity-mel" to "MEL", "trinity-sophia" to "SOPHIA", etc.
  const cleanName = agentName.replace('trinity-', '').toUpperCase().trim();
  const envKey = `${cleanName}_PRIVATE_KEY`;
  return process.env[envKey] || process.env.TRUSTRAILS_HMAC_SECRET || undefined;
}

// Single-direction HMAC compare. Returns true only when:
//   * both buffers parse as hex of equal length,
//   * crypto.timingSafeEqual returns true.
// No fallback to plain === on parse failure (that would defeat timing-safety).
function constantTimeVerify(secret: string, dataToSign: string, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(dataToSign).digest('hex');
  if (signature.length !== expected.length) return false;
  let a: Buffer, b: Buffer;
  try {
    a = Buffer.from(signature, 'hex');
    b = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Tries all configured secret sources in priority order. Returns true on the
// first match. Caller passes the resolved verifier agent NAME (for the per-agent
// candidate lookup); UUIDs would not map back to the canonical env key.
export function verifyPeerSignature(
  verifierAgentName: string,
  dataToSign: string,
  signature: string
): { valid: boolean; matched_via?: 'global' | 'per_agent' } {
  // 1. PEER_VERIFY_HMAC_SECRET (sprint-spec primary)
  const globalSecret = process.env.PEER_VERIFY_HMAC_SECRET;
  if (globalSecret && constantTimeVerify(globalSecret, dataToSign, signature)) {
    return { valid: true, matched_via: 'global' };
  }
  // 2/3. Per-agent or TRUSTRAILS_HMAC_SECRET (back-compat)
  const perAgent = getAgentPrivateKey(verifierAgentName);
  if (perAgent && constantTimeVerify(perAgent, dataToSign, signature)) {
    return { valid: true, matched_via: 'per_agent' };
  }
  return { valid: false };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_VERDICTS = ['verified', 'disputed', 'timeout'] as const;
type Verdict = (typeof ALLOWED_VERDICTS)[number];

interface RespondRow {
  id: number | string;
  source_agent_id: string;
  verifier_agent_id: string | null;
  verifier_response_id: string | null;
  verifier_signature: string | null;
  verification_status: string;
  completed_at: string | null;
  claim_text: string | null;
  certainty_at_claim: number;
  threshold_used: number;
}

router.post('/respond', async (req: Request, res: Response) => {
  const { queue_id, verifier_agent_id, verifier_response_id, verdict, signature } = req.body ?? {};

  // ----- Body shape ----------------------------------------------------------
  if (!queue_id || !verifier_agent_id || !verifier_response_id || !verdict || !signature) {
    return res.status(400).json({
      error: 'queue_id, verifier_agent_id, verifier_response_id, verdict, signature are required',
    });
  }
  if (!ALLOWED_VERDICTS.includes(verdict as Verdict)) {
    return res.status(400).json({
      error: `invalid verdict; expected one of ${ALLOWED_VERDICTS.join(', ')}`,
    });
  }
  if (typeof signature !== 'string' || !/^[0-9a-f]+$/i.test(signature)) {
    return res.status(400).json({ error: 'signature must be lowercase hex' });
  }

  // S-CHAIN Phase 7 anti-self + anti-collusion (from S-REDTEAM).
  // Self-endorsement is enforced atomically below by the UPDATE's `source_agent_id <> verifierUuid`
  // guard (and the 0-row probe returns 400 'Self-verification is not permitted'), using the RESOLVED
  // verifier UUID — so no separate pre-resolution check is needed here (the prior one referenced an
  // undefined `queueEntry` and broke the build).
  // TODO full ring detection: query recent peer_verification_queue for mutual verifier<->agent pairs; if pattern, penalize RepID.

  try {
    // ----- Resolve verifier agent (name → uuid OR uuid → name) ---------------
    const lookupClause = UUID_RE.test(verifier_agent_id)
      ? `id.eq.${verifier_agent_id}`
      : `agent_name.eq.${verifier_agent_id}`;
    const { data: agent, error: agentErr } = await db
      .from('repid_agents')
      .select('id, agent_name')
      .or(lookupClause)
      .single();

    if (agentErr || !agent) {
      return res.status(404).json({ error: `Verifier agent ${verifier_agent_id} not found` });
    }
    const verifierName = (agent as any).agent_name as string;
    const verifierUuid = (agent as any).id as string;

    // ----- HMAC verify (no DB hit) -------------------------------------------
    const dataToSign = `${queue_id}:${verifier_response_id}:${verdict}`;
    const check = verifyPeerSignature(verifierName, dataToSign, signature);
    if (!check.valid) {
      console.warn(
        `[peer-verify/respond] HMAC reject queue_id=${queue_id} verifier=${verifierName}`
      );
      return res.status(401).json({ error: 'Invalid verifier signature' });
    }

    // =========================================================================
    // BLIND 2-of-3 PANEL PATH (flag PEER_VERIFY_PANEL_ENABLED, default false)
    // -------------------------------------------------------------------------
    // Records this verifier's vote in peer_verification_votes (BLIND: the
    // response returns NO other verifier's verdict), then checks whether the
    // 2-of-3 majority is reached. Consensus → honest scoring via resolvePanel
    // (agree→+, diverge→PEER_VERIFY_WRONG_CALL, producer per verdict). No
    // consensus yet → 202 accepted, wait for more votes. The legacy
    // single-verifier UPDATE + scoring below is SKIPPED when the flag is on, so
    // the two paths never double-score. Flag off → this whole block is inert and
    // the legacy path runs unchanged.
    // =========================================================================
    if (peerVerifyPanelEnabled()) {
      // Fetch the queue row for source ids (need source_agent_id + source_response_id).
      const qrows = await pgQuery<{
        id: number | string;
        source_agent_id: string;
        source_response_id: string;
        claim_text: string | null;
        certainty_at_claim: number;
        verification_status: string;
      }>(
        `SELECT id, source_agent_id, source_response_id, claim_text,
                certainty_at_claim, verification_status
           FROM peer_verification_queue
          WHERE id = $1`,
        [queue_id],
        { label: 'panel-fetch-queue' }
      );
      if (qrows.length === 0) {
        return res.status(404).json({ error: 'Queue entry not found' });
      }
      const q = qrows[0]!;
      if (q.source_agent_id === verifierUuid) {
        return res.status(400).json({ error: 'Self-verification is not permitted' });
      }

      const provider =
        typeof req.body?.provider === 'string'
          ? req.body.provider
          : PANEL_PROVIDER_HINTS[verifierName] ?? null;

      // Insert the vote. UNIQUE(source_response_id, verifier_agent_id) makes a
      // repeat vote idempotent (ON CONFLICT DO NOTHING) — one ballot per verifier.
      const inserted = await pgQuery<{ id: number }>(
        `INSERT INTO peer_verification_votes
           (source_response_id, queue_id, verifier_agent_id, verifier_agent_name,
            provider, verdict, signature, verifier_response_id)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8::uuid)
         ON CONFLICT (source_response_id, verifier_agent_id) DO NOTHING
         RETURNING id`,
        [
          q.source_response_id,
          queue_id,
          verifierUuid,
          verifierName,
          provider,
          verdict,
          signature,
          verifier_response_id,
        ],
        { label: 'panel-insert-vote' }
      );
      const voteAccepted = inserted.length > 0;

      // Resolve: compute consensus over ALL votes so far. Score only once, when
      // consensus is first reached AND the queue row is still open (atomic guard
      // below prevents a double-score across concurrent final votes).
      const contractId = String(q.source_response_id); // uuid — repid_score_events.contract_id
      const resolveResult = await resolvePanel({
        sourceResponseId: q.source_response_id,
        producerAgentId: q.source_agent_id,
        contractId,
        claimText: q.claim_text,
        certaintyAtClaim: q.certainty_at_claim,
        dryRun: true, // compute first; only the winner of the atomic close scores
      });

      if (!resolveResult.consensus.reached) {
        return res.status(voteAccepted ? 202 : 200).json({
          success: true,
          mode: 'panel',
          vote_accepted: voteAccepted,
          consensus_reached: false,
          reason: resolveResult.consensus.reason,
          votes_in: resolveResult.consensus.votes.length,
          panel_size: 3,
        });
      }

      // Consensus reached. Atomically close the queue row so exactly one request
      // performs the scoring (idempotent finalization).
      const closed = await pgQuery<{ id: number | string }>(
        `UPDATE peer_verification_queue
            SET verification_status = 'panel_resolved',
                completed_at = now()
          WHERE id = $1
            AND verification_status IN ('pending','in_review')
          RETURNING id`,
        [queue_id],
        { label: 'panel-close-queue' }
      );

      if (closed.length === 0) {
        // Another vote already finalized + scored this claim. Report the verdict,
        // do NOT re-score.
        return res.json({
          success: true,
          mode: 'panel',
          vote_accepted: voteAccepted,
          consensus_reached: true,
          consensus_verdict: resolveResult.consensus.verdict,
          already_finalized: true,
          tally: resolveResult.consensus.tally,
        });
      }

      // We won the finalization race → emit the honest score events now.
      const scored = await resolvePanel({
        sourceResponseId: q.source_response_id,
        producerAgentId: q.source_agent_id,
        contractId,
        claimText: q.claim_text,
        certaintyAtClaim: q.certainty_at_claim,
        dryRun: false,
      });

      console.log(
        `[peer-verify/respond] PANEL consensus=${scored.consensus.verdict} ` +
          `queue=${queue_id} tally=${JSON.stringify(scored.consensus.tally)} ` +
          `events=${scored.scoreEvents.length}`
      );

      return res.json({
        success: true,
        mode: 'panel',
        vote_accepted: voteAccepted,
        consensus_reached: true,
        consensus_verdict: scored.consensus.verdict,
        tally: scored.consensus.tally,
        scored: scored.scored,
        score_events: scored.scoreEvents,
      });
    }
    // ===================== END PANEL PATH ====================================

    // ----- Atomic UPDATE (idempotent, race-safe) -----------------------------
    // Single statement: claim-and-write, only if still in a takeable state and
    // verifier is not the original claimant. RETURNING is the source of truth
    // for "did we win the race." No fetch-then-update window.
    const updated = await pgQuery<RespondRow>(
      `UPDATE peer_verification_queue
          SET verification_status = $1,
              verifier_agent_id   = $2,
              verifier_response_id = $3,
              verifier_signature  = $4,
              completed_at        = now()
        WHERE id = $5
          AND verification_status IN ('pending','in_review')
          AND source_agent_id <> $2
        RETURNING id, source_agent_id, verifier_agent_id, verifier_response_id,
                  verifier_signature, verification_status, completed_at,
                  claim_text, certainty_at_claim, threshold_used`,
      [verdict, verifierUuid, verifier_response_id, signature, queue_id],
      { label: 'peer-verify-respond' }
    );

    if (updated.length === 0) {
      // ----- Disambiguate why the atomic UPDATE matched 0 rows ---------------
      // (only on the error path; happy path is single-query)
      const probe = await pgQuery<{ verification_status: string; source_agent_id: string }>(
        `SELECT verification_status, source_agent_id
           FROM peer_verification_queue
          WHERE id = $1`,
        [queue_id],
        { label: 'peer-verify-probe' }
      );
      if (probe.length === 0) {
        return res.status(404).json({ error: 'Queue entry not found' });
      }
      const row = probe[0]!;
      if (row.source_agent_id === verifierUuid) {
        return res.status(400).json({ error: 'Self-verification is not permitted' });
      }
      // status not in ('pending','in_review') ⇒ already processed
      return res.status(409).json({
        error: 'Queue entry already processed',
        current_status: row.verification_status,
      });
    }

    const row = updated[0]!;

    // ----- Dogfooding: co-sign → RepID event wiring (Phase 3) ----------------
    // Verified co-sign (verifier resolved claim as 'verified', opened artifact) writes
    // +RepID to producer (source) AND verifier via repid_score_events.
    // False-PASS (e.g. 'disputed' tag-resolve-fail on what was rubber-stamped) slashes verifier.
    // Reuses peer_verification_queue (the resolution site) + repid_score_events.
    // Flag default OFF; ON only post CC honest-HAL merge (see below).
    // Grok calibration (documented):
    //  - 20–30% re-verification sampling for small set (4 + T12): bootstrap awards every
    //    verified co-sign (N small; later probabilistic). Deterministic on high-value claims
    //    (HAL quorum, EAS anchors, on-chain writes, canonical handoffs) — this path qualifies.
    //  - Conservative slash curve: first false-PASS = warning log + small decay (e.g. -2);
    //    repeated/high-impact = heavier (escalate to -10+, review). Cross-dimensional penalties:
    //    high collaboration score + low delivery/HAL-accuracy → manual review flag.
    //  - Tests (see tests/peer-verification.test.ts or dogfood-cosign.test.ts): verified+delta,
    //    false-PASS slash, flag-OFF no-op.
    // Activation: switch ON only post CC honest-HAL merge (feat/cc-2026-06-04-honest-hal +
    // HAL_DECISION_REQUIRES_QUORUM live in scorer). Do NOT score on pre-merge scorer.
    // Veritas / peer-verify score emission — AFTER real HMAC-verified verdict only.
    // pgQuery INSERT → apply_repid_score_event trigger moves current_repid.
    try {
      const scoreResult = await emitPeerVerifyScoreEvents({
        queueId: queue_id,
        producerAgentId: row.source_agent_id as string,
        verifierAgentId: (row.verifier_agent_id as string | null) ?? verifierUuid,
        verdict: verdict as 'verified' | 'disputed' | 'timeout',
        claimText: row.claim_text as string | null,
        certaintyAtClaim: row.certainty_at_claim as number | null,
      });
      if (scoreResult.emitted) {
        console.log(
          `[peer-verify] RepID events emitted queue=${queue_id} producer_after=${scoreResult.producerRepidAfter ?? 'n/a'} verifier_after=${scoreResult.verifierRepidAfter ?? 'n/a'}`
        );
      }
    } catch (e: any) {
      console.warn(`[peer-verify] score event insert failed: ${e?.message ?? e}`);
    }

    // ----- Complete matching trinity_tasks row (bonus, best-effort) ----------
    // Preserved from the pre-rewrite endpoint. Best-effort; failures here do
    // NOT undo the queue update (the verification stands either way).
    try {
      const { data: tasks } = await db
        .from('trinity_tasks')
        .select('id, metadata')
        .eq('assigned_to', verifierName)
        .in('status', ['pending', 'todo', 'in_progress']);

      const matchingTask = (tasks ?? []).find(
        (t: any) =>
          (t.metadata as any)?.peer_verification_queue_id?.toString() === String(queue_id)
      );

      if (matchingTask) {
        await db
          .from('trinity_tasks')
          .update({
            status: 'completed',
            result: `Peer verification completed with verdict: ${verdict}`,
            completed_at: new Date().toISOString(),
          })
          .eq('id', (matchingTask as any).id);
      }
    } catch (e: any) {
      console.warn(
        `[peer-verify/respond] task-completion best-effort failed queue_id=${queue_id}: ${e?.message ?? e}`
      );
    }

    return res.json({
      success: true,
      queue_id: row.id,
      verdict,
      agreement_score: verdict === 'verified' ? 1.0 : 0.0,
      completed_at: row.completed_at,
      matched_via: check.matched_via ?? null,
      row,
    });
  } catch (err: any) {
    console.error(`[peer-verify/respond] unhandled error: ${err?.message ?? err}`);
    return res.status(500).json({ error: err?.message ?? 'unknown error' });
  }
});

export default router;
