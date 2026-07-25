/**
 * Peer-verification prequalifying filter.
 *
 * WHY: measurement on 2026-07-09 showed ~91% of enqueued "claims" are not
 * checkable claims at all — they are the fleet's own drill/cron status
 * summaries ("The CAIT scan is complete…", "EVERGREEN RepID Audit…") and, worse,
 * peer-verify verifying its own prior outputs (recursive). Verifying them burns
 * the free-LLM budget and makes the "disputed" verdict meaningless (a verifier
 * cannot confirm a status blurb). See reports/2026-07-09/PEER_VERIFY_FINDINGS.md.
 *
 * WHAT: classify a queued claim as verifiable or not, BEFORE spawning any
 * verifier task. This is a content filter — it intentionally does NOT skip on
 * low certainty, because low-certainty claims are exactly the ones worth
 * verifying. Heuristic v1; will be tightened once calibrated against the canary
 * corpus (known TRUE/FALSE).
 *
 * MODE: PEER_VERIFY_PREFILTER_MODE = off | shadow | enforce (default: shadow).
 *   off     — filter disabled (legacy behavior).
 *   shadow  — log what WOULD be skipped, but still verify (measure, no change).
 *   enforce — skip non-verifiable claims (status -> 'skipped'), do not spawn.
 */

export type PrefilterMode = 'off' | 'shadow' | 'enforce';

export function prefilterMode(): PrefilterMode {
  const m = (process.env.PEER_VERIFY_PREFILTER_MODE || 'shadow').toLowerCase();
  return m === 'off' || m === 'enforce' ? (m as PrefilterMode) : 'shadow';
}

export interface ClaimClassification {
  verifiable: boolean;
  reason: string; // why it was rejected (empty when verifiable)
}

// Recursive: peer-verify output being re-verified.
const RE_RECURSIVE = /peer verification completed/i;
// Drill/cron completion summaries ("... scan/audit/check/report ... complete/done/passed").
const RE_DRILL_DONE =
  /\b(scan|check|audit|drill|calibration|red[ -]?team|health\s*check|sprint|report)\b[\s\S]{0,160}?\b(complete|completed|done|passed)\b/i;
// "The X is complete/done" status summary.
const RE_STATUS_SUMMARY = /^\s*the\b[\s\S]{0,90}?\bis\s+(complete|completed|done)\b/i;
// Markdown report blob (starts with a heading).
const RE_REPORT_HEADER = /^\s{0,3}#{1,3}\s/;
// Internal drill namespaces.
const RE_INTERNAL = /\b(evergreen|CAIT|WSCE)\b/i;

/**
 * Structural self-referential guard (L2 breaker 2.3).
 *
 * WHY: the peer-verify loop is a fork-bomb risk. The bridge enqueues a
 * peer-verification for a completed task; peer-verification-reader turns each
 * queue entry into up to 3 `trinity_tasks` (task_type='peer_verify'); those
 * complete and re-enter the bridge. If a *peer-verify* task is allowed to spawn
 * a further peer-verification of itself, the queue recurses without bound —
 * this is the 85% `[PEER_VERIFY_PANEL] Verify response from trinity-*`
 * self-referential churn root-caused 2026-07-25 (reports/2026-07-25/
 * BEAT2_PEER_VERIFY_STALL_AND_GATE_ROOTCAUSE.md).
 *
 * Today the recursion is only *incidentally* closed because reader-spawned
 * tasks don't set verification_required/needs_peer. That is fragile — one field
 * change reopens it. This is the durable structural ban: a task that is itself
 * a peer-verification NEVER spawns further peer-verification. It complements the
 * content heuristic (RE_RECURSIVE) above with a robust structural signal.
 *
 * Detection (any one is sufficient):
 *   - task_type === 'peer_verify' (set by peer-verification-reader on spawn), or
 *   - metadata.peer_verification_queue_id present (the reader stamps this), or
 *   - title begins with '[PEER_VERIFY' / '[PEER_VERIFY_PANEL'.
 *
 * Fail-safe: this only ever SUPPRESSES a spawn, never adds one, so a
 * false-positive costs at most one skipped (redundant) re-verification, while a
 * false-negative is the unbounded loop. Bias to detect.
 */
export function isPeerVerificationTask(task: {
  task_type?: string | null;
  title?: string | null;
  metadata?: unknown;
}): boolean {
  if ((task.task_type ?? '').toLowerCase() === 'peer_verify') return true;

  const title = (task.title ?? '').trimStart();
  if (/^\[PEER_VERIFY(_PANEL)?\b/i.test(title)) return true;

  let meta: any = task.metadata;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = null;
    }
  }
  if (meta && typeof meta === 'object' && meta.peer_verification_queue_id != null) {
    return true;
  }
  return false;
}

/**
 * True = a real, checkable claim worth spending verification on.
 * False = drill/status/recursive/empty — skip.
 */
export function classifyPeerVerifyClaim(
  claimText: string | null | undefined,
  _certainty?: number | null,
): ClaimClassification {
  const text = (claimText ?? '').trim();
  if (text.length === 0) return { verifiable: false, reason: 'empty' };
  if (RE_RECURSIVE.test(text)) return { verifiable: false, reason: 'recursive-peer-verify' };
  if (RE_INTERNAL.test(text)) return { verifiable: false, reason: 'internal-drill' };
  if (RE_STATUS_SUMMARY.test(text)) return { verifiable: false, reason: 'status-summary' };
  if (RE_REPORT_HEADER.test(text)) return { verifiable: false, reason: 'report-blob' };
  if (RE_DRILL_DONE.test(text)) return { verifiable: false, reason: 'drill-completion' };
  return { verifiable: true, reason: '' };
}
