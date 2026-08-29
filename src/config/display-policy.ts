/**
 * DISPLAY POLICY — settings that decide what a surface SHOWS, kept as named variables rather
 * than baked into the code that computes the value.
 *
 * WHY THIS FILE EXISTS. A number can be correct and still be the wrong thing to show. The first
 * case is authority for a `token_only` builder: `computeAuthority` gives it a real figure off the
 * demo formula, and that figure is honest about what it computed — but nothing downstream would
 * honour it. `A_eff` (`effective-authority.ts`), which is what actually decides whether an agent
 * may delegate a budget, applies its builder floor unconditionally and would refuse. So the stake
 * page was quoting a ceiling that does not exist. That is an overpromise to the person reading it,
 * not a bug in the arithmetic.
 *
 * THE FIX IS AT THE DISPLAY BOUNDARY, NOT IN THE MATH. `computeAuthority` keeps computing and the
 * snapshot keeps recording what it computed — that is the audit trail and it must stay complete.
 * What changes is whether the number is handed to a caller as a promise.
 *
 * THREE LEVELS, DELIBERATELY, so a later per-user setting is a parameter and not a rewrite:
 *
 *   1. a default in code        — what happens when nobody has said anything
 *   2. a deployment override    — an env var, set per service
 *   3. a caller override        — passed in; this is where a per-user or per-builder preference
 *                                will plug in when there is a place to store one
 *
 * Level 3 has no storage behind it yet and that is stated rather than implied: `resolve()` accepts
 * an override today and nothing supplies one. Wiring a settings table to it later touches this
 * file's caller, not its callers' callers.
 */

/** What a surface does with an authority figure the gate would not honour. */
export type DemoAuthorityDisplay =
  /** Show no number at all. The caller is told why, so it can say "not shown" rather than "$0". */
  | 'hidden'
  /** Show the number, marked as demo-only and non-binding. */
  | 'labelled'
  /** Show it exactly as computed, unmarked. The pre-2026-08-29 behaviour. */
  | 'raw';

const VALID: readonly DemoAuthorityDisplay[] = ['hidden', 'labelled', 'raw'];

/**
 * Default: `hidden`.
 *
 * Chosen over `labelled` because a label is only read if someone reads it, and the number is the
 * part that gets screenshotted, quoted and planned around. Showing nothing cannot be misread.
 */
export const DEMO_AUTHORITY_DISPLAY_DEFAULT: DemoAuthorityDisplay = 'hidden';

/**
 * Resolve the setting: caller override, then deployment env, then the default.
 *
 * An unrecognised value falls back to the DEFAULT rather than to `raw`. That direction matters: a
 * typo in an env var must not silently restore the overpromising behaviour, which is exactly what
 * "unknown means leave it alone" would do here.
 */
export function resolveDemoAuthorityDisplay(
  override?: DemoAuthorityDisplay | string | null,
): DemoAuthorityDisplay {
  const fromCaller = normalize(override);
  if (fromCaller) return fromCaller;
  const fromEnv = normalize(process.env['DEMO_AUTHORITY_DISPLAY']);
  if (fromEnv) return fromEnv;
  return DEMO_AUTHORITY_DISPLAY_DEFAULT;
}

function normalize(v: unknown): DemoAuthorityDisplay | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return (VALID as readonly string[]).includes(s) ? (s as DemoAuthorityDisplay) : null;
}

/** What a caller should render, given a computed authority and how the floor was resolved. */
export interface AuthorityDisplay {
  /** The figure to show, or null when the policy says show nothing. Never a stand-in zero. */
  authority: string | null;
  /** True when a value is being withheld — so a caller can say "not shown", never "$0.00". */
  withheld: boolean;
  /** Non-binding means: the gate that gives out spend budgets would not honour this figure. */
  binding: boolean;
  /** Present whenever `withheld` or `!binding`, so the surface can explain itself. */
  detail?: string;
}

const NON_BINDING_DETAIL =
  'This builder has not passed the builder floor — the floor was not applied on its path at all. ' +
  'The authority ceiling that governs real spend delegation would refuse a budget here, so no ' +
  'figure is quoted. It is not zero; it is not established.';

/**
 * Decide what to show. `floorCheck` comes straight from `computeAuthority`.
 *
 * Only `NOT_APPLIED` is affected. A genuine `FAILED` already yields 0 authority from a floor that
 * really ran, and that 0 is a measured result the caller is entitled to show.
 */
export function decideAuthorityDisplay(
  authority: string,
  floorCheck: 'PASSED' | 'FAILED' | 'NOT_APPLIED',
  override?: DemoAuthorityDisplay | string | null,
): AuthorityDisplay {
  if (floorCheck !== 'NOT_APPLIED') {
    return { authority, withheld: false, binding: true };
  }
  switch (resolveDemoAuthorityDisplay(override)) {
    case 'hidden':
      return { authority: null, withheld: true, binding: false, detail: NON_BINDING_DETAIL };
    case 'labelled':
      return { authority, withheld: false, binding: false, detail: NON_BINDING_DETAIL };
    case 'raw':
      return { authority, withheld: false, binding: false };
  }
}
