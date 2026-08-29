/**
 * Which account-creation doors are open, and why — reported, never assumed.
 *
 * WHY THIS EXISTS. The password signup route was retired (see
 * `docs/design/progressive-trust-ladder.v0.md`), leaving the email-OTP path as
 * the ONLY way to create a full account. That is the intended shape, and it has
 * one dangerous property: the OTP path depends on three pieces of deploy-time
 * configuration, and if any is missing it fails silently — the visitor gets a
 * form that appears to work and no account is ever created. Closing one door
 * without being able to see whether the other is open is how a front door
 * quietly stops existing.
 *
 * So this module answers "can anyone sign up right now, and if not, which
 * precondition is missing" — and `GET /security/status` publishes the answer,
 * which makes it checkable from outside the deploy with no dashboard access.
 *
 * THREE INDEPENDENT WAYS THE OTP DOOR SHUTS, and they are reported separately
 * because they need different fixes:
 *   - account provisioning disabled → verification succeeds and no account is
 *     created (the run-allowance gate still works, so nothing looks broken)
 *   - email delivery unconfigured   → `sendOtpEmail` returns `email_disabled`
 *     and the visitor never receives a code
 *   - token signing unconfigured    → the token issuer returns null, so a
 *     verified visitor gets no session
 *
 * Collapsing those into one boolean would report "signup is broken" and hide
 * which of three unrelated fixes is needed.
 *
 * NO CREDENTIAL NAMES OR VALUES ARE REPORTED — only whether a capability is
 * configured. This endpoint is public.
 */

/** A door is OPEN, SHUT (fixable config), or RETIRED (closed by decision, permanently). */
export type DoorState = 'OPEN' | 'SHUT' | 'RETIRED';

export interface SignupPosture {
  password: {
    state: 'RETIRED';
    reason: string;
  };
  email_otp: {
    state: Exclude<DoorState, 'RETIRED'>;
    account_provisioning: 'ENABLED' | 'DISABLED';
    email_delivery: 'CONFIGURED' | 'NOT_CONFIGURED';
    token_signing: 'CONFIGURED' | 'NOT_CONFIGURED';
    /** Every unmet precondition, not just the first. Empty when the door is OPEN. */
    blocked_by: string[];
  };
  /** False means NOBODY can create an account right now. */
  any_path_open: boolean;
  note: string;
}

const PASSWORD_RETIRED_REASON =
  'Retired: it created accounts from an unverified email address, so ownership of the address was asserted rather than proven. The email-OTP path proves it with a code the holder must read.';

export function signupPosture(): SignupPosture {
  const provisioning = process.env.GATE_PROVISIONS_ACCOUNT === 'true';
  const emailDelivery = !!process.env.RESEND_API_KEY;
  const tokenSigning = !!process.env.FULL_ACCOUNT_JWT_SECRET;

  const blocked: string[] = [];
  if (!provisioning) blocked.push('account provisioning is disabled — a verified visitor gets a session but no account');
  if (!emailDelivery) blocked.push('email delivery is not configured — no verification code can be sent');
  if (!tokenSigning) blocked.push('token signing is not configured — a verified visitor gets no session');

  const otpOpen = blocked.length === 0;

  return {
    password: { state: 'RETIRED', reason: PASSWORD_RETIRED_REASON },
    email_otp: {
      state: otpOpen ? 'OPEN' : 'SHUT',
      account_provisioning: provisioning ? 'ENABLED' : 'DISABLED',
      email_delivery: emailDelivery ? 'CONFIGURED' : 'NOT_CONFIGURED',
      token_signing: tokenSigning ? 'CONFIGURED' : 'NOT_CONFIGURED',
      blocked_by: blocked,
    },
    any_path_open: otpOpen,
    note: otpOpen
      ? 'Email-OTP is the only account-creation path, and it is open.'
      : 'NO ACCOUNT CREATION PATH IS OPEN. The password path is retired and the email-OTP path is missing configuration listed in blocked_by.',
  };
}

let logged = false;

/**
 * Say it once, loudly, in the deploy log. The posture endpoint is the reliable
 * observable; this is here so a deploy that shuts the last door is visible to
 * whoever is watching the log roll by, without them having to think to ask.
 */
export function logSignupPostureOnce(): void {
  if (logged) return;
  logged = true;
  const p = signupPosture();
  if (p.any_path_open) {
    console.log('[signup] password path RETIRED; email-OTP path OPEN — accounts can be created.');
  } else {
    console.error(`[signup] NO ACCOUNT CREATION PATH IS OPEN — ${p.email_otp.blocked_by.join('; ')}`);
  }
}

/** Test seam: the once-only log is process-scoped, so a suite must be able to rearm it. */
export function __resetSignupPostureLogForTests(): void {
  logged = false;
}
