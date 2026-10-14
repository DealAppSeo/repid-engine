/**
 * small-gain-cap.ts — a CONFIRMED small learning gain is a SMALL signal, and it is CAPPED.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHY IT IS A SEPARATE LANE FROM confirmed-outcome.ts
 * ════════════════════════════════════════════════════════════════════════════════
 * `scoring/confirmed-outcome.ts` answers "did a server-verified settler confirm this
 * outcome, and by how much does the official score move for ONE event". For a confirmed
 * RIGHT it returns a small positive `gain`. THIS module answers the next question the
 * decision raised: *how much may those small gains add up to.* It is the cap layer, not a
 * second scorer — it takes a per-event gain confirmed-outcome already computed and bounds
 * it. The two compose; neither replaces the other.
 *
 * It encodes Sean's scoring decision (strategy §v0.2.15): the confirmed small-gain path is
 * a CAP, not a ban. A small confirmed learning task moves ONLY its own domain's budget, is
 * capped per day AND per domain, and its whole-day budget sits strictly below a fraction of
 * ONE confirmed pre-committed prediction — so many small rights never outweigh one predicted
 * right, a small gain cannot cross domains, and it cannot outrun a confirmed wrong. The
 * large signal (a pre-committed-then-confirmed prediction) is NOT scored here. The
 * after-the-fact self-rating path is CLOSED here — forever, by construction, no cap opens it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * ONE FLAG, SHADOW WHILE OFF
 * ════════════════════════════════════════════════════════════════════════════════
 * This lane shares the confirmed-outcome flag — there is no second switch. The CALLER is
 * `engine/repid-update.ts::updateRepId`, inside the flag-ON confirmed-outcome branch: every
 * positive confirmed delta goes through `capSmallGain` there for the cap-only bound (closed paths,
 * domain, the per-event ceiling). The BUDGET is then spent atomically in the database, by
 * `public.claim_confirmed_gain` (engine/repid-update.ts::reserveConfirmedGain): the receipt claim
 * and the day/domain reservation happen under one row lock, so a parallel burst cannot read a
 * stale sum. Until 2026-10-14 (XC1 finding 1) the engine read today's sum, then claimed, then
 * inserted, and N parallel calls each took a full gain. The decision is recorded in the audit
 * row (`metadata.confirmed_outcome.small_gain_cap`).
 * While the flag is OFF (the default, and prod today) that branch is never entered, so this
 * module is not called and NOTHING is recorded. (Until 2026-10-14 this paragraph said an OFF
 * engine records the decision in shadow; no caller existed at all, so nothing was recorded and
 * nothing was capped.) The resolver itself is PURE apart from the flag read in `result`.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * FAIL CLOSED — "we could not read the budget" is never "the budget is free"
 * ════════════════════════════════════════════════════════════════════════════════
 * A gain is awarded ONLY against a budget we could positively read. If the per-day or
 * per-domain accumulator cannot be read (dep absent, or `checked:false`), the capped gain
 * is ZERO — not the full cap. Not-checked is not a pass. The resolver never throws into the
 * score path: any fault falls through to "no gain". A false positive move is the worst
 * outcome for a trust product, so uncertainty resolves toward no move.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * MAGNITUDES LIVE IN THE ENVIRONMENT, NOT IN THIS PUBLIC REPO
 * ════════════════════════════════════════════════════════════════════════════════
 * Every magnitude comes from an env var, exactly like `config/scoring-params.ts` and
 * `scoring/confirmed-outcome.ts`. The repo keeps the SHAPE of the policy and the structural
 * INVARIANTS between the magnitudes (which encode the decision's rules so a fat-fingered
 * deploy fails loud), and none of the tuning. Production THROWS on an unset parameter rather
 * than guessing; dev placeholders are obviously-synthetic round numbers, never the tuned
 * production magnitudes, so a value reused verbatim from here is worthless as tuning.
 */

import { confirmedOutcomeScoringEnabled, loadConfirmedParams } from './confirmed-outcome';

// ── the flag (shared with confirmed-outcome; shadow while OFF) ──────────────────────────
//
// Deliberately the SAME switch as the confirmed-outcome lane — this is the cap on that
// lane's gains, not a new feature with its own toggle. While OFF the engine never calls the cap
// (the confirmed branch is not entered). Read through the confirmed-outcome helper
// so there is exactly one definition of "is confirmed scoring armed".
export function smallGainScoringArmed(): boolean {
  return confirmedOutcomeScoringEnabled();
}

// ── the input / output ──────────────────────────────────────────────────────────────────

export interface SmallGainInput {
  /** The agent whose official score the gain would move. */
  actorAgentId: string;
  /**
   * The domain this confirmed learning task belongs to. DOMAIN ISOLATION: a gain with no
   * domain would cross domains, so a null/empty domain earns NOTHING here (reason
   * `no_domain_no_gain`). A gain only ever moves the budget of its own domain.
   */
  domain: string | null;
  /**
   * The per-event confirmed-RIGHT gain already computed by confirmed-outcome (>= 0). This
   * module caps it; it never invents a gain. A non-positive value is passed through as zero —
   * losses and holds are confirmed-outcome's job, not this module's.
   */
  computedGain: number;
  /**
   * The CLOSED path. An after-the-fact self-rating (the agent grading its own past work) is
   * self-report, which can raise nothing — ever. When true, the capped gain is ZERO
   * regardless of every cap and budget. No parameter opens this; it is shut by construction.
   */
  afterTheFactSelfRating?: boolean;
}

/** A positively-read budget line. `checked:false` means the history could not be read. */
export interface BudgetReading {
  checked: boolean;
  /** Small-gain points already applied in the window (today, or in the domain). */
  total: number;
}

export interface SmallGainDeps {
  /**
   * Sum of small-gain points ALREADY APPLIED to this agent today (the per-day budget spent).
   * Fail-closed: absent or `checked:false` ⇒ no gain (we do not know the remaining budget).
   */
  accumulatedTodaySmallGain?: (agentId: string) => Promise<BudgetReading>;
  /**
   * Sum of small-gain points ALREADY APPLIED to this agent IN THIS DOMAIN (the per-domain
   * budget spent). Fail-closed the same way, and keyed by domain so domains never share a
   * budget — the storage-level expression of "a small gain cannot cross domains".
   */
  accumulatedDomainSmallGain?: (agentId: string, domain: string) => Promise<BudgetReading>;
}

export type SmallGainReason =
  | 'self_rating_closed'
  | 'no_domain_no_gain'
  | 'no_positive_gain'
  | 'day_budget_unreadable'
  | 'domain_budget_unreadable'
  | 'capped_to_zero_budget_exhausted'
  | 'capped_by_budget'
  | 'within_caps'
  | 'resolver_error'
  /** The atomic DB reservation (claim_confirmed_gain) could not run: no gain, fail closed. */
  | 'reservation_unavailable'
  /** A domain was given, but its key is not printable ASCII after normalization: no gain. */
  | 'domain_key_refused';

/**
 * Invisible code points that render as nothing and must not make a new key. \p{Cf} covers zero-width
 * space/joiners, BOM, soft hyphen and bidi marks. The rest are NOT Cf, so they are listed (XC1 review of
 * #1369): the combining grapheme joiner U+034F and the variation selectors U+FE00–FE0F and
 * U+E0100–E01EF (category Mn), the Hangul fillers U+115F, U+1160, U+3164, U+FFA0 (category Lo), and the
 * Mongolian free variation selectors U+180B–180F.
 */
const INVISIBLE = /[\p{Cf}͏︀-️\u{E0100}-\u{E01EF}ᅟᅠㅤﾠ᠋-᠏]/gu;

/** Printable ASCII, no leading or trailing space. The same shape claim_confirmed_gain re-checks in SQL. */
const ASCII_KEY = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/;

/**
 * The per-domain budget KEY. XC1 finding 5 (2026-10-14): the key was only trimmed, so `Law`,
 * `law`, `l<ZWSP>aw` and fullwidth `ｌａｗ` were four separate per-domain budgets for one domain.
 *
 * NFKC (folds fullwidth and compatibility forms), strip INVISIBLE, collapse whitespace, trim,
 * lower-case. Then the key must be PRINTABLE ASCII, or it is refused (null, which earns no gain).
 *
 * WHY ASCII-ONLY rather than a script-mixing rule (XC1 review of #1369). Cyrillic `а` in `lаw` is a
 * new key that NFKC does not fold. A mixed-script refusal closes that one, but not a WHOLE-script
 * look-alike (`ѕсоре` in Cyrillic beside `scope`), and a confusables skeleton (UTS #39) needs a data
 * table this repo does not carry. ASCII-only closes every homoglyph mint with one regex. The cost is
 * stated: a domain named in a non-Latin script, `straße` (ß survives lower-casing) or `İ` (which
 * lower-cases to i + U+0307) earns NO confirmed small gain until a skeleton map is built. That is
 * the fail-closed direction.
 *
 * ACCEPTED NFKC MERGES (one budget for two spellings, on purpose; each is a compatibility form of
 * the same text): `ﬁle`→`file`, `m²`→`m2`, Roman `Ⅰ`→`i`, circled `Ⓐ`→`a`, Kelvin `K`→`k`. The Greek
 * results of NFKC (ohm `Ω`→`ω`, micro `µ`→`μ`) are not ASCII, so they are refused, not merged.
 */
export function normalizeCapDomain(domain: unknown): string | null {
  if (typeof domain !== 'string') return null;
  const key = domain.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return ASCII_KEY.test(key) ? key : null;
}

export interface SmallGainCapResult {
  /** The gain after every cap, >= 0. This is what the engine would move the score by WHEN ARMED. */
  cappedGain: number;
  /** True only when cappedGain > 0 AND the lane is armed. Shadow (armed=false) always yields false. */
  wouldMoveScore: boolean;
  /** The lane flag at resolve time. False ⇒ shadow: record the decision, move the score by zero. */
  armed: boolean;
  reason: SmallGainReason;
  detail: {
    domain: string | null;
    computedGain: number;
    afterTheFactSelfRating: boolean;
    /** Remaining per-day budget read (null when not reached / unreadable). */
    perDayRemaining: number | null;
    /** Remaining per-domain budget read (null when not reached / unreadable). */
    perDomainRemaining: number | null;
    dayBudgetChecked: boolean;
    domainBudgetChecked: boolean;
  };
}

// ── parameters (env-sourced; magnitudes never live in this public repo) ──────────────────

export interface SmallGainCapParams {
  /** Max cumulative small gain an agent may earn across ALL domains in a day. */
  perDayCap: number;
  /** Max cumulative small gain an agent may earn WITHIN ONE domain (<= perDayCap). */
  perDomainCap: number;
  /**
   * The magnitude of ONE confirmed pre-committed prediction's score move — the LARGE signal.
   * The caps are measured against this; it is the reference, not something this module awards
   * (predictions are scored elsewhere, flag-gated, and are not in scope here).
   */
  predictionReferenceGain: number;
  /** In (0,1): the whole-day small-gain budget must sit at or below this fraction of one prediction. */
  ceilingFractionOfPrediction: number;
}

interface Spec {
  env: string;
  min: number;
  max: number;
  dev: number;
}

/**
 * The parameter table. Env names are the SOURCE OF TRUTH; the DEV values are deliberately
 * round, obviously-synthetic placeholders — never the tuned production magnitudes — so a test
 * that leans on them fails loudly rather than passing for the wrong reason. The dev set is
 * chosen to SATISFY the invariants below against confirmed-outcome's own dev placeholders
 * (gainBase dev 5, lossBase dev -15), so a fresh clone boots; it is not a reference for tuning.
 */
const PARAMS: Record<keyof SmallGainCapParams, Spec> = {
  perDayCap: { env: 'REPID_SMALL_GAIN_PER_DAY_CAP', min: 0, max: 10000, dev: 12 },
  perDomainCap: { env: 'REPID_SMALL_GAIN_PER_DOMAIN_CAP', min: 0, max: 10000, dev: 8 },
  predictionReferenceGain: { env: 'REPID_SMALL_GAIN_PREDICTION_REFERENCE', min: 0, max: 10000, dev: 200 },
  ceilingFractionOfPrediction: { env: 'REPID_SMALL_GAIN_CEILING_FRACTION', min: 0, max: 1, dev: 0.2 },
};

/** Every env var this module requires in production — for the deploy checklist. */
export const REQUIRED_SMALL_GAIN_ENV: string[] = Object.values(PARAMS).map((p) => p.env).sort();

function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV ?? '').toLowerCase() === 'production';
}

/**
 * Literal reads (one per var) so `scripts/generate-env-registry.mjs` can capture each name
 * and `check:named-env-vars` treats it as a real control. A dynamic `env[spec.env]` would
 * read the same value but leave the name undiscovered — the exact idiom confirmed-outcome uses.
 */
function rawOf(key: keyof SmallGainCapParams, env: NodeJS.ProcessEnv): string | undefined {
  switch (key) {
    case 'perDayCap': return env['REPID_SMALL_GAIN_PER_DAY_CAP'];
    case 'perDomainCap': return env['REPID_SMALL_GAIN_PER_DOMAIN_CAP'];
    case 'predictionReferenceGain': return env['REPID_SMALL_GAIN_PREDICTION_REFERENCE'];
    case 'ceilingFractionOfPrediction': return env['REPID_SMALL_GAIN_CEILING_FRACTION'];
  }
}

function readOne(key: keyof SmallGainCapParams, env: NodeJS.ProcessEnv, missing: string[]): number {
  const spec = PARAMS[key];
  const raw = rawOf(key, env);
  if (raw === undefined || raw.trim() === '') {
    if (isProduction(env)) {
      missing.push(spec.env);
      return NaN;
    }
    return spec.dev;
  }
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < spec.min || n > spec.max) {
    // An out-of-range value is refused in EVERY environment — a typo must never become a
    // live cap magnitude silently.
    throw new Error(
      `[small-gain-cap] ${spec.env}='${raw}' is not a finite number within ` +
        `[${spec.min}, ${spec.max}]. Refusing to cap against an incoherent magnitude.`,
    );
  }
  return n;
}

/**
 * Resolve every magnitude and enforce the structural INVARIANTS that make the decision's
 * rules true BY CONSTRUCTION — a deploy whose magnitudes violate them fails loud here rather
 * than letting small gains silently outweigh a prediction or a confirmed wrong. The
 * confirmed-outcome magnitudes `gainBase` (one small right) and `lossBase` (one confirmed
 * wrong) are read for the cross-lane invariants, so the two lanes cannot be tuned into
 * disagreement. (LESSONS: when a machine-checked invariant rejects your design, fix the
 * design, not the checker.)
 */
export function loadSmallGainCapParams(env: NodeJS.ProcessEnv = process.env): SmallGainCapParams {
  const missing: string[] = [];
  const out = {} as SmallGainCapParams;
  for (const key of Object.keys(PARAMS) as Array<keyof SmallGainCapParams>) {
    out[key] = readOne(key, env, missing);
  }
  if (missing.length > 0) {
    throw new Error(
      `[small-gain-cap] REFUSING TO CAP: ${missing.length} magnitude(s) are unset in production — ` +
        `${missing.join(', ')}. These are deliberately not committed (the repository is public); ` +
        `set them on the repid-engine service before arming CONFIRMED_OUTCOME_SCORING_ENABLED.`,
    );
  }

  // The confirmed-outcome lane owns "one small right" (gainBase) and "one confirmed wrong"
  // (lossBase); read them so the caps are provably below a prediction and below a wrong.
  const confirmed = loadConfirmedParams(env);
  const oneSmallRight = confirmed.gainBase;
  const oneConfirmedWrong = Math.abs(confirmed.lossBase);

  if (!(out.perDayCap > 0) || !(out.perDomainCap > 0)) {
    throw new Error(
      `[small-gain-cap] REPID_SMALL_GAIN_PER_DAY_CAP (${out.perDayCap}) and ` +
        `REPID_SMALL_GAIN_PER_DOMAIN_CAP (${out.perDomainCap}) must both be > 0 — a cap of zero is a ban, ` +
        `and the decision is a cap, not a ban.`,
    );
  }
  // A single domain cannot earn more than the whole day — otherwise "per day" is not a cap.
  if (out.perDomainCap > out.perDayCap) {
    throw new Error(
      `[small-gain-cap] REPID_SMALL_GAIN_PER_DOMAIN_CAP (${out.perDomainCap}) must be <= ` +
        `REPID_SMALL_GAIN_PER_DAY_CAP (${out.perDayCap}) — one domain cannot earn more than a whole day.`,
    );
  }
  if (!(out.ceilingFractionOfPrediction > 0 && out.ceilingFractionOfPrediction < 1)) {
    throw new Error(
      `[small-gain-cap] REPID_SMALL_GAIN_CEILING_FRACTION (${out.ceilingFractionOfPrediction}) must be ` +
        `strictly between 0 and 1 — the caps sit BELOW a fraction of one prediction, not at or above it.`,
    );
  }
  // RULE — ten small rights < one predicted right. The prediction (the large signal) must be
  // strictly more than ten of the confirmed small rights it is measured against.
  if (!(10 * oneSmallRight < out.predictionReferenceGain)) {
    throw new Error(
      `[small-gain-cap] REPID_SMALL_GAIN_PREDICTION_REFERENCE (${out.predictionReferenceGain}) must exceed ` +
        `10 x one confirmed small right (${10 * oneSmallRight}) — ten small rights must not outweigh one predicted right.`,
    );
  }
  // RULE — capped below a fraction of ONE confirmed pre-committed prediction. The whole-day
  // small-gain budget (and therefore the per-domain budget, which is <= it) is at or below a
  // fraction of one prediction's magnitude.
  if (out.perDayCap > out.ceilingFractionOfPrediction * out.predictionReferenceGain) {
    throw new Error(
      `[small-gain-cap] REPID_SMALL_GAIN_PER_DAY_CAP (${out.perDayCap}) must be <= ` +
        `REPID_SMALL_GAIN_CEILING_FRACTION x REPID_SMALL_GAIN_PREDICTION_REFERENCE ` +
        `(${out.ceilingFractionOfPrediction * out.predictionReferenceGain}) — the day's small-gain budget must ` +
        `sit below a fraction of one confirmed pre-committed prediction.`,
    );
  }
  // RULE — cannot outrun a confirmed wrong. A full day of small rights adds strictly less than
  // one confirmed wrong removes, so no amount of small rights can out-earn a single wrong.
  if (!(out.perDayCap < oneConfirmedWrong)) {
    throw new Error(
      `[small-gain-cap] REPID_SMALL_GAIN_PER_DAY_CAP (${out.perDayCap}) must be < |one confirmed wrong| ` +
        `(${oneConfirmedWrong}) — a day of small rights cannot outrun a single confirmed wrong.`,
    );
  }
  return out;
}

let cached: SmallGainCapParams | null = null;

/** Resolved once per process (deploy-time config, not per-event input). */
export function smallGainCapParams(): SmallGainCapParams {
  if (cached === null) cached = loadSmallGainCapParams();
  return cached;
}

/** Test seam only. */
export function __resetSmallGainCapParamsCache(): void {
  cached = null;
}

// ── the resolver (pure; never throws into the score path) ────────────────────────────────

function result(
  cappedGain: number,
  reason: SmallGainReason,
  detail: SmallGainCapResult['detail'],
): SmallGainCapResult {
  const armed = smallGainScoringArmed();
  return {
    cappedGain,
    wouldMoveScore: armed && cappedGain > 0,
    armed,
    reason,
    detail,
  };
}

/**
 * Cap a confirmed small learning gain. Pure over its inputs and the injected budget readers
 * (the flag is the only ambient read, isolated in `result`/`smallGainScoringArmed`). Returns a
 * fully-recordable decision. The engine calls it only from the flag-ON branch (so `armed` is true
 * there), applies `cappedGain`, and records the decision in the audit row.
 */
export async function capSmallGain(
  input: SmallGainInput,
  deps: SmallGainDeps = {},
): Promise<SmallGainCapResult> {
  const normalizedDomain = normalizeCapDomain(input.domain);
  const base: SmallGainCapResult['detail'] = {
    domain: normalizedDomain,
    computedGain: input.computedGain,
    afterTheFactSelfRating: input.afterTheFactSelfRating === true,
    perDayRemaining: null,
    perDomainRemaining: null,
    dayBudgetChecked: false,
    domainBudgetChecked: false,
  };

  try {
    // CLOSED PATH — an after-the-fact self-rating raises nothing, ever. Checked first so no
    // cap, budget, or domain can ever let it through.
    if (input.afterTheFactSelfRating === true) {
      return result(0, 'self_rating_closed', base);
    }

    // DOMAIN ISOLATION — a gain with no domain would cross domains; it earns nothing.
    const domain = normalizedDomain;
    if (domain === null) {
      const given = typeof input.domain === 'string' && input.domain.normalize('NFKC').replace(INVISIBLE, '').trim() !== '';
      return result(0, given ? 'domain_key_refused' : 'no_domain_no_gain', base);
    }

    // Only a positive confirmed gain is this module's business.
    if (!(Number.isFinite(input.computedGain) && input.computedGain > 0)) {
      return result(0, 'no_positive_gain', base);
    }

    const p = smallGainCapParams();

    // PER-DAY budget — fail closed if we cannot positively read it.
    if (!deps.accumulatedTodaySmallGain) {
      return result(0, 'day_budget_unreadable', base);
    }
    const day = await deps.accumulatedTodaySmallGain(input.actorAgentId);
    if (!day.checked) {
      return result(0, 'day_budget_unreadable', { ...base, dayBudgetChecked: false });
    }
    const perDayRemaining = Math.max(0, p.perDayCap - Math.max(0, day.total));

    // PER-DOMAIN budget — keyed by domain, so domains never share a budget. Fail closed.
    if (!deps.accumulatedDomainSmallGain) {
      return result(0, 'domain_budget_unreadable', {
        ...base,
        dayBudgetChecked: true,
        perDayRemaining,
      });
    }
    const dom = await deps.accumulatedDomainSmallGain(input.actorAgentId, domain);
    if (!dom.checked) {
      return result(0, 'domain_budget_unreadable', {
        ...base,
        dayBudgetChecked: true,
        perDayRemaining,
        domainBudgetChecked: false,
      });
    }
    const perDomainRemaining = Math.max(0, p.perDomainCap - Math.max(0, dom.total));

    const detail: SmallGainCapResult['detail'] = {
      ...base,
      dayBudgetChecked: true,
      domainBudgetChecked: true,
      perDayRemaining,
      perDomainRemaining,
    };

    // The capped gain is the event's gain, bounded by BOTH remaining budgets. Integer, >= 0.
    const cappedGain = Math.max(0, Math.round(Math.min(input.computedGain, perDayRemaining, perDomainRemaining)));

    if (cappedGain === 0) return result(0, 'capped_to_zero_budget_exhausted', detail);
    if (cappedGain < input.computedGain) return result(cappedGain, 'capped_by_budget', detail);
    return result(cappedGain, 'within_caps', detail);
  } catch {
    // Never throw into the score path — a fault is "no gain", the safe direction.
    return result(0, 'resolver_error', { ...base, perDayRemaining: null, perDomainRemaining: null });
  }
}
