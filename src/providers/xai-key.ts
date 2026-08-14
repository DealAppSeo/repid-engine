/**
 * xai-key.ts — ONE definition of how the xAI/Grok credential is named and ranked.
 *
 * WHY THIS FILE EXISTS. The same credential was being resolved in four places from the same two
 * env names, and no two of them agreed:
 *
 *   src/hal/fact-check.ts            GROK_API_KEY || XAI_API_KEY
 *   scripts/dispatch/run-agent.mjs   ['XAI_API_KEY', 'GROK_API_KEY']
 *   src/hal/crag.ts                  GROK_API_KEY only        -> grader silently unreachable
 *   src/services/provider-key-probe  GROK_API_KEY only        -> reports a live key as absent
 *
 * None of those fail loudly. A missing fallback makes an optional lever a no-op, and a reversed
 * precedence only diverges when both vars are set — so every one of them reads as "nothing to
 * report" rather than as an error. That is the #398 shape: an inconsistency with no failing signal.
 *
 * CANONICAL ORDER: `.env.master` and Railway were canonicalised to `XAI_API_KEY` (#398), which is
 * also the standard xAI env name. `GROK_API_KEY` is the legacy fallback and is still accepted,
 * because dropping it is exactly the rename that un-dispatched XC.
 *
 * This module imports NOTHING on purpose. `src/hal/fact-check.ts` already imports `src/hal/crag.ts`,
 * so a resolver living in either of those cannot be shared by the other without a cycle. A leaf has
 * no such constraint, and it also stays importable from contexts that must not pull in config
 * (importing `src/config.ts` would make merely *reading a key name* require SUPABASE_URL at boot).
 *
 * `tests/grok-key-precedence-parity.test.ts` pins every consumer — including the dispatcher, which
 * cannot import this file — to the order declared here.
 */

/**
 * The xAI credential env names, MOST canonical first. Order is load-bearing: consumers resolve by
 * taking the first name that holds a non-blank value.
 */
export const XAI_KEY_VARS = ['XAI_API_KEY', 'GROK_API_KEY'] as const;

/**
 * Resolve the xAI/Grok API key, or undefined when none is configured.
 *
 * A blank/whitespace value is treated as ABSENT and falls through to the next name — a blank
 * canonical var must never shadow a real legacy key, which would be the silent no-op again, one
 * env var further along.
 */
export function grokApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of XAI_KEY_VARS) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}
