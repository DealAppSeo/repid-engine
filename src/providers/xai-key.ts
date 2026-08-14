/**
 * xai-key.ts — ONE definition of how the xAI/Grok credential is named and ranked.
 *
 * WHY THIS FILE EXISTS. The same credential was being resolved in four places from the same two
 * env names, and no two of them agreed:
 *
 *   src/hal/fact-check.ts            GROK_API_KEY || XAI_API_KEY
 *   scripts/dispatch/run-agent.mjs   ['XAI_API_KEY', 'GROK_API_KEY']
 *   src/hal/crag.ts                  GROK_API_KEY only
 *   src/services/provider-key-probe  GROK_API_KEY only
 *
 * None of those fail loudly. A missing fallback makes an optional lever a no-op, and a reversed
 * precedence only diverges when both vars are set — so every one of them reads as "nothing to
 * report" rather than as an error. That is the #398 shape: an inconsistency with no failing signal.
 *
 * WHICH INVENTORY SUPPLIES WHICH NAME — measured, and the two do NOT agree:
 *   `.env.master`   `XAI_API_KEY`   canonicalised by #398 [V 2026-08-05, run-agent.mjs]
 *   Railway         `GROK_API_KEY`  legacy name only; XAI_API_KEY is NOT set there
 *                                   [V 2026-08-14, names-only pull, confirmed by Sean]
 *
 * So the two `GROK_API_KEY only` readers above were CORRECT against Railway and broken only where
 * `.env.master` supplies the name — which is where the ops CLI runs, so the probe genuinely did
 * report `grok` absent there. An earlier revision of this comment claimed both inventories used
 * `XAI_API_KEY` and therefore that the grader was dead in production. It was not. That claim was
 * inherited unverified from the comment on `grokApiKey()` in fact-check.ts and restated here, which
 * is the exact "inherited the wrong premise" failure CLAUDE.md opens with. Re-verify before
 * repeating either line: Railway is not readable from a sandboxed session.
 *
 * CANONICAL ORDER: `XAI_API_KEY` first — it is the standard xAI env name and what #398 settled on.
 * `GROK_API_KEY` is the legacy fallback and is still accepted, because dropping it is exactly the
 * rename that un-dispatched XC, and because it is currently the ONLY name set on Railway. Do not
 * remove the fallback until Railway is renamed.
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
