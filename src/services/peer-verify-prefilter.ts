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
