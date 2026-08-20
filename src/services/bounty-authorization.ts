/**
 * bounty-authorization.ts — who may verify a bounty, and what they must prove.
 *
 * THE HOLE THIS CLOSES. `POST /bounties/:id/verify` is mounted at src/index.ts:376,
 * BEFORE `app.use(authMiddleware)` at line 456, so it was reachable with no
 * credential at all. It took `verifierAgentId` from the request body, moved the
 * bounty to VERIFIED, and paid the claimant a real RepID award through
 * `updateRepId({ eventType: 'AUDIT_CONTRIBUTION' })`. An unauthenticated caller
 * could therefore approve payouts and name whoever they liked as the verifier.
 *
 * Reported externally in #445; tracked and fixed in-house as #446. Two properties
 * were missing and both are here:
 *
 *   1. Identity comes from the CREDENTIAL, never the payload. What a caller claims
 *      to be is not evidence of what it is.
 *   2. Rejection happens BEFORE the first database read. An auth check that runs
 *      after the row is fetched still leaks state and still risks a partial write.
 *
 * WHY NOT THE `admin` SCOPE — the part that matters most, and the reason the
 * obvious fix does not work. `POST /api/v1/agents/register` is public (the PAI
 * onboarding calls it with no key) and issues every new agent a key carrying
 * `['score_event', 'llm_complete', 'read_card', 'admin']` — see
 * routes/agents-external.ts. So `scopes.includes('admin')` authorises **anyone who
 * can send one unauthenticated POST**. A check written that way looks like a
 * control and is not one: the hole stays open, one registration call wide, while
 * the code reads as fixed. That is precisely the failure this codebase is built
 * against — a system reporting success it has not earned.
 *
 * So this requires a scope that registration does NOT hand out. `bounty_verify`
 * is granted deliberately, per key, through `POST /agents/:id/keys`
 * (routes/key-management.ts, itself admin-gated) and by nothing else.
 *
 * WHY NO NEW ENVIRONMENT SECRET. #445 proposed a `CONTROLLER_MASTER_KEY` bearer
 * secret alongside the scope check. Declined, for two reasons that are worth
 * keeping written down:
 *
 *   - An env var that does not exist yet reads as the empty string, so a check
 *     gated on it FAILS OPEN unless the secret is deployed strictly before the
 *     code that reads it. That ordering dependency is a live foot-gun on a money
 *     path, and it buys nothing here.
 *   - A shared bearer secret carries no identity, so every payout approved
 *     through it would be recorded with a null verifier. On a route whose entire
 *     job is attributing a payout, an unattributable approval is a hole of its
 *     own. #445's own patch recorded `verifierAgentId: null` on that branch.
 *
 * The scoped key already in `agent_api_keys` gives identity AND authorisation in
 * one credential, so a second path would add surface without adding capability.
 *
 * FAIL CLOSED, INCLUDING TODAY. No key currently carries `bounty_verify`, so this
 * route denies every caller until an operator issues one on purpose. For a route
 * that was previously open to the world, deny-by-default is the correct resting
 * state — a payout path should be unreachable until someone deliberately makes it
 * reachable, not the other way round. There is deliberately no env-var override:
 * `stake-authorization.ts` carries one because it was retrofitted onto a live
 * caller that might have depended on the old behaviour, and nothing calls this
 * route in-repo, so there is no such caller to protect.
 */

import { validateAgentApiKey } from '../auth/api-keys';

/**
 * The scope a key must carry to verify a bounty.
 *
 * Deliberately NOT `admin` — see the module header. Deliberately absent from the
 * default set in `routes/agents-external.ts`; if it is ever added there, this
 * control silently becomes a no-op, so that file and this constant have to move
 * together.
 */
export const BOUNTY_VERIFY_SCOPE = 'bounty_verify';

export interface BountyAuthzResult {
  ok: boolean;
  /**
   * The agent id bound to the presented credential. This is what gets recorded as
   * the verifier — never a value from the request body.
   */
  verifierAgentId?: string;
  reason?: 'no_credential' | 'invalid_credential' | 'insufficient_scope' | 'lookup_failed';
  detail?: string;
}

export interface BountyAuthzInput {
  /** Raw `Authorization` header, if any. */
  authorizationHeader?: string;
  /** Raw `x-api-key` header, if any. */
  apiKeyHeader?: string;
}

/** Extract a bearer token, tolerating case and surrounding whitespace. */
function bearerFrom(header?: string): string | null {
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * May this caller verify a bounty, and under whose identity?
 *
 * Pure with respect to bounty state: it reads only the credential, so the caller
 * can run it before touching `repid_bounties` at all. That ordering is the second
 * half of the fix and it is the route's job to preserve — see routes/bounties.ts.
 */
export async function authorizeBountyVerification(
  input: BountyAuthzInput,
): Promise<BountyAuthzResult> {
  const presented = input.apiKeyHeader?.trim() || bearerFrom(input.authorizationHeader);

  if (!presented) {
    return {
      ok: false,
      reason: 'no_credential',
      detail:
        'Bounty verification requires an API key carrying the ' +
        `\`${BOUNTY_VERIFY_SCOPE}\` scope. Send it as \`x-api-key\` or ` +
        '`Authorization: Bearer <key>`.',
    };
  }

  let validated: { agent_id: string; scopes: string[] } | null;
  try {
    validated = await validateAgentApiKey(presented);
  } catch (e) {
    // An unreachable database must never read as "authorized". This is the one
    // branch most likely to be got wrong under pressure, so it is explicit.
    return {
      ok: false,
      reason: 'lookup_failed',
      detail: `Could not verify the credential: ${(e as Error).message}`,
    };
  }

  if (!validated) {
    return {
      ok: false,
      reason: 'invalid_credential',
      detail: 'That key is not recognised, or it has been revoked.',
    };
  }

  if (!validated.scopes.includes(BOUNTY_VERIFY_SCOPE)) {
    return {
      ok: false,
      reason: 'insufficient_scope',
      detail:
        `That key is valid but does not carry the \`${BOUNTY_VERIFY_SCOPE}\` scope. ` +
        'It is granted per key via `POST /agents/:id/keys`, never at registration.',
    };
  }

  return { ok: true, verifierAgentId: validated.agent_id };
}
