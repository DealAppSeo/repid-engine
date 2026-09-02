// src/config/flag-readiness.ts
//
// "Is this feature flag actually on in THIS deployment?" — answered by the
// deployment itself, in status words, never in values.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// On 2026-09-02 the answer to "is HUMAN_AGENT_BIND_ENABLED set on Railway?" was
// asserted three different ways in one session — "it's off", then "it doesn't
// exist, create it", then, once measured, "it was on the whole time". Every one
// of those was a guess, because Railway's dashboard is the only place the answer
// lived and the person guessing could not reach it (proxy-denied, MEASURED
// 2026-09-02: `curl: (56) CONNECT tunnel failed, response 403`).
//
// That is the same defect `lib/trustshell/config-readiness.ts` was written for
// in the trinity repo, whose header records the identical shape: "there was NO
// WAY TO ASK EITHER ONE whether the secret was set." The only available check
// was to drive the feature in production and watch what it did. That is not a
// check, that is an experiment on live users.
//
// This is the ask. It costs one keyless GET and it removes a whole class of
// "go and look in the dashboard for me".
//
// ── `ignored_value` IS THE ENTIRE POINT ─────────────────────────────────────
//
// Every gate in this engine is `process.env.X === 'true'` — a strict, lowercase
// string comparison. So `ON`, `TRUE`, `True`, `1` and `yes` all evaluate FALSE
// and the feature stays off.
//
// A dashboard renders those as a variable that is present and populated. The
// operator sees a set variable; the process sees a disabled feature; nothing
// anywhere reports a disagreement. Folding that into `off` would make this
// endpoint agree with the process and leave the operator's actual mistake
// invisible — reporting a state that is technically correct and useless, which
// is the failure this file exists to end.
//
// So `off` (nothing set — the deliberate default) and `ignored_value` (set to
// something the code will not honour) are DIFFERENT WORDS. They are
// behaviourally identical and administratively opposite, and only the second one
// means "go and fix your typo".
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
//
//   * NEVER a value, a prefix, a suffix or a length. Status words only, so a
//     variable that is not a boolean flag cannot leak through here.
//   * NEVER `Object.keys(process.env)`. A hardcoded allowlist, so adding a
//     variable to Railway cannot make it appear on a public endpoint by
//     accident. This is the same rule `routes/health.ts` follows for commit
//     metadata and the reason it has never leaked one.
//   * NEVER secrets. Presence-reporting for a credential is a larger disclosure
//     decision than a feature flag and is not made here by implication. This
//     module classifies booleans; if a secret ever needs reporting it gets its
//     own allowlist, its own statuses and its own argument.
//
// ── WHY PUBLIC IS SAFE FOR THESE TWO ────────────────────────────────────────
//
// Both flags' states are ALREADY user-visible by design:
//
//   SELF_SERVE_ACCOUNTS_ENABLED  `POST /api/v1/account/connect` answers 503
//                                `disabled` when off and 401 `signature_required`
//                                when on, to any keyless caller. The state is
//                                already a public fact; this only stops people
//                                having to send a write request to learn it.
//   HUMAN_AGENT_BIND_ENABLED     `services/listing-bridge.ts` returns the prose
//                                "ownership binding is not enabled on this
//                                deployment" straight to a caller, and
//                                `GET /api/v1/human/agents` returns `enabled`
//                                verbatim. It is shipped copy, not a secret.
//
// Publishing "a feature is off" tells an attacker that a surface they cannot
// reach is one they still cannot reach. What it buys everyone else is the
// difference between configured and configured-badly.

/**
 * Four states, because three would collapse "set to a value the code ignores"
 * into "off" — and that collapse is exactly the bug. See the header.
 */
export type FlagStatus =
  /** Set to exactly `'true'`. The gate is open. */
  | 'on'
  /** Not set at all, or set to empty/whitespace. The gate is closed, as intended. */
  | 'off'
  /** Set to a non-empty value that is NOT `'true'`, so the gate is closed while the
   *  dashboard shows it populated. Someone typed `ON` and believes it is on. */
  | 'ignored_value';

export interface FlagReadiness {
  /** Per-flag status. Names are fixed; see `PUBLIC_FLAGS`. */
  flags: Record<string, FlagStatus>;
  /**
   * Flags that are set to something the code will not honour. Empty is the
   * healthy state — this is NOT a list of "off" flags, because off is a
   * legitimate, deliberate configuration and needs no attention.
   */
  misconfigured: string[];
}

/**
 * The allowlist. HARDCODED, never derived from `process.env`.
 *
 * A flag belongs here when its state is already observable to an unauthenticated
 * caller through behaviour or shipped copy (see the header's table). Adding one
 * that is not is a disclosure decision, not a maintenance edit — say why in the
 * `why` field, which exists to make that argument mandatory rather than optional.
 */
export const PUBLIC_FLAGS: readonly { name: string; why: string }[] = [
  {
    name: 'SELF_SERVE_ACCOUNTS_ENABLED',
    why: 'POST /api/v1/account/connect already answers 503 disabled vs 401 signature_required to any keyless caller.',
  },
  {
    name: 'HUMAN_AGENT_BIND_ENABLED',
    why: 'GET /api/v1/human/agents returns this flag as `enabled`, and listing-bridge returns "not enabled on this deployment" as user-facing prose.',
  },
];

/**
 * The one comparison every gate in this engine uses, in one place.
 *
 * `byok.ts`, `human-agent-binding.ts` and `listing-bridge.ts` each spell
 * `=== 'true'` themselves. This does NOT replace them — a readiness reporter
 * that redefined the rule it reports on could drift from the gates and report a
 * feature on while it was off, which is worse than not reporting at all. It
 * restates the rule so the restatement can be pinned by a test against the real
 * call sites.
 */
export const TRUTHY = 'true';

/**
 * Classify one flag. Pure, so every branch can be asserted without touching
 * `process.env` — and so this module has no side effects at import time.
 */
export function classifyFlag(value: string | undefined): FlagStatus {
  if (value === undefined || value.trim() === '') return 'off';
  // Not `.trim()`-ed before comparing: the gates compare the RAW value, so
  // `' true'` is off to them and must be `ignored_value` here. Trimming would
  // report `on` for a value that does not open the gate — the reporter drifting
  // from the thing reported, which is the one failure this file cannot have.
  return value === TRUTHY ? 'on' : 'ignored_value';
}

/**
 * Read the allowlist out of an environment.
 *
 * Takes the environment as an argument rather than reaching for `process.env`,
 * so a test can drive every branch without mutating global state.
 */
export function describeFlagReadiness(
  env: Record<string, string | undefined>
): FlagReadiness {
  const flags: Record<string, FlagStatus> = {};
  const misconfigured: string[] = [];

  for (const flag of PUBLIC_FLAGS) {
    const status = classifyFlag(env[flag.name]);
    flags[flag.name] = status;
    if (status === 'ignored_value') misconfigured.push(flag.name);
  }

  return { flags, misconfigured };
}
