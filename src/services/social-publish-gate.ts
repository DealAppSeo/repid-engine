/**
 * No post leaves the queue unverified (2026-08-28).
 *
 * WHAT WAS ACTUALLY THERE. `social_content_queue` has existed since 2026-04 with a full
 * schema — platform, content, hashtags, scheduled_for, status, posted_at, post_url — and NO
 * trust columns whatsoever: no author, no verdict, no verified_at. Nothing in this repo or
 * trustshell referenced it in either direction. Every row in it sits in a publishable state,
 * none was ever posted, and no account was ever connected. A whole publishing path was built
 * and then abandoned, which is this codebase's signature defect: a mechanism completed, with
 * observability attached, that has never once run.
 *
 * WHY THAT MATTERS MORE HERE THAN ANYWHERE ELSE. The product's entire claim is that an agent's
 * output is verified before it ships. A social queue that can carry a row from draft to posted
 * with nothing checked is that claim's counterexample, sitting in the same database. The first
 * campaign post published without a verdict would falsify the pitch more effectively than any
 * competitor could.
 *
 * THE GATE IS IN POSTGRES, NOT HERE. `social_content_queue_verified_before_publish` refuses any
 * row in a publishable state unless `hal_decision` is present and is not a veto. This module
 * cannot be the enforcement point and does not pretend to be: a future n8n flow, a worker, or
 * somebody's hand-run UPDATE would route straight around application code. That is not
 * hypothetical here — this repo already carries a column whose app-side writes are silently
 * overwritten by a database trigger, for exactly this reason. What this module does is run the
 * verification and record it honestly, so the constraint has something true to check.
 *
 * THREE OUTCOMES, NEVER TWO. `flagged` and `abstain` are allowed through to a publishable
 * state on purpose. They mean "a human should look at this", not "this is false". Collapsing
 * them into a block would teach operators that HAL declining to judge is a failure, which is
 * the opposite of the point; collapsing them into a pass would be worse. They travel WITH the
 * row, so whoever approves it sees what HAL actually said. Only `vetoed` blocks, and only
 * `NULL` — NOT CHECKED — is treated as disqualifying rather than passing.
 */
import { db } from '../db';
import { halService } from '../hal/service';

/** States that mean "this may go out". Must match the DB constraint — see the test that pins it. */
export const PUBLISHABLE_STATUSES = ['ready', 'approved', 'scheduled', 'posted'] as const;

/** The one verdict that blocks. Kept separate from the list above so each reads as one idea. */
export const BLOCKING_DECISION = 'vetoed';

export interface SocialDraftInput {
  platform: string;
  content: string;
  hashtags?: string;
  mediaUrl?: string;
  scheduledFor?: string;
  /** The agent that wrote this. Absent stays absent — never stamped with a placeholder. */
  agentId?: string;
}

export interface SocialDraftResult {
  id: number;
  status: string;
  hal_decision: string;
  hal_score: number;
  hal_mode: string;
  /** True when strictness 2 was asked for and the real quorum was NOT available. */
  degraded: boolean;
  degraded_reason?: string;
  /** Why this landed where it did, in one line a human can act on. */
  note: string;
}

/**
 * Verify a draft, then queue it in the state its verdict earns.
 *
 * A veto lands as `vetoed` and can never be promoted: the DB constraint refuses it in any
 * publishable state, so the block survives this code being bypassed or rewritten.
 *
 * A DEGRADED EVALUATION DOES NOT SILENTLY PASS. When the fact-check quorum is unavailable HAL
 * falls back to a style extractor, which measures something real but not the same thing. Such a
 * draft is held at `needs_review` regardless of score, because publishing on a fallback score
 * while reporting it as verified is precisely the fake-pass this system exists to prevent.
 */
export async function verifyAndQueueDraft(input: SocialDraftInput): Promise<SocialDraftResult> {
  const hal = await halService.evaluate({
    text: input.content,
    strictness: 2,
    ...(input.agentId ? { agentId: input.agentId } : {}),
  });

  const degraded = hal.degraded_mode === true || hal.mode === 'extractor-fallback';
  const status = resolveStatus(hal.decision, degraded);

  const row = {
    platform: input.platform,
    content: input.content,
    hashtags: input.hashtags ?? null,
    media_url: input.mediaUrl ?? null,
    scheduled_for: input.scheduledFor ?? null,
    status,
    hal_decision: hal.decision,
    hal_score: hal.hal_score,
    hal_mode: hal.mode,
    verified_at: new Date().toISOString(),
    // An absent agent stays absent. A fabricated id would raise attribution while destroying
    // the only thing the column is for — knowing whose agent wrote a published post.
    ...(input.agentId ? { agent_id: input.agentId } : {}),
  };

  const { data, error } = await db
    .from('social_content_queue')
    .insert(row)
    .select('id, status')
    .single();

  if (error) {
    // Surface the constraint by name rather than as a generic 500. If this fires it means the
    // status this code chose and the state the database considers publishable have diverged,
    // and a reader needs to know which of the two to fix.
    throw new Error(
      `social queue insert rejected (status='${status}', decision='${hal.decision}'): ${error.message ?? String(error)}`,
    );
  }

  return {
    id: (data as { id: number }).id,
    status,
    hal_decision: hal.decision,
    hal_score: hal.hal_score,
    hal_mode: hal.mode,
    degraded,
    ...(hal.degraded_reason ? { degraded_reason: hal.degraded_reason } : {}),
    note: noteFor(hal.decision, degraded),
  };
}

/**
 * Which queue state a verdict earns.
 *
 * Exported and pure so the test can enumerate every decision the HAL response type declares —
 * a new fifth outcome must not fall through to a publishable default.
 */
export function resolveStatus(decision: string, degraded: boolean): string {
  if (decision === BLOCKING_DECISION) return 'vetoed';
  if (degraded) return 'needs_review';
  if (decision === 'clean') return 'ready';
  // flagged, abstain, and anything this code has not seen before: hold for a human. An unknown
  // verdict resolving to a publishable state is the failure mode worth defaulting away from.
  return 'needs_review';
}

function noteFor(decision: string, degraded: boolean): string {
  if (decision === BLOCKING_DECISION) {
    return 'HAL vetoed this content; it cannot be promoted to a publishable state.';
  }
  if (degraded) {
    return 'The fact-check quorum was unavailable, so this score comes from the style extractor, not a verification. Held for review.';
  }
  if (decision === 'clean') return 'Verified by the HAL quorum and queued as ready.';
  return `HAL returned '${decision}' — a human should look at this before it goes out.`;
}
