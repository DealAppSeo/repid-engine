/**
 * Email OTP for the TrustShell agent gate (T0.5 commitment tier).
 *
 * Design (AUTH_KEY_CUSTODY_SPEC v0.4 §9.1 + Sean 2026-07-22):
 * anonymous visitors get a small free "taste" of hosted HAL-scored runs;
 * continuing past the taste asks for an email verified by a 6-digit OTP.
 * The email is a COMMITMENT device (save-your-progress + re-engagement),
 * not a security credential — passkeys remain the security story.
 *
 * Storage is in-memory by design: codes live 10 minutes, the engine runs
 * a single instance, and a redeploy simply means the visitor re-requests
 * a code. No schema change, no PII at rest beyond the audit event.
 *
 * Email delivery: Resend REST API. Requires RESEND_API_KEY (Railway env).
 * Without it the endpoints answer 503 email_disabled — loud, not silent.
 * RESEND_FROM defaults to Resend's shared onboarding sender; set a
 * verified-domain sender (e.g. "TrustShell <no-reply@trustshell.dev>")
 * once the domain is verified in Resend.
 *
 * Verified sessions are JWTs signed with FULL_ACCOUNT_JWT_SECRET (already
 * provisioned in Railway) with scope 'agent_gate' so they can never be
 * confused with full-account builder tokens.
 */

import { createHash, randomInt, timingSafeEqual } from 'crypto';
import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { emitAuditEvent } from './audit-emit';
import { db } from '../db';
import { provisionAccountFromVerifiedEmail, GATE_PROVISIONS_ACCOUNT } from './gate-account';

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const REQUESTS_PER_EMAIL_PER_HOUR = 3;
const REQUESTS_PER_IP_PER_HOUR = 10;
const TOKEN_EXPIRY = '30d' as const;
const TOKEN_SCOPE = 'agent_gate' as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PendingOtp {
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

const pending = new Map<string, PendingOtp>(); // key: email lower
const requestLog = new Map<string, number[]>(); // key: `e:${email}` | `i:${ip}` → sent timestamps

function sweep(now: number): void {
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  for (const [k, times] of requestLog) {
    const fresh = times.filter((t) => now - t < 60 * 60 * 1000);
    if (fresh.length === 0) requestLog.delete(k);
    else requestLog.set(k, fresh);
  }
}

function overHourlyLimit(key: string, limit: number, now: number): boolean {
  const times = (requestLog.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  requestLog.set(key, times);
  return times.length >= limit;
}

function hashCode(email: string, code: string): string {
  return createHash('sha256').update(`${email}:${code}`).digest('hex');
}

export function validGateEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 320 && EMAIL_RE.test(email);
}

async function sendOtpEmail(email: string, code: string): Promise<{ ok: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'email_disabled' };
  const from = process.env.RESEND_FROM || 'TrustShell <onboarding@resend.dev>';
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `${code} is your TrustShell code`,
        text:
          `Your TrustShell verification code is ${code}. It expires in 10 minutes.\n\n` +
          `We use your email to save your agent and send its trust reports — nothing else. ` +
          `No spam, no selling your address.\n\nIf you didn't request this, ignore this email.`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`[agent-gate] Resend send failed ${resp.status}: ${body.slice(0, 200)}`);
      return { ok: false, error: 'send_failed' };
    }
    return { ok: true };
  } catch (err: any) {
    console.error(`[agent-gate] Resend send error: ${err?.message}`);
    return { ok: false, error: 'send_failed' };
  }
}

export async function requestOtp(
  emailRaw: unknown,
  ip: string
): Promise<{ ok: boolean; error?: string; retry_after_minutes?: number }> {
  if (!validGateEmail(emailRaw)) return { ok: false, error: 'invalid_email' };
  const email = emailRaw.toLowerCase();
  const now = Date.now();
  sweep(now);

  if (overHourlyLimit(`e:${email}`, REQUESTS_PER_EMAIL_PER_HOUR, now) || overHourlyLimit(`i:${ip}`, REQUESTS_PER_IP_PER_HOUR, now)) {
    return { ok: false, error: 'too_many_requests', retry_after_minutes: 60 };
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const sent = await sendOtpEmail(email, code);
  if (!sent.ok) return { ok: false, error: sent.error };

  pending.set(email, { codeHash: hashCode(email, code), expiresAt: now + OTP_TTL_MS, attempts: 0 });
  requestLog.get(`e:${email}`)!.push(now);
  requestLog.get(`i:${ip}`)!.push(now);

  await emitAuditEvent({
    event_type: 'agent_gate_otp_requested',
    source_table: 'none',
    payload: { email_hash: createHash('sha256').update(email).digest('hex').slice(0, 16) },
  }).catch(() => {});

  return { ok: true };
}

export interface AgentGatePayload {
  email: string;
  scope: typeof TOKEN_SCOPE;
}

function readSecret(): string | null {
  const s = process.env.FULL_ACCOUNT_JWT_SECRET;
  return s && s.length > 0 ? s : null;
}

export function issueAgentGateToken(email: string): string | null {
  const secret = readSecret();
  if (!secret) return null;
  const opts: SignOptions = { algorithm: 'HS256', expiresIn: TOKEN_EXPIRY };
  return jwt.sign({ email: email.toLowerCase(), scope: TOKEN_SCOPE }, secret, opts);
}

export function verifyAgentGateToken(token: unknown): AgentGatePayload | null {
  if (!token || typeof token !== 'string') return null;
  const secret = readSecret();
  if (!secret) return null;
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload | string;
    if (typeof decoded === 'string') return null;
    if (decoded.scope !== TOKEN_SCOPE || typeof decoded.email !== 'string') return null;
    return { email: decoded.email, scope: TOKEN_SCOPE };
  } catch {
    return null;
  }
}

export async function verifyOtp(
  emailRaw: unknown,
  code: unknown,
  /**
   * The caller's Rung 0 session token, if they had one. Optional and untrusted: it is only ever
   * used to UPGRADE the anonymous row that token already identifies, and every refusal path
   * falls back to normal provisioning. A bad or absent token must never block someone whose
   * email is genuinely verified.
   */
  sessionToken?: unknown,
): Promise<{
  ok: boolean;
  token?: string;
  error?: string;
  /** Full-account login token. Present only when GATE_PROVISIONS_ACCOUNT is on. */
  login_token?: string;
  builder_id?: string;
  builder_address?: string;
  account_created?: boolean;
}> {
  if (!validGateEmail(emailRaw)) return { ok: false, error: 'invalid_email' };
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { ok: false, error: 'invalid_code' };
  const email = emailRaw.toLowerCase();
  const now = Date.now();
  sweep(now);

  const entry = pending.get(email);
  if (!entry || entry.expiresAt < now) return { ok: false, error: 'code_expired' };
  if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
    pending.delete(email);
    return { ok: false, error: 'too_many_attempts' };
  }
  entry.attempts += 1;

  const expected = Buffer.from(entry.codeHash, 'hex');
  const actual = Buffer.from(hashCode(email, code), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, error: 'wrong_code' };
  }

  pending.delete(email);
  const token = issueAgentGateToken(email);
  if (!token) {
    console.error('[agent-gate] FULL_ACCOUNT_JWT_SECRET unset — cannot issue gate token');
    return { ok: false, error: 'server_config' };
  }

  const emailHash = createHash('sha256').update(email).digest('hex').slice(0, 16);
  const dedupeSourceId = `agent-gate-verified-${emailHash}`;

  // First-ever verification for this email → one-time welcome email.
  // Dedup is durable via the audit chain's deterministic source_id, so a
  // redeploy (which clears the in-memory maps) never re-welcomes anyone.
  const firstTime = !(await hasPriorVerification(dedupeSourceId));

  await emitAuditEvent({
    event_type: 'agent_gate_email_verified',
    source_table: 'none',
    source_id: dedupeSourceId,
    payload: { email_hash: emailHash },
  }).catch(() => {});

  if (firstTime) {
    // Fire-and-forget: a welcome hiccup must never block the token.
    sendWelcomeEmail(email).catch((err) =>
      console.warn(`[agent-gate] welcome email failed: ${err?.message ?? err}`)
    );
  }

  // The same proof that raises the run allowance also earns an account, so the
  // human leg of the loop starts with one code instead of a second signup form.
  // ADDITIVE ONLY: the gate token above is unchanged and metering never depends
  // on this. If provisioning fails the caller still gets their verified session
  // — losing the account is recoverable on the next verify, losing the token
  // would strand someone who did everything right.
  if (GATE_PROVISIONS_ACCOUNT) {
    try {
      const account = await provisionAccountFromVerifiedEmail(email, {
        sessionToken: typeof sessionToken === 'string' ? sessionToken : undefined,
      });
      if (account.ok) {
        return {
          ok: true,
          token,
          login_token: account.login_token,
          builder_id: account.builder_id,
          builder_address: account.builder_address,
          account_created: account.created,
        };
      }
      console.warn(`[agent-gate] account provisioning declined: ${account.reason}`);
    } catch (err: any) {
      console.warn(`[agent-gate] account provisioning failed: ${err?.message ?? err}`);
    }
  }

  return { ok: true, token };
}

async function hasPriorVerification(sourceId: string): Promise<boolean> {
  try {
    const { data } = await db
      .from('hal_audit_chain')
      .select('id')
      .eq('source_id', sourceId)
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch {
    // On lookup failure err toward NOT sending — a missing welcome is
    // recoverable; a duplicate one reads as spam on a trust product.
    return true;
  }
}

/**
 * One-time welcome after first verification (Sean 2026-07-22). Scope is
 * honest: this welcome + the agent's trust reports are the only automatic
 * emails; anything recurring would be a separate explicit opt-in. The OTP
 * itself was the double opt-in (typing a code proves inbox ownership more
 * strongly than a confirmation click).
 */
export function buildWelcomeEmail(): { subject: string; text: string } {
  return {
    subject: "You're in — welcome aboard",
    text:
      `You're verified — welcome aboard.\n\n` +
      `Congratulations on being one of the early adopters helping build the trust ecosystem for AI. ` +
      `Your agent, its history, and its RepID progress are now saved, and your daily limit is raised to 100 HAL-scored runs.\n\n` +
      `What's next:\n` +
      `- Run prompts and watch your agent earn reputation: https://trustshell.dev/run\n` +
      `- See where it stands on the live leaderboard: https://trustshell.dev/leaderboard\n` +
      `- Have opinions on how reputation SHOULD work? The formula is public and open for debate — ` +
      `join the conversation at Trust Commons: https://github.com/DealAppSeo/trust-commons\n\n` +
      `About email: this welcome and your agent's trust reports are the only emails we send automatically. ` +
      `No newsletter unless you ask for one, no spam, no selling your address. Reply STOP and we'll never email you again.\n\n` +
      `— TrustShell · receipts, not promises\n` +
      `https://trustshell.dev\n`,
  };
}

async function sendWelcomeEmail(email: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;
  const from = process.env.RESEND_FROM || 'TrustShell <onboarding@resend.dev>';
  const { subject, text } = buildWelcomeEmail();
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from, to: [email], subject, text }),
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Resend welcome failed ${resp.status}: ${body.slice(0, 200)}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Daily run metering (taste for anonymous, generous cap for verified)
// ────────────────────────────────────────────────────────────────

const ANON_RUNS_PER_DAY = Number(process.env.AGENT_GATE_ANON_RUNS ?? 5);
const VERIFIED_RUNS_PER_DAY = Number(process.env.AGENT_GATE_VERIFIED_RUNS ?? 100);

const dayCounts = new Map<string, number>(); // key: `${yyyymmdd}|${id}`
let lastDay = '';

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function gateEnabled(): boolean {
  return process.env.AGENT_GATE_ENABLED !== 'false';
}

export interface MeterResult {
  allowed: boolean;
  verified: boolean;
  remaining: number;
  limit: number;
}

/** Count one hosted run against the caller. Verified callers are keyed by email, anonymous by IP. */
export function meterRun(ip: string, gateToken: unknown): MeterResult {
  const day = dayKey();
  if (day !== lastDay) {
    dayCounts.clear();
    lastDay = day;
  }
  const payload = verifyAgentGateToken(gateToken);
  const verified = payload !== null;
  const limit = verified ? VERIFIED_RUNS_PER_DAY : ANON_RUNS_PER_DAY;
  const key = `${day}|${verified ? `e:${payload!.email}` : `i:${ip}`}`;
  const used = dayCounts.get(key) ?? 0;
  if (used >= limit) return { allowed: false, verified, remaining: 0, limit };
  dayCounts.set(key, used + 1);
  return { allowed: true, verified, remaining: limit - used - 1, limit };
}

/** Peek without consuming (for UI state). */
export function peekRuns(ip: string, gateToken: unknown): MeterResult {
  const day = dayKey();
  const payload = verifyAgentGateToken(gateToken);
  const verified = payload !== null;
  const limit = verified ? VERIFIED_RUNS_PER_DAY : ANON_RUNS_PER_DAY;
  const key = `${day}|${verified ? `e:${payload!.email}` : `i:${ip}`}`;
  const used = day === lastDay ? dayCounts.get(key) ?? 0 : 0;
  return { allowed: used < limit, verified, remaining: Math.max(0, limit - used), limit };
}
