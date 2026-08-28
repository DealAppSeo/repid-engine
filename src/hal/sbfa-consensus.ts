/**
 * SBFA v0.2 — Symphonic Belief Fusion / Contention-and-Deferral consensus.
 *
 * Source of truth: E:\dev\living-docs\04_security\SBFA_CONTENTION_AND_DEFERRAL_v0.2.md
 * (LOCKED for build — 4-model blind cross-review converged: Claude/Grok/ChatGPT/Gemini).
 * This module is the CC half of the §7 build handoff:
 *   - weighted-supermajority + abstain/escalate in SBFA-BFT consensus  (§2.1, §2.2, §2.3)
 *   - deadlock → contested_bft escalation                              (§2.4)
 *   - chronic-near-deadlock accumulator                               (§5)
 *   - expose belief / ignorance / confidence in the verdict event     (§7 CC)
 *
 * DESIGN INVARIANTS (do not violate without re-reading the spec):
 *  1. A contested or tied vote NEVER forces an irreversible action (§1). Deadlock is an
 *     uncertainty SIGNAL, not a coin flip → safe default (low stakes) or escalate (high stakes).
 *  2. ANTI-REFLEXIVITY (§2.1 hard rule, §5): reliability weights MUST come from an injected
 *     independent oracle (verified outcomes / human samples), NEVER from this consensus's own
 *     output. That is why the oracle is a constructor parameter and this module computes nothing
 *     about validator reliability itself.
 *  3. Ignorance is represented EXPLICITLY using Dempster-Shafer with the YAGER rule (§2.3) — conflict
 *     is reassigned to the uncertain frame, never renormalized away (classic Dempster → Zadeh paradox).
 *  4. Protective (reversible safety-hold) and punitive (irreversible slash) get DIFFERENT bars (§1).
 *
 * This module is PURE (no I/O, no DB, no env reads). The DB/seam wiring lives in the oracle
 * implementation and the (separately flag-gated) shadow hook. Changing the live veto decision with
 * this module requires the A6 co-sign with GA (§7) — this file only provides the mechanism.
 */

export type StakesLevel = 'low' | 'medium' | 'high' | 'irreversible';

/** §1 [GPT] separate protective (reversible safety-hold) from punitive (irreversible slash). */
export type ActionKind = 'protective' | 'punitive';

export type SbfaDecision = 'act' | 'hold' | 'abstain' | 'escalate';

/** One validator's vote on whether the action (e.g. veto/slash) is warranted. */
export interface ValidatorVote {
  /** Validator identity (provider or agent name). */
  validator: string;
  /**
   * §2.1 [Gem] PER-VERSION, not per-family: the exact pinned model version the vote came from.
   * Provider stealth-updates invalidate name-keyed weights, so reliability is indexed to this.
   */
  modelVersion: string;
  /** Belief in [0,1] that the action IS warranted (e.g. that the claim is FALSE / a violation). */
  belief: number;
  /** Stated confidence in [0,1]. */
  confidence: number;
  /**
   * Independence family (e.g. 'llama', 'gemini'). Used for the §5 correlated-failure heuristic:
   * "6-0 from similar models" is weaker than "4-2 across genuinely different evidence paths".
   */
  familyKey?: string;
}

/** Beta(α,β) posterior over a validator's correctness against VERIFIED outcomes (§2.1). */
export interface ReliabilityWeight {
  alpha: number;
  beta: number;
}

/**
 * §2.1 / §5 anti-reflexivity boundary. An implementation MUST derive weights from an out-of-band
 * source of truth (gold labels, human-verified outcomes) — NEVER from this system's own consensus
 * scores (e.g. hal_score, which is downstream of this very decision). Keyed to (validator,
 * modelVersion, category) so weights are per-pinned-version + per-decision-category.
 */
export interface ReliabilityOracle {
  getWeight(validator: string, modelVersion: string, category: string): ReliabilityWeight;
  /** Human-readable provenance of the weights — surfaced in the verdict for auditability. */
  readonly source: string;
}

export interface SbfaInput {
  votes: ValidatorVote[];
  /** Risk tier — scales the supermajority bar (§2.2). */
  stakes: StakesLevel;
  /** §1 — reversible hold (low bar) vs irreversible slash (high asymmetric bar). */
  action: ActionKind;
  /** Decision category (e.g. 'math', 'factual') for per-category reliability weights (§2.1). */
  category: string;
  /** Injected independent reliability oracle (§2.1 hard rule). */
  oracle: ReliabilityOracle;
  /** Prior chronic-near-deadlock count for this subject (§5 accumulator). Default 0. */
  nearDeadlockCount?: number;
}

/** GLASS BOX — per-validator evidence contribution (what each model added to the decision). */
export interface SbfaVoteTrace {
  validator: string;
  modelVersion: string;
  family?: string;
  belief: number; // P(action warranted) this validator asserted
  confidence: number; // 0..1 stated confidence
  reliability_mean: number; // oracle Beta mean — the earned weight
  reliability_alpha: number;
  reliability_beta: number;
  trust: number; // confidence × reliability — the Shafer discount applied
  contributes_act: number; // this vote's own discounted DST mass toward {act}
  contributes_not: number;
  contributes_ignorance: number;
}

/** GLASS BOX — the full structured, human-readable decision trace (the differentiator made visible). */
export interface SbfaTrace {
  votes: SbfaVoteTrace[];
  fused: { belief_act: number; belief_not: number; ignorance_mass: number };
  weighted_agreement: number;
  act_threshold: number;
  ignorance_cap: number;
  min_confidence: number;
  stakes: StakesLevel;
  action: ActionKind;
  reliability_source: string;
  flags: { correlated_warning: boolean; comma_conservative: boolean; near_deadlock_triggered: boolean };
  /** One human-readable line per step: who voted, weights, quorum math, why act/defer/pass. */
  lines: string[];
}

export interface SbfaVerdict {
  decision: SbfaDecision;
  /** Dempster-Shafer (Yager) masses over the frame {act}, {¬act}, {uncertain}. Sum to 1. */
  belief_act: number;
  belief_not: number;
  ignorance_mass: number;
  /** Aggregate confidence = decisive mass (1 − ignorance), in [0,1]. */
  confidence: number;
  /** §2.2 one-sidedness of the DECISIVE mass: belief_act / (belief_act + belief_not). */
  weighted_agreement: number;
  /** The risk-scaled supermajority bar that was applied (§2.2). */
  act_threshold: number;
  /** §2.4 escalation target when the panel defers. */
  escalate_to: 'contested_bft' | null;
  /** §5 accumulator: running count after this decision, and whether it crossed the chronic bar. */
  near_deadlock_count: number;
  near_deadlock_triggered: boolean;
  /** §5 correlated/common-mode warning (one-sided panel with too few independent families). */
  correlated_warning: boolean;
  /** §2.3 / P-003: a tight consistent split at high belief = coordinated dissonance. */
  comma_conservative: boolean;
  reliability_source: string;
  reason: string;
  /** GLASS BOX decision trace — always present (cheap, pure). Surfaced in the verdict event + HITL PWA. */
  trace: SbfaTrace;
}

/** Risk-scaled supermajority bars (§2.2). Punitive raises the bar; protective lowers it (§1). */
const ACT_BAR: Record<StakesLevel, number> = {
  low: 0.6,
  medium: 0.67,
  high: 0.8,
  irreversible: 0.9, // near-unanimity
};

/** Ignorance ceiling above which we never ACT — the panel is too unsure (§2.3). */
const IGNORANCE_CAP: Record<StakesLevel, number> = {
  low: 0.5,
  medium: 0.45,
  high: 0.35,
  irreversible: 0.25,
};

/** Below this decisive-mass confidence, an irreversible action may not fire (§2.2 "+ high aggregate confidence"). */
const MIN_CONFIDENCE_TO_ACT: Record<StakesLevel, number> = {
  low: 0.4,
  medium: 0.5,
  high: 0.6,
  irreversible: 0.7,
};

/**
 * Protective holds fire on a deliberately low bar (§1 "reversible containment, never punishment").
 * Keyed on the DIRECTIONAL lean of the decisive mass (weighted_agreement), not the absolute belief
 * mass — DST discounting shrinks absolute mass, but a reversible safety-hold should still trigger on
 * a weak lean toward action. A confidence floor stops pure-ignorance from manufacturing a hold.
 */
const PROTECTIVE_HOLD_AGREEMENT = 0.55;
const PROTECTIVE_MIN_CONFIDENCE = 0.2;

/** P-003 comma gap (the Pythagorean-Comma critical band): tight split (< this) at high belief. */
const COMMA_GAP = 531441 / 524288 - 1; // ≈ 0.013643
const COMMA_HIGH_BELIEF = 0.85;

/** §5 ambiguity band around 0.5 weighted-agreement; landing here repeatedly is itself a signal. */
const NEAR_DEADLOCK_BAND = 0.1;
const CHRONIC_NEAR_DEADLOCK_THRESHOLD = 4;

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Yager combination of two binary-frame bpa's. Frame Θ = {act, ¬act}; masses are
 * [m({act}), m({¬act}), m(Θ)]. Conflict K (would-be ∅) is moved to Θ — NOT renormalized
 * (§2.3: classic Dempster's 1/(1−K) renormalization is the Zadeh paradox we must avoid).
 */
function yagerCombine(
  a: [number, number, number],
  b: [number, number, number]
): [number, number, number] {
  const [aA, aN, aT] = a;
  const [bA, bN, bT] = b;
  const mAct = aA * bA + aA * bT + aT * bA;
  const mNot = aN * bN + aN * bT + aT * bN;
  const conflict = aA * bN + aN * bA; // K → reassigned to ignorance (Yager)
  const mTheta = aT * bT + conflict;
  return [mAct, mNot, mTheta];
}

/**
 * Map one vote to a discounted bpa. Shafer discounting: the source is trusted to degree
 * (confidence × reliability_mean); the remaining mass goes to ignorance (Θ). A low-confidence OR
 * low-reliability vote therefore contributes mostly ignorance, not a decisive opinion.
 */
function voteToBpa(belief: number, confidence: number, reliabilityMean: number): [number, number, number] {
  const trust = clamp01(confidence) * clamp01(reliabilityMean);
  const b = clamp01(belief);
  const mAct = b * trust;
  const mNot = (1 - b) * trust;
  const mTheta = 1 - trust;
  return [mAct, mNot, mTheta];
}

/**
 * The SBFA v0.2 consensus. Pure function: given votes + an independent reliability oracle, returns a
 * defer-by-default verdict with explicit ignorance. NEVER forces an irreversible action on a tie.
 */
export function sbfaConsensus(input: SbfaInput): SbfaVerdict {
  const { votes, stakes, action, category, oracle } = input;
  const priorCount = Math.max(0, Math.floor(input.nearDeadlockCount ?? 0));

  // --- Degenerate cases: no votes → maximal ignorance → defer. ---
  if (!votes || votes.length === 0) {
    return {
      decision: stakes === 'low' ? 'abstain' : 'escalate',
      belief_act: 0,
      belief_not: 0,
      ignorance_mass: 1,
      confidence: 0,
      weighted_agreement: 0.5,
      act_threshold: ACT_BAR[stakes],
      escalate_to: stakes === 'low' ? null : 'contested_bft',
      near_deadlock_count: priorCount, // no decision landed → unchanged
      near_deadlock_triggered: false,
      correlated_warning: false,
      comma_conservative: false,
      reliability_source: oracle.source,
      reason: 'No validator votes — maximal ignorance, deferring.',
      trace: {
        votes: [],
        fused: { belief_act: 0, belief_not: 0, ignorance_mass: 1 },
        weighted_agreement: 0.5,
        act_threshold: ACT_BAR[stakes],
        ignorance_cap: IGNORANCE_CAP[stakes],
        min_confidence: MIN_CONFIDENCE_TO_ACT[stakes],
        stakes,
        action,
        reliability_source: oracle.source,
        flags: { correlated_warning: false, comma_conservative: false, near_deadlock_triggered: false },
        lines: ['No validator responded — the panel has nothing to weigh. Maximal ignorance → defer.'],
      },
    };
  }

  // --- 1. Reliability-weighted DST fusion (§2.1 + §2.3). ---
  let mass: [number, number, number] = [0, 0, 1]; // vacuous: all ignorance
  const beliefs: number[] = [];
  const families = new Set<string>();
  const voteTraces: SbfaVoteTrace[] = [];
  for (const v of votes) {
    const w = oracle.getWeight(v.validator, v.modelVersion, category);
    const denom = w.alpha + w.beta;
    const reliabilityMean = denom > 0 ? w.alpha / denom : 0.5;
    const bpa = voteToBpa(v.belief, v.confidence, reliabilityMean); // this vote's OWN discounted evidence
    mass = yagerCombine(mass, bpa);
    beliefs.push(clamp01(v.belief));
    if (v.familyKey) families.add(v.familyKey);
    voteTraces.push({
      validator: v.validator,
      modelVersion: v.modelVersion,
      family: v.familyKey,
      belief: clamp01(v.belief),
      confidence: clamp01(v.confidence),
      reliability_mean: reliabilityMean,
      reliability_alpha: w.alpha,
      reliability_beta: w.beta,
      trust: clamp01(v.confidence) * clamp01(reliabilityMean),
      contributes_act: bpa[0],
      contributes_not: bpa[1],
      contributes_ignorance: bpa[2],
    });
  }

  const [belief_act, belief_not, ignorance_mass] = mass;
  const decisive = belief_act + belief_not;
  const confidence = clamp01(decisive); // 1 − ignorance
  const weighted_agreement = decisive > 1e-9 ? belief_act / decisive : 0.5;

  // --- 2. §5 correlated/common-mode heuristic: a one-sided panel from too few independent
  //        families is WEAKER than a split across genuinely different evidence paths. ---
  const oneSided = weighted_agreement >= 0.75 || weighted_agreement <= 0.25;
  const correlated_warning = oneSided && votes.length >= 4 && families.size <= 2;

  // --- 3. §2.3 / P-003: a tight consistent split at HIGH belief = coordinated dissonance =
  //        hard conservative signal (lean to the SAFE default, do not auto-punish). ---
  const meanBelief = beliefs.reduce((s, x) => s + x, 0) / beliefs.length;
  const spread = beliefs.length > 1 ? Math.max(...beliefs) - Math.min(...beliefs) : 1;
  const comma_conservative = beliefs.length >= 3 && spread < COMMA_GAP && meanBelief > COMMA_HIGH_BELIEF;

  // --- 4. Decision (§2.2 weighted supermajority; §1 protective/punitive asymmetry;
  //        §2.3 deadlock → abstain(low)/escalate(high); never force irreversible on a tie). ---
  const actBar = ACT_BAR[stakes];
  const ignoranceCap = IGNORANCE_CAP[stakes];
  const minConf = MIN_CONFIDENCE_TO_ACT[stakes];
  const highStakes = stakes === 'high' || stakes === 'irreversible';

  let decision: SbfaDecision;
  let escalate_to: 'contested_bft' | null = null;
  let reason: string;

  const meetsSupermajority =
    belief_act >= actBar && ignorance_mass <= ignoranceCap && confidence >= minConf;

  if (action === 'punitive' && comma_conservative) {
    // P-003 override: high-confidence tight agreement is treated as suspect for irreversible punishment.
    decision = highStakes ? 'escalate' : 'abstain';
    escalate_to = highStakes ? 'contested_bft' : null;
    reason = `P-003 coordinated-dissonance signal (spread ${spread.toFixed(4)} < comma ${COMMA_GAP.toFixed(4)} at mean belief ${meanBelief.toFixed(3)}) — declining to auto-punish; deferring.`;
  } else if (meetsSupermajority) {
    decision = 'act';
    reason = `Weighted supermajority to act: belief_act ${belief_act.toFixed(3)} ≥ ${actBar} (ignorance ${ignorance_mass.toFixed(3)} ≤ ${ignoranceCap}, confidence ${confidence.toFixed(3)} ≥ ${minConf}).`;
  } else if (
    action === 'protective' &&
    weighted_agreement >= PROTECTIVE_HOLD_AGREEMENT &&
    confidence >= PROTECTIVE_MIN_CONFIDENCE
  ) {
    // §1: reversible safety-hold gets a low bar — most splits resolve to containment, not punishment.
    decision = 'hold';
    reason = `Protective hold: decisive mass leans to act (agreement ${weighted_agreement.toFixed(3)} ≥ ${PROTECTIVE_HOLD_AGREEMENT}, confidence ${confidence.toFixed(3)}) — reversible containment, below the punitive bar ${actBar}.`;
  } else {
    // Insufficient consensus → defer (§2.2 "insufficient consensus, not a decision"; §2.3 deadlock).
    decision = highStakes ? 'escalate' : 'abstain';
    escalate_to = highStakes ? 'contested_bft' : null;
    reason = `Insufficient consensus to act (belief_act ${belief_act.toFixed(3)} < ${actBar} or ignorance ${ignorance_mass.toFixed(3)} > ${ignoranceCap}) — ${decision}.`;
  }

  // --- 5. §5 chronic-near-deadlock accumulator. Landing in the ambiguity band (or deferring on a
  //        genuine split) is itself a signal; repeatedly doing so → probation/escalation. Decisive
  //        resolutions decay the counter toward 0 so a single ambiguous call is not punished. ---
  const inBand = Math.abs(weighted_agreement - 0.5) <= NEAR_DEADLOCK_BAND;
  const deferredSplit = (decision === 'abstain' || decision === 'escalate') && confidence > 0.2;
  const ambiguous = inBand || deferredSplit;
  const near_deadlock_count = ambiguous ? priorCount + 1 : Math.max(0, priorCount - 1);
  const near_deadlock_triggered = near_deadlock_count >= CHRONIC_NEAR_DEADLOCK_THRESHOLD;

  if (near_deadlock_triggered && decision !== 'act') {
    // The accumulator overrides a quiet abstain into an escalation: an adversary cannot farm a
    // permanent gray-zone license by engineering ~50/50 splits.
    decision = 'escalate';
    escalate_to = 'contested_bft';
    reason += ` | Chronic near-deadlock accumulator fired (${near_deadlock_count} ≥ ${CHRONIC_NEAR_DEADLOCK_THRESHOLD}) → forcing escalation (inertia-exploitation guard, §5).`;
  }

  // --- 6. GLASS BOX trace (cheap, pure — built from values already computed). ---
  const f2 = (x: number) => x.toFixed(2);
  const f3 = (x: number) => x.toFixed(3);
  const lines: string[] = [];
  lines.push(`SBFA v0.2 · stakes=${stakes} · action=${action} · reliability=${oracle.source}`);
  for (const t of voteTraces) {
    const fam = t.family ? `/${t.family}` : '';
    lines.push(
      `· ${t.validator} (${t.modelVersion}${fam}): believes ACTION ${f2(t.belief)} @ conf ${f2(t.confidence)}, ` +
        `earned reliability ${f2(t.reliability_mean)} ⇒ evidence act ${f2(t.contributes_act)} / ¬act ${f2(t.contributes_not)} / ignorance ${f2(t.contributes_ignorance)}`
    );
  }
  lines.push(
    `Fused (Yager DST): belief(act)=${f3(belief_act)}, belief(¬act)=${f3(belief_not)}, ignorance=${f3(ignorance_mass)}; ` +
      `weighted agreement=${f3(weighted_agreement)}, confidence=${f3(confidence)}.`
  );
  lines.push(`Bars (${stakes}/${action}): act ≥ ${actBar}, ignorance ≤ ${ignoranceCap}, confidence ≥ ${minConf}.`);
  if (correlated_warning) lines.push(`⚠ Correlated panel: ${families.size} independent famil${families.size === 1 ? 'y' : 'ies'} across ${votes.length} one-sided votes — treat as weaker (§5 common-mode).`);
  if (comma_conservative) lines.push(`⚠ P-003 coordinated-dissonance: tight agreement at high belief — declining to auto-punish.`);
  if (near_deadlock_triggered) lines.push(`⚠ Chronic near-deadlock (${near_deadlock_count} ≥ ${CHRONIC_NEAR_DEADLOCK_THRESHOLD}) — forced escalation (§5 inertia guard).`);
  lines.push(`DECISION: ${decision.toUpperCase()}${escalate_to ? ` → ${escalate_to}` : ''} — ${reason}`);

  const trace: SbfaTrace = {
    votes: voteTraces,
    fused: { belief_act, belief_not, ignorance_mass },
    weighted_agreement,
    act_threshold: actBar,
    ignorance_cap: ignoranceCap,
    min_confidence: minConf,
    stakes,
    action,
    reliability_source: oracle.source,
    flags: { correlated_warning, comma_conservative, near_deadlock_triggered },
    lines,
  };

  return {
    decision,
    belief_act,
    belief_not,
    ignorance_mass,
    confidence,
    weighted_agreement,
    act_threshold: actBar,
    escalate_to,
    near_deadlock_count,
    near_deadlock_triggered,
    correlated_warning,
    comma_conservative,
    reliability_source: oracle.source,
    reason,
    trace,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * Reliability oracles
 * ------------------------------------------------------------------------------------------------ */

/**
 * Constant-weight oracle. A neutral PLACEHOLDER for the pre-oracle phase — it gives every validator
 * the same reliability mean. It is NOT a real reliability source; it exists so the consensus is
 * usable in shadow mode before GA wires the verified-outcome oracle. `source` says so loudly.
 */
export class ConstantReliabilityOracle implements ReliabilityOracle {
  readonly source: string;
  private readonly weight: ReliabilityWeight;
  constructor(mean = 0.7, strength = 4) {
    const m = clamp01(mean);
    const s = Math.max(2, strength);
    this.weight = { alpha: m * s, beta: (1 - m) * s };
    this.source = `constant-placeholder(mean=${m},strength=${s}) — NOT a verified-outcome oracle; GA wires the real one`;
  }
  getWeight(): ReliabilityWeight {
    return this.weight;
  }
}

/**
 * The seam GA fills (§7 GA task). A real implementation supplies per-(validator, modelVersion,
 * category) Beta posteriors derived from VERIFIED OUTCOMES (gold labels / human-confirmed results) —
 * a proper scoring rule (Brier/log), NOT hal_score or any consensus-derived metric (that would be the
 * §5 reflexivity / Goodhart loop). This adapter takes a pre-fetched, externally-validated weight map
 * so the anti-reflexivity rule is enforced at the data boundary: nothing self-derived can enter here.
 */
export class MapReliabilityOracle implements ReliabilityOracle {
  readonly source: string;
  private readonly map: Map<string, ReliabilityWeight>;
  private readonly fallback: ReliabilityWeight;
  /**
   * @param entries keyed by `${validator}|${modelVersion}|${category}` → Beta(α,β) from verified outcomes.
   * @param source  provenance string (e.g. 'gold-labels@2026-06-15') — must name the out-of-band source.
   * @param fallbackMean reliability mean to use for an unseen (validator,version,category).
   */
  constructor(entries: Record<string, ReliabilityWeight>, source: string, fallbackMean = 0.6) {
    this.map = new Map(Object.entries(entries));
    const m = clamp01(fallbackMean);
    this.fallback = { alpha: m * 2, beta: (1 - m) * 2 };
    this.source = source;
  }
  getWeight(validator: string, modelVersion: string, category: string): ReliabilityWeight {
    return (
      this.map.get(`${validator}|${modelVersion}|${category}`) ??
      this.map.get(`${validator}|${modelVersion}|*`) ??
      this.fallback
    );
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * Verdict adapter — map the fact-check per-provider verdicts onto SBFA votes.
 * ------------------------------------------------------------------------------------------------ */

/** Minimal shape (avoids a circular import on fact-check's ProviderVerdict). */
export interface VerdictLike {
  provider: string;
  model?: string;
  verdict: 'TRUE' | 'FALSE' | 'UNCERTAIN' | 'ERROR';
  confidence: number; // 0..100 (fact-check convention)
  family?: string;
}

/**
 * Map fact-check verdicts → SBFA votes. `belief` is "the veto/slash action IS warranted", i.e.
 * P(claim is FALSE): FALSE → high, TRUE → low, UNCERTAIN → 0.5 with low confidence (the DST
 * discounting then routes its mass to ignorance, not to a decisive side). ERROR votes are dropped.
 *
 * `familyOf` RESOLVES INDEPENDENCE, and is what makes the §5 correlated-panel heuristic mean
 * anything. A ProviderVerdict does not carry `family`, so before this parameter existed every live
 * vote reached `sbfaConsensus` with `familyKey: undefined` — `families.size` was therefore always 0
 * and `correlated_warning` fired on EVERY one-sided panel of 4+, including a perfectly independent
 * one (measured on production 2026-08-28: 4 distinct families, trace read "0 independent families").
 * A warning that cannot not-fire is not a warning, and this one was inverted: more independent
 * families raised `votes.length` while `families.size` stayed pinned at 0.
 *
 * It is a RESOLVER rather than a second family table on purpose — the caller passes the same
 * registry-primary map (`familyByName`) that every other family computation in the quorum already
 * uses, so this cannot drift into a second opinion about who is independent of whom.
 *
 * Optional, and an explicit `verdict.family` still wins: the builder pre-tags family on some paths
 * from the same registry, and a lookup must never overwrite a tag that is already authoritative. A
 * resolver MISS returns undefined and stays undefined — an unknown family is counted as unknown,
 * never quietly folded into one the provider never had.
 */
export function votesFromVerdicts(
  verdicts: VerdictLike[],
  familyOf?: (provider: string) => string | undefined,
): ValidatorVote[] {
  const out: ValidatorVote[] = [];
  for (const v of verdicts) {
    if (v.verdict === 'ERROR') continue;
    const c = clamp01((Number(v.confidence) || 0) / 100);
    let belief: number;
    let confidence: number;
    if (v.verdict === 'FALSE') {
      belief = 0.5 + 0.5 * c;
      confidence = c;
    } else if (v.verdict === 'TRUE') {
      belief = 0.5 - 0.5 * c;
      confidence = c;
    } else {
      belief = 0.5;
      confidence = Math.min(c, 0.3); // UNCERTAIN contributes mostly ignorance
    }
    out.push({
      validator: v.provider,
      modelVersion: v.model ?? v.provider,
      belief,
      confidence,
      familyKey: v.family ?? familyOf?.(v.provider),
    });
  }
  return out;
}

