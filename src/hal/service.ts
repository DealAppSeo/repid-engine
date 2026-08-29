/**
 * HalService — the reusable HAL evaluation surface every Trust* product calls.
 *
 * Foundation for TrustShell.dev / TrustTrader.dev / TrustCRE.dev: one clean
 * interface, product profiles (strictness + thresholds + domain), env-overridable.
 * Internally dispatches to the calibrated fact-check evaluator (strictness:2) or
 * the extractor (strictness:1). Decoupled from the scoring pipeline / db so it's
 * independently testable and embeddable.
 */
import { factCheck, buildFactCheckProviders, type FactCheckProviderCfg, type FactCheckResult } from './fact-check';
import { evaluate } from './lib/evaluate';
import { markDegraded } from '../lib/degraded';
import { applyExecutionFloor, type FloorReport } from './execution-floor';

export type Product = 'trustshell' | 'trusttrader' | 'trustcre' | 'default';

export interface HalEvaluationRequest {
  text: string;
  context?: { domain?: string; certainty?: number; product?: Product };
  strictness?: 1 | 2;
  /**
   * Optional per-call provider-set override. When present, it is used instead
   * of the service's default `providersFn` for THIS evaluation only. The
   * runtime-config layer passes a repid_config-resolved set here so provider
   * enablement is DB-driven (no redeploy) without mutating the shared singleton.
   */
  providersFn?: () => FactCheckProviderCfg[];
  /**
   * CALL ATTRIBUTION — the agent this evaluation is being run FOR. Forwarded to
   * `factCheck()` so every provider call in the quorum is stamped with it in
   * `llm_call_log.agent_id`.
   *
   * Set it ONLY where the caller has an authenticated agent. The public
   * `/hal/evaluate` route has anonymous callers and deliberately leaves it unset —
   * a null there is the honest value, and inventing an id to raise an attribution
   * percentage would be exactly the kind of number that looks like success without
   * being it.
   */
  agentId?: string;
}

export interface HalEvaluationResponse {
  hal_score: number;
  decision: 'vetoed' | 'flagged' | 'clean' | 'abstain';
  decision_reason?: string; // A1 — human-readable explanation (verdict mode)
  mode: 'fact-check' | 'extractor' | 'extractor-fallback';
  strictness: 1 | 2;
  product: Product;
  signals: Record<string, unknown>;
  provider_responses?: unknown[];
  latency_ms: number;
  // "Degrade loudly": set on the extractor-fallback path (strictness-2 requested
  // but the discriminative fact-check quorum was unavailable). mode already
  // reads 'extractor-fallback'; these make the degrade explicit + logged so a
  // caller can't silently treat the style-extractor score as a real fact-check.
  degraded_mode?: true;
  degraded_reason?: string;
  // GLASS BOX — SBFA v0.2 belief/ignorance/confidence + the structured human-readable decision trace.
  // Surfaced to the wrapper verdict event + the HITL PWA. Present only on the fact-check (strictness-2) path.
  sbfa?: FactCheckResult['sbfa'];
  // EXECUTION FLOOR (P0) — pre-HAL "execution beats explanation" verdicts. Present when the floor ran.
  // In shadow mode (EXECUTION_FLOOR_ENABLED unset/false) this is COMPUTED + attached for measurement but
  // the `decision` above is NOT changed by it. When the flag is live, an authoritative execution FAILURE
  // can force `decision:'vetoed'` (LLM/HAL opinion on that claim is inadmissible).
  execution_floor?: {
    enabled: boolean;
    overridden: boolean;
    note: string;
    report: FloorReport;
  };
  // UNEARNED-VETO GUARD — present ONLY when a `vetoed` was downgraded for want of provider evidence.
  // Its absence means no veto was suppressed; it is never stamped on a decision HAL did not change.
  veto_suppressed?: {
    reason_code: 'NO_PROVIDER_EVIDENCE';
    /** The decision HAL would have returned before the guard (always 'vetoed'). */
    original_decision: 'vetoed';
    /** Providers that produced a usable verdict. Zero — that is the whole reason this field exists. */
    providers_succeeded: 0;
    note: string;
  };
  // UNEARNED-REWARD GUARD — present ONLY when a `clean` was reached with zero provider successes.
  //
  // NOTE THE DIFFERENCE FROM `veto_suppressed`: this marker does NOT change `decision`. The verdict
  // stays 'clean' because a 'clean' does not accuse anyone, and rewriting it would manufacture
  // suspicion out of the absence of a detector. What is withheld is the PAYOUT, and only a caller
  // that turns a verdict into RepID needs to act on it — via `scoringDecisionOf()`.
  reward_suppressed?: {
    reason_code: 'NO_PROVIDER_EVIDENCE';
    /** The decision HAL did return, and still returns. Always 'clean' — this marker never rewrites it. */
    original_decision: 'clean';
    /** Providers that produced a usable verdict. Zero — that is the whole reason this field exists. */
    providers_succeeded: 0;
    /** The decision a SCORER must use instead. 'flagged' → computeDelta 0: surfaced, nothing paid. */
    scoring_decision: 'flagged';
    note: string;
  };
}

interface Profile {
  strictness: 1 | 2;
  vetoThreshold: number;
  flagThreshold: number;
  domain: string;
}

/**
 * Product profiles — presets per Trust* domain. All thresholds env-overridable
 * (HAL_VETO_THRESHOLD / HAL_FLAG_THRESHOLD apply globally). Tune per product later.
 */
export const HAL_PROFILES: Record<Product, Profile> = {
  default: { strictness: 2, vetoThreshold: 0.5, flagThreshold: 0.35, domain: 'general' },
  trustshell: { strictness: 2, vetoThreshold: 0.5, flagThreshold: 0.35, domain: 'technical' },
  trusttrader: { strictness: 2, vetoThreshold: 0.45, flagThreshold: 0.3, domain: 'finance' },
  trustcre: { strictness: 2, vetoThreshold: 0.5, flagThreshold: 0.35, domain: 'cre-underwriting' },
};

const deriveDecision = (s: number, vetoed: boolean, sev?: string | null): HalEvaluationResponse['decision'] =>
  vetoed || sev === 'critical' ? 'vetoed' : s >= 0.4 ? 'flagged' : 'clean';

/**
 * A VETO REQUIRES A PROVIDER.
 *
 * MEASURED (2026-08-17, `hal_runner_results`, hal_mode='fact-check-s2', gen_failed=false, 395 rows,
 * split on whether any provider SUCCEEDED):
 *
 *   provider succeeded : n=336, 166 vetoes, 159 right /  7 wrong → veto precision 0.9578, AUC 0.9746
 *   NO provider        : n= 59,  41 vetoes,  19 right / 22 wrong → veto precision 0.4634, AUC 0.5150
 *
 * AUC 0.5150 is chance. A veto cast without a provider behind it lands on a clean answer more often
 * than on a hallucinated one (22 of 41), and it charged the same -10 RepID as an earned veto
 * (`computeDelta`, 'vetoed' → -10). Suppressing it costs no real recall: every one of the 166 earned
 * vetoes had a succeeded provider and is untouched by this guard.
 *
 * WHY `provider_health.succeeded` AND NOT `providers_used` OR `mode`:
 * the HAL_LOCAL_FALLBACK_ENABLED path in fact-check.ts fabricates `providers_used: 1` and reports
 * `mode: 'fact-check'` for what is literally `deliverable.includes('false') ? 'FALSE' : 'TRUE'` — a
 * substring match scored 0.8, over the veto threshold. It is a no-provider veto wearing a
 * fact-check's clothes, and BOTH a mode check and a providers_used check wave it through.
 * `provider_health.succeeded` is the one field that stays honest on that path (fact-check.ts sets it
 * to 0 there while inflating providers_used), so it is the field this guard reads.
 *
 * WHY 'flagged' AND NOT 'abstain':
 *  - `computeDelta` scores BOTH at delta 0, so the RepID outcome — the thing that was wrong — is
 *    identical either way. The choice is purely about what the state MEANS to a reader.
 *  - 'abstain' already has a distinct, load-bearing meaning at fact-check.ts:996: providers ran and
 *    none judged the claim FALSE, i.e. "not a checkable claim". That is a conclusion reached WITH
 *    evidence. Reusing it for "we obtained no evidence" would collapse *declined to assess* into
 *    *failed to assess* — two states a consumer must be able to tell apart.
 *  - 'flagged' is what the sibling degrade path at fact-check.ts:952-959 ALREADY returns for exactly
 *    this condition (0 providers responded → hal_score 0.5, decision 'flagged'). Same condition,
 *    same answer.
 *  - `verdictOf` (routes/v1/openai-compat.ts:106) maps 'abstain' to 'unscored' — it has no case for
 *    it — so emitting 'abstain' on a public surface would erase the anomaly rather than report it.
 *    'flagged' is carried faithfully there.
 * The suppression is NOT silent in either case: `veto_suppressed.reason_code` records it structurally
 * and a warn line names it in the logs.
 *
 * REVERSIBLE: `HAL_VETO_REQUIRES_PROVIDER=false` restores the prior behaviour exactly. Default ON.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A REWARD REQUIRES A PROVIDER — the same predicate, the opposite sign, a DIFFERENT remedy.
 *
 * MEASURED on the same ruler and the same 59-row no-provider slice, the `clean` half:
 *
 *   NO provider, HAL said 'clean' : n=18, 9 hallucinated / 9 not → clean precision 0.5000
 *                                   (16 distinct prompts: 7/16 = 0.4375)
 *
 * The base rate of "not a hallucination" in that same slice is 0.5254, so the verdict's lift is
 * 0.95 — it is not merely uninformative, it is very slightly anti-informative. And HAL's two
 * answers are indistinguishable there: P(hallucination | 'vetoed') = 0.4634 vs
 * P(hallucination | 'clean') = 0.5000, Fisher exact two-sided p = 1.0000. Run through the real
 * `computeDelta` at the real recorded scores, those 18 rows mint +37.4 RepID — +18.5 of it onto
 * answers the corpus labels as hallucinated.
 *
 * WHY THIS IS NOT SYMMETRIC WITH THE VETO, AND MUST NOT BE. A veto ACCUSES: it takes RepID from a
 * named agent on a claim nothing supports, so an evidence-free one has to be WITHDRAWN, and the
 * guard above rewrites the verdict. A 'clean' accuses nobody. Rewriting it to 'flagged' would
 * MANUFACTURE suspicion out of the absence of a detector — the mirror image of the harm the veto
 * half exists to remove, and a strictly worse trade (an honest agent would be marked for review
 * because a provider was down). So the verdict is left EXACTLY as HAL found it, and only the
 * unearned PAYOUT is withheld, via a marker a scorer reads (`scoringDecisionOf`).
 *
 * Withholding is not a penalty: `computeDelta`'s 'flagged' branch is 0, never negative, and the
 * moment one provider answers the reward is available again. The asymmetry in RECOVERABILITY is
 * the reason the default is ON — a withheld +2 is recoverable on the next evaluation, an unearned
 * +2 already written to `repid_score_events` is not clawed back by later evidence.
 *
 * AND THE TWO HALVES ARE COUPLED. Once the veto half ships, a total provider outage leaves 'clean'
 * as the ONLY decision that still moves RepID, and it moves it UP: of the measured 59, 41 become
 * flagged (delta 0) and 18 keep paying. Shipping the veto guard alone converts an outage from
 * two-sided noise into a one-sided reputation-inflation channel. That is why this lands with it.
 *
 * REVERSIBLE, SEPARATELY: `HAL_REWARD_REQUIRES_PROVIDER=false`. Default ON. Two flags rather than
 * one because the rollbacks are not equivalent — reverting the veto half restores a wrongful -10
 * against a named agent, reverting this one restores a +2 credit — and because the veto half
 * changes a PUBLISHED verdict while this one changes only scoring, so an API consumer can be
 * affected by one and not the other. They share the single `providersSucceeded === 0` early-out
 * below, so they can never drift on WHEN they fire, only on the remedy.
 */
export function applyProviderEvidenceGuard<T extends {
  decision: HalEvaluationResponse['decision'];
  mode: HalEvaluationResponse['mode'];
}>(
  result: T,
  providersSucceeded: number,
): T & Partial<Pick<HalEvaluationResponse, 'veto_suppressed' | 'reward_suppressed'>> {
  // ONE PREDICATE, shared by both halves. Only fire where zero successes are POSITIVELY
  // established. A provider count we could not determine is not a zero (LESSONS: an unknown is
  // neither 0 nor 1), so it is left alone.
  if (providersSucceeded !== 0) return result;

  if (result.decision === 'vetoed') {
    if (process.env.HAL_VETO_REQUIRES_PROVIDER === 'false') return result;
    const note =
      `veto suppressed: 0 providers produced a usable verdict (mode='${result.mode}'), so this veto ` +
      `rested on no cross-provider evidence. Measured veto precision with no provider is 0.4634 ` +
      `(AUC 0.5150 = chance) vs 0.9578 with one. Downgraded to 'flagged' — surfaced for review, ` +
      `zero RepID delta, never a -10 penalty. Reverse with HAL_VETO_REQUIRES_PROVIDER=false.`;
    console.warn(`[hal] UNEARNED VETO SUPPRESSED (loud): ${note}`);
    return {
      ...result,
      decision: 'flagged' as const,
      veto_suppressed: {
        reason_code: 'NO_PROVIDER_EVIDENCE' as const,
        original_decision: 'vetoed' as const,
        providers_succeeded: 0 as const,
        note,
      },
    };
  }

  if (result.decision === 'clean') {
    if (process.env.HAL_REWARD_REQUIRES_PROVIDER === 'false') return result;
    const note =
      `reward suppressed: 0 providers produced a usable verdict (mode='${result.mode}'), so this ` +
      `'clean' rests on no cross-provider evidence. Measured clean precision with no provider is ` +
      `0.5000 against a 0.5254 base rate (lift 0.95 — no information). The VERDICT is unchanged: a ` +
      `clean accuses nobody and must not be turned into a flag because a detector was down. Only ` +
      `the payout is withheld — score this as 'flagged' (delta 0), never as a penalty. Reverse ` +
      `with HAL_REWARD_REQUIRES_PROVIDER=false.`;
    console.warn(`[hal] UNEARNED REWARD SUPPRESSED (loud): ${note}`);
    return {
      ...result,
      reward_suppressed: {
        reason_code: 'NO_PROVIDER_EVIDENCE' as const,
        original_decision: 'clean' as const,
        providers_succeeded: 0 as const,
        scoring_decision: 'flagged' as const,
        note,
      },
    };
  }

  return result;
}

/**
 * THE DECISION A REWARD-GRANTING CALLER MUST SCORE.
 *
 * Exists so no caller has to remember the rule. The veto lane's finding was precisely that
 * `HalService` hands out a verdict having consulted nothing and every consumer must independently
 * check `mode` — two did, one public route did not. A marker with a per-caller convention would
 * reproduce that defect with an extra step, so the convention is a function.
 *
 * Identity on every unmarked result, so it is safe to wrap any call site unconditionally.
 */
export function scoringDecisionOf(
  r: Pick<HalEvaluationResponse, 'decision'> & Partial<Pick<HalEvaluationResponse, 'reward_suppressed'>>,
): HalEvaluationResponse['decision'] {
  return r.reward_suppressed ? r.reward_suppressed.scoring_decision : r.decision;
}

/**
 * Providers that produced a usable verdict, or `null` when that cannot be established.
 *
 * Reads `provider_health.succeeded` — the field the local_slm fallback keeps honest while it inflates
 * `providers_used` to 1. Falls back to `providers_used` only when provider_health is absent entirely
 * (a pre-provider_health result shape); returns null when neither is a number, so an UNKNOWN count is
 * never coerced into a 0 that would trip the guard.
 */
export function successfulProviderCount(fc: {
  providers_used?: number;
  provider_health?: { succeeded?: number };
}): number | null {
  const succeeded = fc.provider_health?.succeeded;
  if (typeof succeeded === 'number') return succeeded;
  if (typeof fc.providers_used === 'number') return fc.providers_used;
  return null;
}

function clamp01(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

export class HalService {
  constructor(private providersFn: () => FactCheckProviderCfg[] = buildFactCheckProviders) {}

  /**
   * Public evaluate — runs the HAL pipeline, then applies the EXECUTION FLOOR
   * (P0 "execution beats explanation" law) as a post-check. Shadow-first:
   * unless EXECUTION_FLOOR_ENABLED=true, the floor is COMPUTED + attached to
   * `execution_floor` for measurement but the HAL `decision` is unchanged.
   * When the flag is live, an authoritative execution FAILURE forces a veto.
   */
  async evaluate(req: HalEvaluationRequest): Promise<HalEvaluationResponse> {
    const hal = await this.evaluateHal(req);
    try {
      const applied = await applyExecutionFloor(req.text, {
        decision: hal.decision,
        ...(hal.decision_reason ? { decision_reason: hal.decision_reason } : {}),
      });
      const out: HalEvaluationResponse = {
        ...hal,
        decision: applied.decision.decision,
        ...(applied.decision.decision_reason ? { decision_reason: applied.decision.decision_reason } : {}),
        execution_floor: {
          enabled: applied.floor.enabled,
          overridden: applied.overridden,
          note: applied.note,
          report: applied.floor,
        },
      };
      // The execution floor may re-veto what the no-provider guard just downgraded, and that veto IS
      // earned: it rests on a DETERMINISTIC execution check, not on an LLM opinion or a provider
      // quorum. When it does, the `veto_suppressed` marker is stale and would contradict the decision
      // it sits next to — so drop it. (The floor only ever overrides toward 'vetoed'.)
      if (out.decision === 'vetoed') delete out.veto_suppressed;
      // Same invariant for the reward marker, in the other direction: `reward_suppressed` says
      // "the 'clean' HAL returned is unpaid". If the floor moved the decision off 'clean', there is
      // no longer a clean to be unpaid for, and the marker would describe a verdict that is no
      // longer there. (The floor only overrides toward 'vetoed', which already pays 0.)
      if (out.decision !== 'clean') delete out.reward_suppressed;
      if (applied.overridden) {
        console.warn(`[hal/execution-floor] OVERRIDE — ${applied.note}`);
      }
      return out;
    } catch (e: unknown) {
      // The floor must NEVER break HAL. On any error, return the untouched HAL result.
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[hal/execution-floor] floor failed (ignored, HAL unchanged):', msg);
      return hal;
    }
  }

  /** The core HAL pipeline (no execution-floor). */
  private async evaluateHal(req: HalEvaluationRequest): Promise<HalEvaluationResponse> {
    const start = Date.now();
    const product: Product = req.context?.product && HAL_PROFILES[req.context.product] ? req.context.product : 'default';
    const profile = HAL_PROFILES[product];
    const strictness: 1 | 2 = req.strictness ?? profile.strictness;
    const domain = req.context?.domain ?? profile.domain;
    const certainty = req.context?.certainty ?? 0.8;
    // Env overrides win over profile thresholds (runtime tuning, no redeploy).
    const vetoThreshold = clamp01(process.env.HAL_VETO_THRESHOLD) ?? profile.vetoThreshold;
    const flagThreshold = Math.min(clamp01(process.env.HAL_FLAG_THRESHOLD) ?? profile.flagThreshold, vetoThreshold);

    // Per-call provider override (repid_config-driven) wins over the singleton
    // default; falls back to this.providersFn when absent.
    const providersFn = req.providersFn ?? this.providersFn;
    if (strictness === 2) {
      const providers = providersFn();
      if (providers.length > 0) {
        const fc = await factCheck(req.text, providers, {
          vetoThreshold,
          flagThreshold,
          ...(req.agentId ? { agentId: req.agentId } : {}),
        });
        if (fc.providers_used > 0) {
          // A veto here still needs REAL provider successes behind it: the local_slm fallback
          // reaches this branch with a fabricated providers_used:1 and provider_health.succeeded:0.
          const succeeded = successfulProviderCount(fc);
          return applyProviderEvidenceGuard({
            hal_score: fc.hal_score, decision: fc.decision,
            ...(fc.decision_reason ? { decision_reason: fc.decision_reason } : {}),
            mode: 'fact-check', strictness, product,
            signals: {
              providers_used: fc.providers_used, agreement: fc.agreement, degraded: fc.degraded,
              // R5 — distinct independent families that voted (the quorum unit).
              families_used: fc.families_used, families: fc.families,
              // A FAMILY COUNT IS NOT AN INDEPENDENCE COUNT — N families behind ONE host is N
              // opinions that vanish in a single outage. It travels WITH families_used, always,
              // and this line is why: `signals` is rebuilt field by field here, so a value can be
              // computed in fact-check.ts, typed on the result, returned internally, and still
              // never reach a caller. That is exactly what happened — shipped, deployed, and only
              // caught by probing the live endpoint. `tests/hal-signals-seam.test.ts` now asserts
              // the crossing rather than the computation.
              ...(fc.independent_hosts !== undefined ? { independent_hosts: fc.independent_hosts } : {}),
              // V3 FIX 2026-07-05 — surface models whose family was regex-guessed (not in the registry)
              // so the unmapped signal reaches score-event metadata, not just the console.warn.
              ...(fc.families_unmapped?.length ? { families_unmapped: fc.families_unmapped } : {}),
              // CC1 2026-05-23 provider-failure hardening: surface quorum + per-provider health.
              quorum: fc.quorum, provider_health: fc.provider_health,
              ...(fc.quorum_note ? { quorum_note: fc.quorum_note } : {}),
            },
            provider_responses: fc.verdicts, latency_ms: Date.now() - start,
            ...(fc.sbfa ? { sbfa: fc.sbfa } : {}),
          }, succeeded ?? fc.providers_used);
        }
      }
      // No providers / none responded → extractor fallback. Degrade LOUDLY: a
      // strictness-2 fact-check was requested but couldn't assemble a quorum, so
      // this score is the non-discriminative style-extractor, NOT a real
      // cross-LLM fact-check. Mark + log it so it can't pass as the real path.
      const providerCount = providersFn().length;
      const r = await evaluate(req.text, req.text, { domain, certainty, strictness: 1 });
      // Zero providers succeeded BY CONSTRUCTION — this branch is only reached when none did.
      // This is the path that produced the 41 measured unearned vetoes.
      return markDegraded(
        applyProviderEvidenceGuard({
          hal_score: r.hal_score, decision: deriveDecision(r.hal_score, r.vetoed, (r.signals as any)?.comma_severity ?? null),
          mode: 'extractor-fallback' as const, strictness, product, signals: r.signals as any, latency_ms: Date.now() - start,
        }, 0),
        `strictness-2 requested but fact-check quorum unavailable (${providerCount} provider(s) configured, none produced a usable verdict) — scored with the non-discriminative style-extractor, NOT a real cross-LLM fact-check`,
        'hal',
      );
    }

    // Strictness 1 — the local style-extractor. No provider is consulted on this path at all, so a
    // veto from it is unearned by the same measurement (AUC 0.5150). Guarded identically.
    const r = await evaluate(req.text, req.text, { domain, certainty, strictness: 1 });
    return applyProviderEvidenceGuard({
      hal_score: r.hal_score, decision: deriveDecision(r.hal_score, r.vetoed, (r.signals as any)?.comma_severity ?? null),
      mode: 'extractor' as const, strictness, product, signals: r.signals as any, latency_ms: Date.now() - start,
    }, 0);
  }
}

export const halService = new HalService();
