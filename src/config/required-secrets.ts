/**
 * Secrets the API refuses to BOOT without (Sean, 2026-10-08: "If CONTROLLER_QR_SECRET or
 * ORACLE_HMAC_SECRET is unset, the process refuses to start. A default in the repo is how the
 * forged token worked.").
 *
 * F-13 and F-15 already made these fail closed per request: unset means every signature is refused
 * and no QR token mints or verifies. This is the stronger form Sean asked for — the server does not
 * come up at all when either is missing, so there is no window in which a route is reachable while
 * the operator believes the secret is set. Each name here is a credential with NO default anywhere
 * in the code; the boot check is the last place a missing one can hide.
 *
 * The check is called from the server entry (src/index.ts), inside its `if (!IS_TEST)` block, so a
 * production or local-dev boot refuses while Jest — which imports `app` directly and sets
 * NODE_ENV=test — is unaffected. assertRequiredSecrets is exported and unit-tested on its own
 * (tests/boot-required-secrets.test.ts), so the rule is a test, not only a line in a startup path.
 *
 * DEPLOY ORDER. Set both on the repid-engine API service in Railway BEFORE deploying this, or the
 * API will not start. ORACLE_HMAC_SECRET can be a reference to the proof-drain worker's existing
 * value (${{proof-drain-worker.ORACLE_HMAC_SECRET}}); CONTROLLER_QR_SECRET is a fresh value
 * generated in Railway's own field, never one used elsewhere.
 */

/** name → why it is load-bearing, for the boot error and for the test. */
export const REQUIRED_AT_BOOT: Record<string, string> = {
  CONTROLLER_QR_SECRET:
    'signs and verifies controller QR tokens; unset, a forged token signed with any value is the only alternative',
  ORACLE_HMAC_SECRET:
    'signs and verifies bet outcomes before settlement; unset, any outcome could be signed',
};

export class MissingRequiredSecretsError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `repid-engine refuses to start: these secrets are unset and have no default — ` +
        missing.map((n) => `${n} (${REQUIRED_AT_BOOT[n]})`).join('; ') +
        `. Set them on the repid-engine API service in Railway, then redeploy.`,
    );
    this.name = 'MissingRequiredSecretsError';
    this.missing = missing;
  }
}

/**
 * Throws MissingRequiredSecretsError naming EVERY missing secret (not just the first), so one boot
 * attempt reports the whole set. A value that is present but blank or whitespace counts as missing:
 * an empty string is not a secret.
 */
export function assertRequiredSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const missing = Object.keys(REQUIRED_AT_BOOT).filter((name) => !(env[name] ?? '').trim());
  if (missing.length > 0) throw new MissingRequiredSecretsError(missing);
}
