/**
 * Anonymous (token-only) builder signup.
 *
 * For the live demo at /reponomics-live/. A visitor who doesn't want
 * to connect a wallet can request a builder identity via this flow:
 *
 *   POST /api/v1/builder/token-signup
 *   ↓
 *   createAnonymousBuilder() → { token, builder_id, builder_address }
 *
 * Token = 32-byte random hex (64 chars). builder_address is derived
 * deterministically from the token so anyone holding the token can
 * recover the address without storing it client-side. Specifically:
 *
 *   builder_address = '0xT0KEN' + first 34 hex chars of sha256(token)
 *                     (= 6 + 34 = 40 hex chars total ⇒ valid 0x-prefixed
 *                      20-byte EIP-55-shaped address space)
 *
 * The '0xT0KEN' prefix is intentional and visible — it makes it obvious
 * by inspection that this is a demo/token-only address and not a real
 * EVM wallet. Real wallets never start with that pattern.
 *
 * Token-only builders have:
 *   earns_repid_rewards = false   see below — this is a LABEL, not the control
 *   auth_method         = 'token_only'
 *   session_token       = <token>
 *
 * WHAT ACTUALLY CONTAINS THEM, because this comment used to name the wrong thing and a wrong
 * mechanism is worse than none: it invites someone to delete the real guard as redundant, or to
 * add a second creation path believing the flag still covers it.
 *
 * `earns_repid_rewards` enforces NOTHING [MEASURED 2026-08-29]. It is read in exactly one place
 * in the codebase — the dashboard, which echoes it into a response body. No scoring path branches
 * on it, and `repid-update.ts` never reads a builder row at all.
 *
 * The containment is structural and lives two layers away:
 *   RepID accrues to AGENTS (`repid_agents`), never to builders.
 *   The only route that creates one is POST /api/v1/builder/create-agent.
 *   That route is behind `requireFullAccount`, which verifies a SIGNED login token.
 *   Only the OTP path mints one; a `token_only` builder's `session_token` is 32 random bytes
 *   and cannot be made into a signed token.
 *
 * `createBuilderAgent` itself checks only that the builder EXISTS — not auth_method, not email,
 * not this flag. So the route guard is the whole control, and it is pinned by
 * tests/keyless-builder-containment.test.ts rather than left to this comment.
 *
 * Per CLAUDE-RULE-4: every response includes
 *   { repid_rewards_eligible: false, message: "Token-only access. Mint ERC-7231 later to earn RepID rewards." }
 * so the visitor isn't surprised when their RepID stays at zero.
 */

import { randomBytes, createHash } from 'crypto';
import { STARTING_REPID } from '../scoring/repid-constants';
import { db } from '../db';
import { emitAuditEvent } from './audit-emit';

const TOKEN_LEN_BYTES = 32;

export interface AnonymousBuilderResult {
  ok: boolean;
  token: string;
  builder_id: string;
  builder_address: string;
  repid_rewards_eligible: false;
  message: string;
  error?: string;
}

export function deriveAddressFromToken(token: string): string {
  const hash = createHash('sha256').update(token).digest('hex');
  // '0xT0KEN' + 34 hex chars = 40 hex chars (a valid-shaped 20-byte address).
  // T0KEN is not in the hex alphabet, so EIP-55 checksum will never validate
  // — that's intentional. These addresses are demo-only.
  return '0xT0KEN' + hash.slice(0, 34);
}

export async function createAnonymousBuilder(): Promise<AnonymousBuilderResult> {
  const token = randomBytes(TOKEN_LEN_BYTES).toString('hex');
  const address = deriveAddressFromToken(token);

  const { data, error } = await db
    .from('builders')
    .insert({
      address: address.toLowerCase(),
      current_repid: STARTING_REPID,
      ghost_cohort_count: 0,
      display_name: 'Demo Builder (token-only)',
      earns_repid_rewards: false,
      auth_method: 'token_only',
      session_token: token,
    })
    .select('id')
    .single();

  if (error || !data) {
    return {
      ok: false,
      token: '',
      builder_id: '',
      builder_address: '',
      repid_rewards_eligible: false,
      message: 'failed to create anonymous builder',
      error: error?.message ?? 'no data returned',
    };
  }

  await emitAuditEvent({
    event_type: 'anonymous_builder_created',
    source_table: 'builders',
    source_id: data.id,
    payload: {
      builder_id: data.id,
      builder_address: address,
      auth_method: 'token_only',
      earns_repid_rewards: false,
    },
  });

  return {
    ok: true,
    token,
    builder_id: data.id,
    builder_address: address,
    repid_rewards_eligible: false,
    message: 'Token-only access. Mint ERC-7231 later to earn RepID rewards.',
  };
}

/**
 * Lookup an anonymous builder by their session token. Used when a
 * returning visitor pastes their token back into the demo page.
 */
export async function getBuilderByToken(token: string): Promise<{
  builder_id: string;
  builder_address: string;
} | null> {
  if (!token || token.length < 8) return null;
  const { data } = await db
    .from('builders')
    .select('id, address')
    .eq('session_token', token)
    .maybeSingle();
  if (!data) return null;
  return { builder_id: data.id, builder_address: data.address };
}
