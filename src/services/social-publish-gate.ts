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

/**
 * The platforms wired to a reviewed publish path. LinkedIn and X are the first pair; TikTok,
 * YouTube, and every unlisted or unknown platform are DELIBERATELY held until each earns its own
 * reviewed path. This is an allowlist on purpose: a platform's absence from this set means "held",
 * never "allowed".
 *
 * This is NOT a feature flag and takes NO env var. The tier gate is the capability that was asked
 * for, so it is a hardcoded constant rather than a toggle that could silently open the door. Widen
 * this list only by adding a platform AND a test — never by reading it from the environment.
 */
export const PUBLISHABLE_PLATFORMS = ['linkedin', 'x'] as const;

/**
 * Where a draft-only platform is parked. `needs_review` is chosen deliberately: it is the held
 * state the HAL path already produces, it is NOT in PUBLISHABLE_STATUSES, and — verified against
 * the live schema 2026-10-12 — the `status` column is free `text` with no enum/whitelist CHECK, so
 * any non-publishable string inserts safely. `needs_review` carries the HAL verdict honestly and
 * reads as "a human must look before this goes out", which a bare `draft` would not.
 */
const PLATFORM_HELD_STATUS = 'needs_review';

export interface PlatformTier {
  tier: 'publishable' | 'draft_only';
  reason: string;
}

/**
 * Pure. Resolve a platform string to its publishability tier, fail-closed.
 *
 * Normalises case and surrounding whitespace, and treats `twitter` as an alias of `x`. ONLY the
 * members of PUBLISHABLE_PLATFORMS resolve to 'publishable'; EVERYTHING else — an unlisted or
 * unknown string, an empty string, `undefined`, and any error thrown while resolving — resolves to
 * 'draft_only'. The safe-looking direction is the restrictive one: absence is never publishable.
 */
export function resolvePlatformTier(platform: string | undefined): PlatformTier {
  try {
    const normalizedRaw = (platform ?? '').toLowerCase().trim();
    if (normalizedRaw.length === 0) {
      return { tier: 'draft_only', reason: 'no platform given — an absent platform is never publishable' };
    }
    const normalized = normalizedRaw === 'twitter' ? 'x' : normalizedRaw;
    if ((PUBLISHABLE_PLATFORMS as readonly string[]).includes(normalized)) {
      return { tier: 'publishable', reason: `${normalized} is in the publishable tier (LinkedIn, X)` };
    }
    return {
      tier: 'draft_only',
      reason: `${normalized} is not in the publishable tier (LinkedIn, X); stays a draft pending a reviewed publish path`,
    };
  } catch {
    // Fail-closed: a thrown error must land on the restrictive outcome, never slip through as publishable.
    return { tier: 'draft_only', reason: 'platform tier could not be resolved; held fail-closed' };
  }
}

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
  /** Which publishability tier the target platform resolved to. 'draft_only' can only hold, never publish. */
  platform_tier: 'publishable' | 'draft_only';
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
  const halStatus = resolveStatus(hal.decision, degraded);

  // Platform publishability tier, applied DEMOTE-ONLY, after the HAL verdict. LinkedIn and X are
  // the only platforms wired to a reviewed publish path; everything else — and an absent or
  // unknown platform — is held, so a clean verdict cannot carry a TikTok/YouTube draft into a
  // publishable state before that path exists. This can only move a status DOWN: a vetoed stays
  // vetoed, a needs_review stays needs_review, and a clean verdict on LinkedIn/X still reaches ready.
  const platformTier = resolvePlatformTier(input.platform);
  const demotedForPlatform =
    platformTier.tier === 'draft_only' &&
    (PUBLISHABLE_STATUSES as readonly string[]).includes(halStatus);
  const status = demotedForPlatform ? PLATFORM_HELD_STATUS : halStatus;

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
    platform_tier: platformTier.tier,
    note: demotedForPlatform
      ? `held — ${platformTier.reason} (HAL verdict '${hal.decision}' was otherwise publishable)`
      : noteFor(hal.decision, degraded),
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
