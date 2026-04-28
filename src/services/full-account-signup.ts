/**
 * Full-account (email + password) builder signup.
 *
 * Builder is created with auth_method='email', earns_repid_rewards=true,
 * current_repid=5000 (start at AUTONOMOUS tier so they immediately have
 * authority to operate agents). Address is derived deterministically from
 * email so it's stable across signups (and obvious it's a demo address).
 *
 *   builder_address = '0xEMAIL' + first 34 hex of sha256(email)
 *
 * '0xEMAIL' prefix mirrors the '0xT0KEN' convention for anonymous builders
 * — visible by inspection that this is not a real EVM wallet.
 *
 * If the caller supplies a real walletAddress, that overrides the
 * derived one (for users who already hold a wallet). bcryptjs cost 10.
 */

import bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
import { db } from '../db';
import { emitAuditEvent } from './audit-emit';
import { issueLoginToken } from './full-account-token';

const STARTING_REPID = 5000; // AUTONOMOUS tier floor
const BCRYPT_COST = 10;

export interface FullSignupInput {
  email: string;
  password: string;
  walletAddress?: string;
}

export interface FullSignupResult {
  ok: boolean;
  builder_id?: string;
  builder_address?: string;
  login_token?: string;
  repid_rewards_eligible?: true;
  error?: string;
}

export function deriveAddressFromEmail(email: string): string {
  const hash = createHash('sha256').update(email.toLowerCase()).digest('hex');
  return '0xEMAIL' + hash.slice(0, 34);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(email: string): boolean {
  return typeof email === 'string' && EMAIL_RE.test(email) && email.length <= 320;
}

export function validatePassword(password: string): { ok: boolean; error?: string } {
  if (typeof password !== 'string') return { ok: false, error: 'password must be a string' };
  if (password.length < 8) return { ok: false, error: 'password must be at least 8 characters' };
  if (password.length > 200) return { ok: false, error: 'password must be at most 200 characters' };
  return { ok: true };
}

export async function createFullBuilder(input: FullSignupInput): Promise<FullSignupResult> {
  if (!validateEmail(input.email)) {
    return { ok: false, error: 'invalid email format' };
  }
  const pwCheck = validatePassword(input.password);
  if (!pwCheck.ok) return { ok: false, error: pwCheck.error };

  const emailLower = input.email.toLowerCase();
  const address = (input.walletAddress ?? deriveAddressFromEmail(emailLower)).toLowerCase();

  const { data: existing } = await db
    .from('builders')
    .select('id')
    .ilike('email', emailLower)
    .maybeSingle();
  if (existing) {
    return { ok: false, error: 'email already registered' };
  }

  const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

  const { data, error } = await db
    .from('builders')
    .insert({
      address,
      email: emailLower,
      password_hash: passwordHash,
      current_repid: STARTING_REPID,
      ghost_cohort_count: 0,
      display_name: emailLower.split('@')[0],
      earns_repid_rewards: true,
      auth_method: 'email',
      agent_count: 0,
      notification_prefs: {},
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'insert failed' };
  }

  const token = issueLoginToken(data.id, emailLower);

  await emitAuditEvent({
    event_type: 'full_account_builder_created',
    source_table: 'builders',
    source_id: data.id,
    payload: {
      builder_id: data.id,
      builder_address: address,
      auth_method: 'email',
      earns_repid_rewards: true,
      starting_repid: STARTING_REPID,
    },
  });

  return {
    ok: true,
    builder_id: data.id,
    builder_address: address,
    login_token: token,
    repid_rewards_eligible: true,
  };
}

export async function verifyPassword(email: string, password: string): Promise<{
  ok: boolean;
  builder_id?: string;
  error?: string;
}> {
  if (!validateEmail(email)) return { ok: false, error: 'invalid email' };
  const { data: builder } = await db
    .from('builders')
    .select('id, password_hash')
    .ilike('email', email.toLowerCase())
    .maybeSingle();
  if (!builder || !builder.password_hash) {
    return { ok: false, error: 'invalid credentials' };
  }
  const match = await bcrypt.compare(password, builder.password_hash);
  if (!match) return { ok: false, error: 'invalid credentials' };
  return { ok: true, builder_id: builder.id };
}
