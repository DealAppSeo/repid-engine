/**
 * model-selection.ts — choose a model from what the vendor ACTUALLY offers, ranked to buy the most
 * quorum independence per call.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE CONTRACT, AND WHY IT IS A FALLBACK RATHER THAN A REPLACEMENT
 * ════════════════════════════════════════════════════════════════════════════════
 * A pinned model id is not bureaucracy — `src/hal/measurement-ruler.ts` and CLAUDE_RULES 24 rest on
 * it. HAL's frozen accuracy claims were measured at a fixed configuration, and a model that changes
 * underneath them turns every later comparison into a measurement without its ruler. Automatic
 * selection, done naively, destroys exactly that property.
 *
 * So the order is: PIN WHEN YOU CAN, HEAL WHEN YOU CANNOT, AND ALWAYS SAY WHICH HAPPENED.
 *
 *   1. operator   HAL_S2_<X>_MODEL is set and nothing has measured it dead   → use it, untouched.
 *   2. static     the shipped default is present in the live catalog          → use it, untouched.
 *   3. catalog    neither is usable → pick the best REACHABLE model and SAY SO loudly.
 *   4. none       nothing reachable → return no model; the caller skips the provider and reports it.
 *
 * Steps 1 and 2 are the normal path and are byte-identical to today's behaviour. Step 3 only fires
 * when the alternative is a provider that contributes nothing — which is not a stable ruler either,
 * it is a silent hole. A substituted model is reported in `reason` and travels with the verdict, so
 * a measurement taken during a substitution can never be mistaken for one taken at the pinned
 * configuration.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY RANKING IS BY CAPABILITY KEYWORDS AND NOT BY MODEL ID
 * ════════════════════════════════════════════════════════════════════════════════
 * A list of preferred model ids is the thing that keeps dying. A list of keywords about what a
 * model IS does not: `embedding`, `whisper`, `guard` and `flash` mean the same thing in 2027 as in
 * 2026, whatever ids exist by then. Every rule below is keyed on what the model does, never on
 * which model it is, so this file should not need editing when a vendor retires something.
 *
 * PURE — no network, no DB, no env, no imports from the quorum builder. Family resolution is passed
 * IN (fact-check owns the registry-primary resolver and importing it here would create a cycle),
 * which also makes every rule below directly testable.
 */

/** A model id that cannot serve a chat completion. Calling one is a guaranteed 400/404. */
const NOT_A_CHAT_MODEL =
  /embed|embedding|whisper|tts|text-to-speech|speech|audio|transcribe|rerank|moderation|guard|safety|ocr|image|vision-only|dall|imagen|veo|sora|clip|bge-|e5-|nomic|codestral-embed|voxtral/i;

/**
 * Cheap and fast, which is what a one-line JSON verdict needs.
 *
 * MEASURED on this system's own ledger (2026-08-10 → 17), median latency and completion tokens per
 * fact-check call: groq 251ms/203tok, openrouter 256ms/174, deepseek 326ms/165, mistral 627ms/187,
 * gemini 1552ms/411 — and cerebras, running a REASONING model, 1442ms/640. Nearly 6x the latency
 * and 3x the tokens of the fastest member, to emit the same three-field JSON. A reasoning model is
 * the wrong tool for this call, so its tokens are ranked down rather than up.
 */
const FAST_CHEAP = /instant|flash|mini|small|lite|turbo|nano|scout|haiku|\b\d{1,2}b\b/i;

/** Slow and expensive for a verdict: chain-of-thought models and very large checkpoints. */
const SLOW_EXPENSIVE = /thinking|reasoning|-r1|deep-?research|opus|\b(?:2\d{2}|[3-9]\d{2})b\b|\b\d{3,}b\b/i;

/** Not something to route production traffic to on its own initiative. */
const UNSTABLE = /preview|experimental|\bexp\b|alpha|\bbeta\b|nightly|-rc\d|deprecated/i;

/**
 * Free-tier slugs. Deprioritised on MEASURED grounds, not principle: fact-check.ts records that
 * OpenRouter `:free` variants "429 hard under any load", which defeats a quorum member whose entire
 * job is to answer when the paid tiers are throttling. A voter that vanishes under load is worse
 * than a cheap one that does not.
 */
const FREE_TIER = /:free$/i;

export type ModelSource = 'operator' | 'static' | 'catalog' | 'none';

export interface ModelChoice {
  /** The id to call, or null when nothing is reachable and the provider must be skipped. */
  model: string | null;
  source: ModelSource;
  /** Human-readable, and it travels into provider_health so a substitution is never silent. */
  reason: string;
  /** True when this differs from what the operator or the shipped default asked for. */
  substituted: boolean;
}

export interface SelectionInput {
  provider: string;
  /** HAL_S2_<X>_MODEL, if set. Highest precedence — the operator always keeps the last word. */
  operatorModel?: string | undefined;
  /** The id this build ships as its default, if it still has one. */
  staticModel?: string | undefined;
  /** Model ids the vendor says this key can reach. Empty ⇒ the catalog measured nothing. */
  catalogModels: string[];
  /** True only when the vendor was actually asked and answered. Empty-because-unasked ≠ empty. */
  catalogMeasured: boolean;
  /** Ledger verdict per model id, from dead-model-evidence. UNKNOWN must never exclude. */
  isMeasuredDead: (model: string) => boolean;
  /** Static backstop list, consulted ONLY where the ledger has no opinion. */
  isStaticallyRetired: (model: string) => boolean;
  /** Families already covered by other quorum members — a model adding a new one is worth more. */
  familiesTaken: ReadonlySet<string>;
  /** Registry-primary resolver, injected to avoid a cycle with fact-check.ts. */
  familyOf: (model: string) => string;
}

/**
 * Score a candidate. Higher is better; the family bonus dominates every other term ON PURPOSE.
 *
 * The quorum's whole claim is cross-examination across INDEPENDENT families, and
 * `MIN_QUORUM_FOR_VETO` is 2 — so the marginal value of a model that adds a family the panel does
 * not yet have is categorically larger than the value of one that is slightly faster inside a
 * family already represented. A second voter in a covered family buys latency, not independence.
 */
export function scoreCandidate(
  model: string,
  familiesTaken: ReadonlySet<string>,
  familyOf: (m: string) => string,
): number {
  let s = 0;
  if (!familiesTaken.has(familyOf(model))) s += 1000; // a NEW independent vote — the thing being bought
  if (FAST_CHEAP.test(model)) s += 40;
  if (SLOW_EXPENSIVE.test(model)) s -= 60;
  if (UNSTABLE.test(model)) s -= 80;
  if (FREE_TIER.test(model)) s -= 30;
  // Shorter ids skew toward a vendor's plain flagship (`mistral-small-latest`) over its long-tail
  // dated or specialised variants. A weak signal, and weighted like one — it only ever breaks ties.
  s -= Math.min(20, model.length / 5);
  return s;
}

/** Candidates that could serve a chat verdict at all, after every hard exclusion. */
export function eligibleCandidates(input: SelectionInput): string[] {
  return input.catalogModels.filter((m) => {
    if (NOT_A_CHAT_MODEL.test(m)) return false;
    // THE LEDGER OUTRANKS THE STATIC LIST, and this ordering is the un-learn path. The static list
    // is our belief about a vendor; the ledger is a measurement of the credential actually in use.
    // When a new key CAN reach a model the old key could not, one success makes it LIVE and it is
    // eligible again immediately — no PR to delete a row, which is the failure the ledger module
    // was written to end.
    if (input.isMeasuredDead(m)) return false;
    if (input.isStaticallyRetired(m)) return false;
    return true;
  });
}

/**
 * Choose this provider's model. Never throws; the worst case is `{model: null, source: 'none'}`,
 * which the caller reports as a skip rather than turning into a failed call.
 */
export function selectModel(input: SelectionInput): ModelChoice {
  const { provider, operatorModel, staticModel, catalogModels, catalogMeasured } = input;

  // ── 1. OPERATOR ─────────────────────────────────────────────────────────────────────────────
  // An explicit override wins unless the LEDGER — not the static list — says it is dead. The
  // operator may legitimately know something we do not: a new key, a new org, an early-access
  // grant. Only our own measurement of the credential in use may overrule them, and even then the
  // reason names the flag that forces it back.
  const op = operatorModel?.trim();
  if (op) {
    if (!input.isMeasuredDead(op)) {
      const unlisted =
        catalogMeasured && catalogModels.length > 0 && !catalogModels.includes(op)
          ? ` (not in this key's model list — calling it anyway because you asked for it)`
          : '';
      return { model: op, source: 'operator', reason: `configured HAL_S2_${provider.toUpperCase()}_MODEL${unlisted}`, substituted: false };
    }
    // Fall through to substitution, and say exactly why below.
  }

  // ── 2. STATIC DEFAULT ───────────────────────────────────────────────────────────────────────
  // Keep the pin whenever it still works. This is the branch that preserves the measurement ruler.
  const st = staticModel?.trim();
  if (st && !input.isMeasuredDead(st) && !input.isStaticallyRetired(st)) {
    if (!catalogMeasured || catalogModels.includes(st)) {
      return { model: st, source: 'static', reason: 'shipped default', substituted: false };
    }
  }

  // ── 3. CATALOG ──────────────────────────────────────────────────────────────────────────────
  // Only reachable here when the pin is unusable. Without a measured catalog there is nothing to
  // choose FROM, and inventing an id from anywhere else is precisely what produced a dead default
  // twice — so this returns nothing rather than guessing.
  if (!catalogMeasured) {
    return {
      model: st ?? op ?? null,
      source: st || op ? 'static' : 'none',
      reason:
        st || op
          ? 'catalog NOT_CHECKED — keeping the configured model, unverified'
          : `catalog NOT_CHECKED and no model configured — nothing to call`,
      substituted: false,
    };
  }

  const eligible = eligibleCandidates(input);
  if (eligible.length === 0) {
    return {
      model: null,
      source: 'none',
      reason:
        `no reachable chat model: this key lists ${catalogModels.length} model(s), none of which ` +
        `survived exclusion (non-chat, measured-dead, or retired)`,
      substituted: true,
    };
  }

  const best = eligible
    .map((m) => ({ m, s: scoreCandidate(m, input.familiesTaken, input.familyOf) }))
    .sort((a, b) => b.s - a.s || a.m.localeCompare(b.m))[0]!.m;

  const asked = op || st;
  const why = op && input.isMeasuredDead(op)
    ? `configured model '${op}' has been MEASURED dead on this credential`
    : st
      ? `shipped default '${st}' is not reachable on this key`
      : 'no model was configured';

  return {
    model: best,
    source: 'catalog',
    reason:
      `${why} — selected '${best}' from this key's live model list ` +
      `(family '${input.familyOf(best)}'${input.familiesTaken.has(input.familyOf(best)) ? '' : ', new to this quorum'})`,
    substituted: best !== asked,
  };
}
