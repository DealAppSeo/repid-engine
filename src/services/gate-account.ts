/**
 * gate-account.ts — turn a verified email into an account, without a password.
 *
 * THE MISSING FRONT DOOR. The loop starts "a human signs up and gets a RepID",
 * and the code for that has existed since April (/builder/full-signup, email +
 * password). The live numbers say nobody has ever walked through it: 73 builders,
 * 70 `token_only` and 3 `wallet`, ZERO with auth_method='email'. Meanwhile the
 * T0.5 agent gate has people typing a 6-digit code from their inbox already —
 * a STRONGER proof of address ownership than a password, and one fewer field.
 *
 * So the account comes from the proof we are already collecting. One code, and
 * you have an identity, a RepID, somewhere to post on the market, and the
 * ability to stake. No password to invent, store, or reset.
 *
 * FRICTION IN PROPORTION TO VALUE AND RISK — this is the middle rung:
 *   anonymous          browse, and a few free scored runs. Nothing to prove.
 *   email code (here)  an account and a RepID. Simulated stake, market posts.
 *   wallet signature   real USDC, and owning an agent. Proof of key control,
 *                      asked for only when real value is on the line.
 *
 * IDEMPOTENT BY CONSTRUCTION. Verifying twice must not mint a second account.
 * We look up by email first, then by the deterministic derived address (which
 * carries a UNIQUE constraint), and on a lost race we re-read rather than fail.
 *
 * DELIBERATE: AN OTP CAN LAND ON AN EXISTING PASSWORD ACCOUNT. If someone signed
 * up with a password and later verifies the same inbox, they get that same
 * account — not a duplicate. Proving you can read the inbox is the standard
 * recovery proof and is stronger than the reset-link click it replaces. Stating
 * it because it should be a decision, not a side effect.
 *
 * ⚠ NOT A PROOF OF PERSONHOOD, AND NOT A NEW ECONOMIC RULE. A verified email is
 * one inbox, not one human — someone with ten addresses gets ten accounts. The
 * starting RepID here deliberately MATCHES the existing password path rather
 * than inventing a different number, because changing what a signup is worth is
 * an economic decision and does not belong in plumbing. If the sybil surface
 * needs closing, it closes for both paths at once, by requiring the
 * proof-of-human SBT (see human-agent-binding.ts assuranceOf) — not by quietly
 * giving OTP accounts a different score.
 *
 * FLAG: GATE_PROVISIONS_ACCOUNT (default OFF). Original work that writes live
 * identity rows, so it lands finished and inert per CLAUDE_RULES 23.
 */

import { db } from '../db';
import { emitAuditEvent } from './audit-emit';
import { issueFullAccountToken } from './auth-token';
import { deriveAddressFromEmail } from './full-account-signup';

export const GATE_PROVISIONS_ACCOUNT = process.env.GATE_PROVISIONS_ACCOUNT === 'true';

/** Matches full-account-signup: the AUTONOMOUS floor. Same path, same number. */
const STARTING_REPID = 5000;

/** How this account's holder proved who they are. Distinct from 'email' (password). */
export const AUTH_METHOD_EMAIL_OTP = 'email_otp';

export interface GateAccountResult {
  ok: boolean;
  builder_id?: string;
  builder_address?: string;
  login_token?: string;
  /** true when this call created the row; false when it resolved an existing one. */
  created?: boolean;
  reason?: 'disabled' | 'invalid_email' | 'no_jwt_secret' | 'write_failed';
  detail?: string;
}

async function findExisting(
  email: string,
  address: string,
): Promise<{ id: string; address: string } | null> {
  const byEmail = await db
    .from('builders')
    .select('id, address')
    .ilike('email', email)
    .maybeSingle();
  if (byEmail.data) return byEmail.data as { id: string; address: string };

  const byAddress = await db
    .from('builders')
    .select('id, address')
    .ilike('address', address)
    .maybeSingle();
  if (byAddress.data) return byAddress.data as { id: string; address: string };

  return null;
}

/**
 * Get or create the account behind a verified email, and mint a full-account
 * login token for it.
 *
 * The caller MUST have already verified the email (this is invoked from the OTP
 * success path). It performs no verification of its own — passing an unverified
 * address here would hand out an account for an inbox nobody proved they own.
 */
export async function provisionAccountFromVerifiedEmail(
  emailRaw: string,
): Promise<GateAccountResult> {
  if (!GATE_PROVISIONS_ACCOUNT) {
    return { ok: false, reason: 'disabled', detail: 'Account provisioning is not enabled on this deployment.' };
  }
  if (typeof emailRaw !== 'string' || !emailRaw.includes('@')) {
    return { ok: false, reason: 'invalid_email', detail: 'A verified email is required.' };
  }
  const email = emailRaw.toLowerCase();
  const address = deriveAddressFromEmail(email).toLowerCase();

  const existing = await findExisting(email, address);
  if (existing) {
    const token = mintToken(existing.id, email);
    if (!token) return { ok: false, reason: 'no_jwt_secret', detail: 'Server is missing its token secret.' };
    return {
      ok: true,
      builder_id: existing.id,
      builder_address: existing.address,
      login_token: token,
      created: false,
    };
  }

  const { data, error } = await db
    .from('builders')
    .insert({
      address,
      email,
      // No password_hash — there is no password. The inbox is the credential.
      current_repid: STARTING_REPID,
      ghost_cohort_count: 0,
      display_name: email.split('@')[0],
      earns_repid_rewards: true,
      auth_method: AUTH_METHOD_EMAIL_OTP,
      agent_count: 0,
      notification_prefs: {},
    })
    .select('id, address')
    .single();

  if (error || !data) {
    // Lost a race against a concurrent verification of the same email? The
    // UNIQUE(address) constraint is what caught it — re-read and return that
    // account rather than surfacing a write error for a request that succeeded.
    const raced = await findExisting(email, address);
    if (raced) {
      const token = mintToken(raced.id, email);
      if (!token) return { ok: false, reason: 'no_jwt_secret', detail: 'Server is missing its token secret.' };
      return {
        ok: true,
        builder_id: raced.id,
        builder_address: raced.address,
        login_token: token,
        created: false,
      };
    }
    return { ok: false, reason: 'write_failed', detail: error?.message ?? 'insert failed' };
  }

  const token = mintToken(data.id, email);
  if (!token) return { ok: false, reason: 'no_jwt_secret', detail: 'Server is missing its token secret.' };

  await emitAuditEvent({
    event_type: 'gate_account_provisioned',
    source_table: 'builders',
    source_id: data.id,
    payload: {
      builder_id: data.id,
      builder_address: data.address,
      auth_method: AUTH_METHOD_EMAIL_OTP,
      starting_repid: STARTING_REPID,
    },
  }).catch(() => {
    // An audit hiccup must never cost someone the account they just made.
  });

  return {
    ok: true,
    builder_id: data.id,
    builder_address: data.address,
    login_token: token,
    created: true,
  };
}

function mintToken(builderId: string, email: string): string | null {
  try {
    return issueFullAccountToken(builderId, email);
  } catch {
    return null;
  }
}
