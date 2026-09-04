/**
 * Sprint A7 — score-event pipeline.
 *
 * runScoreEvent(input) is the single entry point that turns
 * (prompt, answer) + agent state into:
 *   1. HAL evaluation (signals + score + decision)
 *   2. RepID delta (calculated + applied, vesting-aware)
 *   3. repid_score_events row (canonical history)
 *   4. repid_agents.current_repid update
 *   5. ZK proof queue trigger when delta magnitude warrants
 *
 * Idempotency: callers may pass an idempotency_key; same key → same row,
 * never re-processed.
 *
 * HAL failures are non-fatal: if the evaluator throws, the event is logged
 * with hal_score=0.5, hal_decision='flagged', and signals.error='hal_failure'.
 *
 * agent_repid_history is intentionally NOT written to. The canonical
 * history lives in repid_score_events (per CLAUDE.md). The legacy
 * agent_repid_history table is reserved for payment-linked deltas with
 * its own NOT NULL payment_proof_hash constraint.
 */

import crypto from 'crypto';
import { STARTING_REPID } from './repid-constants';
import { db } from '../db';
import { logToolCall } from '../utils/tool-call-logger';
import { evaluate } from '../hal/lib/evaluate';
import {
  HAL_DEFAULT_VETO_THRESHOLD,
  HAL_CONSTITUTIONAL_BLOCK_THRESHOLD,
} from '../hal/lib/constants';
import { computeDelta, HALDecision } from './repid-delta';
import { clampRepidLoud } from './repid-clamp';
import {
  assessDecay,
  decayedScoreFor,
  decayMetadata,
  applyToScore,
  appliedScoreReconciles,
  appliedScoreMetadata,
} from './decay-bridge';
import { recordDeltaStatementDetached } from '../zkp/repid-delta-bridge';
import { appendToAuditChain } from '../services/auditChainWriter';
import { extractHALSignals } from '../hal/lib/extract';
import { halService } from '../hal/service';
import { strictModeOrFallback } from '../hal/lib/strict-mode';
import { classifyTaskPurpose } from './task-purpose';
import { computeGroundingSignal, groundingMode } from '../hal/hal-grounding';
import type { ProofCarryingAnswer } from '../memory/proof-carrying-memory';
import { getHalConfig } from '../hal/config';
import { buildFactCheckProvidersWith } from '../hal/fact-check';
import {
  parseProofEnqueueMode,
  evaluateProofEnqueue,
} from '../services/proof-enqueue-filter';
import { resolveIssuerIdentity } from './issuer-identity';
import { evaluateEconomicMove, moneyPathGateMode } from '../kernel/money-path-gate';

/**
 * HAL scoring path selector for the live score-event pipeline.
 *
 * DEFECT (sprint 2026-05-29, proven): the live pipeline scored every event with
 * the EXTRACTOR-only path (strictness 1), which has NO discriminative power —
 * on a 20-item labeled corpus the extractor gave AUC(FALSE>TRUE)=0.407 and a
 * NEGATIVE true/false gap (-0.020); live scores cluster at ~0.27 and nothing
 * meaningfully separates truth from hallucination. The discriminative scorer is
 * the cross-LLM FACT-CHECK path (halService strictness 2, groq+fireworks): on
 * the 109-case validation corpus it scores F1 0.77, precision 0.84, with
 * label=pass median 0.25 vs label=veto median 0.75 (gap +0.425).
 *
 * Fix: make the path env-selectable so prod can route the live pipeline through
 * the discriminative fact-check scorer. DEFAULT 1 (extractor) = byte-identical
 * to today — fully reversible; flipping to 2 is Sean-gated + Cowork co-sign
 * (it changes veto behavior under D-050 and adds cross-LLM latency/cost per
 * event — shadow first). Clamp avoids a malformed env silently selecting a
 * different level.
 */
export function resolveHalStrictness(): 1 | 2 {
  return process.env.HAL_STRICTNESS === '2' ? 2 : 1;
}

export function canonicalizeProvider(provider: string | null | undefined): string | null {
  if (!provider) return null;
  const clean = provider.toLowerCase().trim();
  if (clean.includes('gemini')) return 'gemini';
  if (clean.includes('anthropic') || clean.includes('claude')) return 'anthropic';
  if (clean.includes('openai') || clean.includes('gpt')) return 'openai';
  if (clean.includes('deepseek')) return 'deepseek';
  if (clean.includes('groq') || clean.includes('grok')) return 'groq';
  if (clean.includes('cerebras')) return 'cerebras';
  if (clean.includes('cohere')) return 'cohere';
  return clean;
}

/**
 * HONEST HAL PROVENANCE (2026-07-08). The hal_classifications.model column
 * previously HARDCODED 'deterministic-extractor' on EVERY row, so it lied about
 * which HAL path actually produced a verdict (124,990 rows all labelled
 * 'deterministic-extractor' even when a real cross-LLM fact-check quorum ran —
 * flagged by the 06-28 BCBV blind pass). This maps the real path — from the
 * SAME signals the score event records (halMode + quorumMet) — to an honest
 * label:
 *   - hal-error-fallback          : HAL threw; neutral 0.5 fail-soft (no real classification).
 *   - fact-check-quorum[:fams]     : cross-LLM fact-check ran AND >= 2 independent families agreed
 *                                    (the trustworthy path); families appended when known.
 *   - fact-check-partial           : fact-check ran but no >= 2-family quorum formed.
 *   - extractor-fallback           : fact-check path degraded to the deterministic extractor.
 *   - deterministic-extractor      : the strictness-1 style extractor genuinely ran (honest here).
 * Pure + deterministic → unit-testable without DB/HAL mocks.
 */
export function halClassificationModelLabel(args: {
  halError: string | null | undefined;
  halMode: string | undefined;
  quorumMet: boolean;
  families?: unknown;
}): string {
  if (args.halError) return 'hal-error-fallback';
  if (args.halMode === 'fact-check') {
    if (args.quorumMet) {
      const famList = Array.isArray(args.families)
        ? args.families.map((f) => String(f)).filter(Boolean)
        : [];
      return famList.length ? `fact-check-quorum:${famList.join('+')}` : 'fact-check-quorum';
    }
    return 'fact-check-partial'; // fact-check ran but no >= 2-family quorum formed
  }
  if (args.halMode === 'extractor-fallback') return 'extractor-fallback';
  // strictness-1 path (halMode 'extractor' or unset) is the real deterministic extractor.
  return 'deterministic-extractor';
}

export interface ScoreEventInput {
  agent_id: string;
  prompt: string;
  answer: string;
  provider_used?: string;
  tier_used?: string;
  model_used?: string;
  llm_call_id?: string;
  task_domain?: string;
  certainty?: number;
  idempotency_key?: string;
  contract_id?: string;
  /** P2 proof-carrying answer (optional) — enables the HAL grounding / abstain signal (shadow-first). */
  proof_carrying_answer?: ProofCarryingAnswer;
}

export interface ScoreEventResult {
  score_event_id: number;
  hal_score: number;
  hal_decision: HALDecision;
  signals: Record<string, unknown>;
  repid_delta_calculated: number;
  repid_delta_applied: number;
  old_repid: number;
  new_repid: number;
  zk_proof_triggered: boolean;
  zk_proof_id: string | null;
  reason: string;
  idempotent_replay?: boolean;
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export function deriveHalDecision(hal_score: number, vetoed: boolean, comma_severity?: string | null): HALDecision {
  // vetoed boolean OR critical Comma BFT severity → 'vetoed'
  if (vetoed || comma_severity === 'critical') {
    return 'vetoed';
  }
  // borderline (no penalty applied, but flagged for monitoring)
  if (hal_score >= 0.40) {
    return 'flagged';
  }
  // clean (positive RepID delta)
  return 'clean';
}

async function loadAgent(agentId: string): Promise<{
  id: string;
  current_repid: number;
  tier: string;
  vesting_cliff_active: boolean;
  /** Needed by decay — see scoring/decay-bridge.ts. */
  activity_30d: number;
} | null> {
  const { data, error } = await db
    .from('repid_agents')
    .select('id, current_repid, tier, vesting_cliff_ends_at, activity_30d')
    .eq('id', agentId)
    .single();
  if (error || !data) return null;
  const cliffEnds = (data as any).vesting_cliff_ends_at;
  const vesting_cliff_active =
    typeof cliffEnds === 'string' && new Date(cliffEnds).getTime() > Date.now();
  return {
    id: (data as any).id,
    current_repid: Number((data as any).current_repid ?? STARTING_REPID),
    tier: String((data as any).tier ?? 'PROBATIONARY'),
    vesting_cliff_active,
    activity_30d: Number((data as any).activity_30d ?? 0),
  };
}

async function loadExistingByKey(key: string): Promise<ScoreEventResult | null> {
  const { data, error } = await db
    .from('repid_score_events')
    .select(
      'id, hal_score, hal_decision, metadata, repid_delta_calculated, repid_delta_applied, repid_before, repid_after, zk_proof_triggered, zk_proof_id'
    )
    .eq('idempotency_key', key)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as any;
  return {
    score_event_id: Number(row.id),
    hal_score: Number(row.hal_score ?? 0),
    hal_decision: (row.hal_decision ?? 'clean') as HALDecision,
    signals: (row.metadata && row.metadata.hal_signals) ?? {},
    repid_delta_calculated: Number(row.repid_delta_calculated ?? row.repid_after - row.repid_before),
    repid_delta_applied: Number(row.repid_delta_applied ?? row.repid_after - row.repid_before),
    old_repid: Number(row.repid_before ?? 0),
    new_repid: Number(row.repid_after ?? 0),
    zk_proof_triggered: Boolean(row.zk_proof_triggered),
    zk_proof_id: row.zk_proof_id ?? null,
    reason: 'idempotent replay',
    idempotent_replay: true,
  };
}

async function shouldTriggerProof(agentId: string, deltaMagnitude: number): Promise<boolean> {
  if (deltaMagnitude >= 5) return true;
  const { count } = await db
    .from('repid_score_events')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId);
  // Trigger every 10th event (count is the count BEFORE this insert).
  return typeof count === 'number' && count > 0 && (count + 1) % 10 === 0;
}

export async function runScoreEvent(
  input: ScoreEventInput
): Promise<ScoreEventResult> {
  // 1. Idempotency check.
  if (input.idempotency_key) {
    const existing = await loadExistingByKey(input.idempotency_key);
    if (existing) return existing;
  }

  // 2. Load agent.
  const agent = await loadAgent(input.agent_id);
  if (!agent) {
    throw new NotFoundError(`Agent not found: ${input.agent_id}`);
  }

  // 3. HAL evaluation. DEFAULT (HAL_STRICTNESS unset → 1): extractor-only path,
  //    synchronous, no LLM fan-out — byte-identical to the prior behavior. But
  //    the extractor has NO discriminative power (see resolveHalStrictness): it
  //    is why live HAL catches 0 hallucinations. With HAL_STRICTNESS=2 the
  //    pipeline routes through the cross-LLM FACT-CHECK scorer (halService),
  //    which actually separates truth from hallucination (F1 0.77 on the
  //    labeled corpus). The flip is Sean-gated + Cowork co-sign (shadow first).
  //
  // Runtime config (2026-07-05): the HAL knobs (strictness, per-provider
  // enablement, quorum gates) resolve from repid_config → env → default via
  // getHalConfig() so they can be changed from mobile/SQL with NO redeploy.
  // Fail-safe: getHalConfig never throws (falls back to env/default). When
  // HAL_CONFIG_FROM_DB=false it ignores the DB entirely (env/default only), so
  // the resolved values equal the prior resolveHalStrictness()/env reads.
  const halConfig = await getHalConfig();
  const halStrictness = halConfig.strictness;
  let hal_score = 0.5;
  let vetoed = false;
  let signals: Record<string, unknown> = {};
  let halError: string | null = null;
  // A REWARD REQUIRES A PROVIDER — set when HalService established that ZERO providers succeeded
  // behind a 'clean'. See `applyProviderEvidenceGuard` in src/hal/service.ts for the measurement.
  let rewardEvidenceMissing = false;
  try {
    if (halStrictness >= 2) {
      // Discriminative path — providers built by halService; falls back to the
      // extractor internally when no provider responds (degraded, not silent).
      const r = await halService.evaluate({
        text: input.answer,
        context: { domain: input.task_domain ?? 'finance', certainty: typeof input.certainty === 'number' ? input.certainty : 0.85 },
        strictness: 2,
        // repid_config-driven provider enablement (no redeploy). Falls back to
        // the singleton's env-based set inside HalService when omitted.
        providersFn: () => buildFactCheckProvidersWith({
          groq: halConfig.providers.HAL_S2_ENABLE_GROQ,
          cerebras: halConfig.providers.HAL_S2_ENABLE_CEREBRAS,
          fireworks: halConfig.providers.HAL_S2_ENABLE_FIREWORKS,
          deepseek: halConfig.providers.HAL_S2_ENABLE_DEEPSEEK,
          gemini: halConfig.providers.HAL_S2_ENABLE_GEMINI,
          mistral: halConfig.providers.HAL_S2_ENABLE_MISTRAL,
          qwen: halConfig.providers.HAL_S2_ENABLE_QWEN,
          // openrouter is not (yet) a repid_config knob; it rides the HAL_QUORUM_AUTOBACKFILL
          // default (key-present → included). Explicit opt-in via HAL_S2_ENABLE_OPENROUTER env.
          openrouter: process.env.HAL_S2_ENABLE_OPENROUTER === 'true',
        }),
      });
      hal_score = Number.isFinite(r.hal_score) ? r.hal_score : 0.5;
      vetoed = r.decision === 'vetoed';
      rewardEvidenceMissing = r.reward_suppressed !== undefined;
      signals = { ...(r.signals as Record<string, unknown>), hal_mode: r.mode, hal_strictness: 2 };
    } else {
      const result = await evaluate(input.answer, input.answer, {
        domain: input.task_domain ?? 'finance',
        certainty: typeof input.certainty === 'number' ? input.certainty : 0.85,
        strictness: 1,
      });
      hal_score = Number.isFinite(result.hal_score) ? result.hal_score : 0.5;
      vetoed = !!result.vetoed;
      signals = result.signals as unknown as Record<string, unknown>;
    }
  } catch (e: unknown) {
    // Graceful by default; HAL_STRICT_MODE=true rethrows so a measurement run
    // never records a degraded score as a baseline.
    strictModeOrFallback('runScoreEvent.evaluate', e, () => {
      halError = e instanceof Error ? e.message : String(e);
      signals = { error: 'hal_failure', message: halError };
      hal_score = 0.5;
      vetoed = false;
    });
  }

  const decision: HALDecision = halError ? 'flagged' : deriveHalDecision(hal_score, vetoed, signals.comma_severity as string | null);

  // hallucination_caught: TRUE only when the DISCRIMINATIVE fact-check path (strictness 2) grounded
  // the veto in actual provider FALSE verdicts. The strictness-1 extractor is style-only (no ground
  // truth; AUC ~0.36 on the labeled corpus), so its vetoes are NOT caught hallucinations and must not
  // drain the live score. Mirrors the column the event-log guard trg_hal_penalty_guard checks.
  //
  // R4 — PENALTY REQUIRES QUORUM. A negative penalty may apply ONLY when the fact-check path actually
  // assembled >= 2 independent providers that agreed on the veto (single-provider AUC 0.36-0.78 vs
  // quorum AUC 0.92). When the quorum can't assemble (providers throttled → halService returns
  // mode 'extractor-fallback' with providers_used absent), we FAIL SAFE: no penalty, logged
  // 'quorum_unavailable' — NEVER a single-provider/extractor drain. This stops the live over-flag
  // (2026-06-03: 35 deepinfra extractor-fallback drains/15m, identical hal_score 0.265, providers_used
  // null). Reversible via HAL_PENALTY_REQUIRES_QUORUM (default ON).
  const penaltyRequiresQuorum = halConfig.penaltyRequiresQuorum;
  const QUORUM_MIN = 2;
  const halMode = signals.hal_mode as string | undefined; // 'fact-check' | 'extractor' | 'extractor-fallback'
  const providersUsed = Number((signals as Record<string, unknown>).providers_used ?? 0);
  // R5 — count DISTINCT FAMILIES (groq-Llama + cerebras-Llama = 1). Falls back to host count if the
  // fact-check result predates families_used. Revert to host count via HAL_QUORUM_FAMILY_AWARE=false.
  const familyAware = process.env.HAL_QUORUM_FAMILY_AWARE !== 'false';
  const familiesUsed = Number((signals as Record<string, unknown>).families_used ?? providersUsed);
  const quorumCount = familyAware ? familiesUsed : providersUsed;
  const quorumMet = halMode === 'fact-check' && quorumCount >= QUORUM_MIN;
  const groundedVeto = !halError && halStrictness >= 2 && decision === 'vetoed';
  const quorumUnavailable = groundedVeto && penaltyRequiresQuorum && !quorumMet;
  const hallucination_caught = groundedVeto && (penaltyRequiresQuorum ? quorumMet : true);

  // HONEST-HAL (2026-06-04): the blind style-extractor (strictness 1; AUC ~0.375 < chance on the
  // 109-case labeled corpus [report CC 06-03]) must NOT drive the HAL decision OR the RepID delta —
  // in either direction. The drain-gate above already suppresses the extractor's NEGATIVE delta, but
  // its 'clean' verdict still granted a POSITIVE reward (computeDelta clean → +1..+5) and its label
  // still wrote 'vetoed'/'clean' to the event row + downstream. Only a real cross-provider FACT-CHECK
  // QUORUM (mode 'fact-check' && >= QUORUM_MIN distinct families — quorumMet, computed above) is
  // decision-eligible. Without a quorum the scoring decision is NEUTRALIZED to 'flagged' (monitor,
  // zero applied delta via the drain-gate) and the extractor's raw decision is kept in metadata for
  // telemetry ONLY. Reversible via HAL_DECISION_REQUIRES_QUORUM (default ON). On a HAL failure we keep
  // the existing 'flagged' fail-soft (decision already 'flagged') — neutralization is a no-op there.
  const decisionRequiresQuorum = halConfig.decisionRequiresQuorum;
  // A REWARD REQUIRES A PROVIDER (2026-08-17) — the sign-flipped twin of the unearned veto.
  //
  // MEASURED on the frozen 395-row labelled corpus (`hal_runner_results`, hal_mode='fact-check-s2',
  // gen_failed=false), no-provider slice: HAL returned 'clean' on 18 rows, 9 of them labelled
  // hallucination — precision 0.5000 against a 0.5254 base rate, i.e. lift 0.95 and no information.
  // At the recorded hal_scores those 18 rows mint +37.4 RepID through computeDelta's clean branch.
  //
  // WHY THIS IS NOT REDUNDANT WITH THE QUORUM GATE ABOVE, even though it currently overlaps it:
  // `decisionRequiresQuorum` is resolved from a `repid_config` ROW (verified 'true' on 2026-08-17),
  // so it is one UPDATE away from off, and it asks a DIFFERENT question — "did >= 2 families vote?"
  // rather than "did ANY provider succeed?". This one is the floor under that ceiling: whatever the
  // quorum policy is set to, a verdict reached with zero provider successes never pays.
  //
  // It NEVER produces a penalty. It substitutes the decision that goes INTO computeDelta (the
  // established pattern here, and the one the ZKP delta witness records) rather than reaching into
  // the formula, so `checkConsistency` still recomputes the stored delta from the stored decision.
  const rewardUnearned = rewardEvidenceMissing && !halError && decision === 'clean';
  const decisionNeutralized =
    (decisionRequiresQuorum && !quorumMet && !halError && decision !== 'flagged') || rewardUnearned;
  const scoringDecision: HALDecision = decisionNeutralized ? 'flagged' : decision;

  // 4. Compute delta. Driven by the QUORUM-eligible scoringDecision, never the raw extractor decision.
  const delta = computeDelta({
    hal_score,
    hal_decision: scoringDecision,
    current_repid: agent.current_repid,
    agent_tier: agent.tier,
    vesting_cliff_active: agent.vesting_cliff_active,
  });

  // S-DRAIN (Phase 3): gate the DIRECT current_repid apply on hallucination_caught, mirroring the
  // event-log guard trg_hal_penalty_guard. A negative HAL delta only drains the live score when a
  // hallucination was actually caught; blind-extractor style vetoes are suppressed (applied 0).
  // Reversible via HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION (default ON). Without this gate the
  // trigger protected only the audit log while the app still wrote old_repid-10 to repid_agents,
  // pinning live agents to the tier floor while peak_repid stayed 2-3x higher.
  const penaltyRequiresHallucination = process.env.HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION !== 'false';
  let effectiveDeltaApplied = delta.delta_applied;
  let penaltySuppressed = false;
  if (penaltyRequiresHallucination && effectiveDeltaApplied < 0 && !hallucination_caught) {
    effectiveDeltaApplied = 0;
    penaltySuppressed = true;
  }
  // A2: a grounded veto neutralized for lack of quorum is also a suppressed penalty for
  // observability — the would-be -10 didn't apply. (After A2, scoringDecision='flagged' computes
  // to 0 directly rather than -2-then-suppress, so set the flag explicitly to keep the metadata
  // — suppressed_reason='quorum_unavailable', penalty_suppressed=true — stable.)
  if (quorumUnavailable) penaltySuppressed = true;

  // PURPOSE GATE (REPID_HONEST_SCORING_v1): a HAL veto only moves RepID on REAL deliverables.
  // Internal cron / DB-fact / adversarial drills / peer-verify are NOT hallucination-veto surfaces
  // (cross-LLM has no ground truth for "count tasks by status"). This is w_purpose in the §7.1 chain.
  // Reversible via REPID_PURPOSE_GATE_ENABLED. Suppressed penalties are logged (telemetry kept).
  const purposeGateEnabled = process.env.REPID_PURPOSE_GATE_ENABLED !== 'false';
  // v3 (CC-2) tail non-deliverable domains ride the SAME purpose gate but behind their own
  // SHADOW-FIRST sub-flag REPID_PURPOSE_GATE_V3 (default OFF) so merging changes NO live scoring
  // delta by default. Flip to true only after the GA-1 --no-floor replay clears the go-live gate.
  const purposeGateV3 = process.env.REPID_PURPOSE_GATE_V3 === 'true';
  const purposeVerdict = classifyTaskPurpose(input.task_domain, input.prompt, purposeGateV3);
  let purposeSuppressed = false;
  if (purposeGateEnabled && effectiveDeltaApplied !== 0 && !purposeVerdict.halVetoApplies) {
    // Symmetric w_purpose (XC asymmetry red-team): a non-deliverable purpose zeroes the HAL delta in
    // BOTH directions — a chore must be neither punished NOR rewarded by HAL scoring. This previously
    // gated on `< 0`, so a HAL-clean chore (+1..+5 under strictness 2) still earned RepID while the
    // -10 was suppressed — a one-way gate that let fake work be rewarded. weight 0 → 0 either direction.
    const wasPenalty = effectiveDeltaApplied < 0;
    effectiveDeltaApplied = Math.round(effectiveDeltaApplied * purposeVerdict.weight);
    purposeSuppressed = true;
    if (wasPenalty) penaltySuppressed = true; // keep penalty-specific S-DRAIN observability intact
  }

  // GROUNDING / ABSTAIN (proof-carrying retrieval P2) — SHADOW-FIRST via HAL_GROUNDING_MODE.
  // If the answer carries a proof-carrying binding, verify it. 'shadow' (default) logs only;
  // 'enforce' (Sean GO, after measurement) neutralizes a POSITIVE delta when an answer CLAIMED
  // grounding but can't prove it (no proof ⇒ no reward). No current traffic carries a PCA →
  // applicable:false → byte-identical to today. Runs BEFORE new_repid so enforce can zero the delta.
  const gMode = groundingMode();
  const grounding = gMode === 'off'
    ? null
    : computeGroundingSignal({ proof_carrying_answer: input.proof_carrying_answer ?? null }, gMode);
  let groundingAbstained = false;
  if (grounding && grounding.mode === 'enforce' && grounding.applicable && grounding.would_abstain && effectiveDeltaApplied > 0) {
    effectiveDeltaApplied = 0; // claimed grounding, unprovable → earns nothing
    groundingAbstained = true;
  }

  const old_repid = agent.current_repid;
  // DECAY (Option C step 1). In shadow this computes the counterfactual and
  // changes nothing; only 'enforce' moves the score. The base is the decayed
  // score, so the delta lands on top of decay exactly as updateRepId did it.
  const decay = assessDecay({ currentRepid: old_repid, activity30d: agent.activity_30d });
  // Decompose the movement so the row can reconcile. See decay-bridge.ts::applyToScore
  // for why the base is rounded before the delta lands, and for the two ways the score
  // could move without appearing in repid_delta_applied (decay, and the #314 clamp).
  const applied = applyToScore({
    before: old_repid,
    decay,
    rawDelta: effectiveDeltaApplied,
    clamp: (raw) =>
      clampRepidLoud(raw, {
        agentId: String(input.agent_id),
        eventType: 'HAL_SCORE_EVENT',
      }),
  });
  const new_repid = applied.after;
  // Impossible by construction; a tripwire, not a branch. If it ever fires, the
  // decomposition and the stored row have diverged and the ledger is lying.
  if (!appliedScoreReconciles(applied)) {
    console.error(
      `[scoring/pipeline] LEDGER DOES NOT RECONCILE agent=${input.agent_id} ` +
        `before=${applied.before} after=${applied.after} decay=${applied.decay_points} ` +
        `delta=${applied.delta_points} clamp=${applied.clamp_points} ` +
        `total_applied=${applied.total_applied} — repid_delta_applied will not equal the movement.`
    );
  }

  // 5. ZK proof trigger logic (decided pre-insert so we can record on the row).
  //
  // runScoreEvent ALWAYS emits event_type='HAL_SCORE_EVENT' — internal-scoring
  // proof churn (Beat 8: ~99.3% of repid_proof_queue). The producer-side filter
  // (PROOF_ENQUEUE_HAL_MODE, shadow-first) can suppress that churn so a future
  // proof-drain restart yields a clean, gas-worthy economic set. Folding it into
  // the trigger keeps the score-event row, zk_proof_id, and the enqueue all
  // consistent — no "triggered but never queued" row. Economic events flow
  // through applyValidationEvent (below) and are untouched by this filter.
  const rawTriggerProof = await shouldTriggerProof(
    input.agent_id,
    Math.abs(delta.delta_applied)
  );
  const proofFilter = evaluateProofEnqueue(
    'HAL_SCORE_EVENT',
    parseProofEnqueueMode(process.env.PROOF_ENQUEUE_HAL_MODE)
  );
  if (rawTriggerProof && proofFilter.shadow) {
    console.log(
      '[scoring/pipeline] proof-enqueue filter: WOULD-SKIP HAL_SCORE_EVENT churn proof (shadow mode; set PROOF_ENQUEUE_HAL_MODE=enforce to gate)'
    );
  } else if (rawTriggerProof && proofFilter.skip) {
    console.log(
      '[scoring/pipeline] proof-enqueue filter: SKIP HAL_SCORE_EVENT churn proof (enforce mode)'
    );
  }
  const triggerProof = rawTriggerProof && !proofFilter.skip;
  const zk_proof_id = triggerProof ? crypto.randomUUID() : null;

  // 5b. ISSUER IDENTITY (additive, flag-gated, default OFF — see
  // src/scoring/issuer-identity.ts and
  // migrations/2026-08-17-issuer-identity-and-verdict-evidence.sql).
  //
  // A HAL verdict currently names nobody as its author: counterparty_agent_id
  // is NULL on every HAL_SCORE_EVENT row in production, so a wrong veto has no
  // issuer to charge and a right one has no issuer to credit.
  //
  // Two things this deliberately does NOT do:
  //   - it does not derive an identifier. The write site HAS no issuer identity
  //     (input.provider_used names the judged ANSWER's provider, not the judge),
  //     so the id comes from HAL_ISSUER_AGENT_ID or the row is written exactly
  //     as it is today.
  //   - it does not reuse `providersUsed` above. That value is
  //     `Number(signals.providers_used ?? 0)`, and the `?? 0` is why every
  //     stored zero in production means "not recorded" rather than "consulted
  //     nothing". The raw signal is passed through so absence stays NULL.
  //
  // With the flag off this resolves to `recorded: false` and insertPayload is
  // byte-identical to before this change.
  const issuer = resolveIssuerIdentity({
    subjectAgentId: String(input.agent_id),
    rawProvidersUsed: (signals as Record<string, unknown>).providers_used,
  });
  if (!issuer.recorded && issuer.reason !== 'disabled') {
    // Loud, because every non-'disabled' reason is a misconfiguration that
    // silently produces rows indistinguishable from the un-wired ones.
    console.warn(
      `[scoring/pipeline] issuer identity NOT recorded (${issuer.reason}) — ` +
        'HAL_ISSUER_IDENTITY_ENABLED is on; see src/scoring/issuer-identity.ts'
    );
  }

  // 6. Insert score event.
  const insertPayload: Record<string, unknown> = {
    agent_id: input.agent_id,
    event_type: 'HAL_SCORE_EVENT',
    // `delta` and `repid_delta_calculated` stay the delta the EVENT EARNED.
    // `repid_delta_applied` is what actually MOVED the score — the two diverge
    // exactly when decay or the clamp took a bite, and that divergence is the
    // audit signal, not a bug (repid-delta.ts header: calculated vs applied).
    delta: applied.delta_points,
    repid_before: applied.before,
    repid_after: applied.after,
    certainty_at_claim:
      typeof input.certainty === 'number' ? input.certainty : 0.85,
    contract_id: input.contract_id ?? null,
    llm_provider: canonicalizeProvider(input.provider_used),
    llm_model: input.model_used ?? null,
    hal_score,
    hal_decision: scoringDecision,
    hallucination_caught,
    repid_delta_calculated: Math.round(delta.delta_calculated),
    repid_delta_applied: applied.total_applied,
    tier_used: input.tier_used ?? null,
    prompt_text: input.prompt,
    answer_text: input.answer,
    llm_call_id: input.llm_call_id ?? null,
    task_domain: input.task_domain ?? null,
    decision_outcome: scoringDecision,
    zk_proof_triggered: triggerProof,
    zk_proof_id,
    idempotency_key: input.idempotency_key ?? null,
    metadata: {
      // Decay counterfactual (Option C step 1). In shadow this is the ONLY trace —
      // the score is untouched — so it must be recorded or the measurement is lost.
      ...decayMetadata(decay),
      // The decomposition behind repid_delta_applied. Without it a reader can see
      // that the delta and the movement differ but not which component did it.
      ...appliedScoreMetadata(applied),
      hal_signals: signals,
      grounding: grounding ?? undefined,
      grounding_abstained: groundingAbstained,
      hal_error: halError,
      delta_reason: penaltySuppressed
        ? `${delta.reason} (S-DRAIN: penalty suppressed — ${quorumUnavailable ? 'quorum_unavailable' : 'no_hallucination_caught'})`
        : delta.reason,
      vesting_cliff_active: agent.vesting_cliff_active,
      block_threshold_used: HAL_CONSTITUTIONAL_BLOCK_THRESHOLD,
      penalty_suppressed: penaltySuppressed,
      purpose: purposeVerdict.purpose,
      purpose_suppressed: purposeSuppressed,
      purpose_reason: purposeSuppressed ? purposeVerdict.reason : null,
      // R4 — quorum evidence: every APPLIED penalty must show >= 2 providers here.
      quorum_met: quorumMet,
      quorum_providers_used: providersUsed,
      quorum_families_used: familiesUsed,
      quorum_families: (signals as Record<string, unknown>).families ?? null,
      hal_mode: halMode ?? null,
      // HONEST-HAL — decision provenance. scoringDecision (the recorded hal_decision) is quorum-only;
      // extractor_decision is the blind style-extractor's raw call, kept for telemetry ONLY.
      decision_source: quorumMet
        ? 'fact-check-quorum'
        : rewardUnearned
          ? 'neutralized-no-provider-evidence'
          : 'neutralized-no-quorum',
      decision_neutralized: decisionNeutralized,
      // Distinguishes "no 2-family quorum" from "no provider succeeded at all" in the audit trail.
      // Without it the two collapse into one `decision_neutralized: true` and the stronger finding
      // — a verdict issued having consulted nothing — is unrecoverable from the ledger.
      reward_unearned: rewardUnearned,
      extractor_decision: decision,
      ...(penaltySuppressed || purposeSuppressed
        ? {
            suppressed_reason: purposeSuppressed ? ('wrong_task_purpose:' + purposeVerdict.purpose) : (quorumUnavailable ? 'quorum_unavailable' : 'no_hallucination_caught'),
            original_delta: Math.round(delta.delta_applied),
          }
        : {}),
    },
    // Spread LAST and only when resolved. The three columns do not exist until
    // the 2026-08-17 migration is applied, so naming them while the flag is off
    // would break every insert — the flag and the migration are coupled in that
    // direction and only that direction.
    ...(issuer.recorded ? issuer.fields : {}),
  };

  const { data: eventRow, error: evErr } = await db
    .from('repid_score_events')
    .insert(insertPayload)
    .select('id')
    .single();

  if (evErr || !eventRow) {
    throw new Error(`score event insert failed: ${evErr?.message ?? 'unknown'}`);
  }
  const score_event_id = Number((eventRow as any).id);

  // ZKP RepID — build the delta statement for this event. Gated by
  // REPID_DELTA_STATEMENT_MODE (default `off`, so this is a single early return today).
  // Placed AFTER the event insert so the nullifier can be scoped to a real event id,
  // and detached so an audit artefact can never delay or fail a score write.
  recordDeltaStatementDetached({
    agentId: String(input.agent_id),
    eventLabel: `score_event:${score_event_id}`,
    // The STORED integers — matching what went into the row above, not the
    // pre-rounding floats. The statement attests to the ledger, so it takes the
    // same total_applied the row does; attesting the HAL delta would have the
    // proof claim a movement the score never made.
    deltaApplied: applied.total_applied,
    scoreBefore: applied.before,
    scoreAfter: applied.after,
    halScore: hal_score,
    halDecision: scoringDecision as HALDecision,
    agentTier: agent.tier,
    vestingCliffActive: agent.vesting_cliff_active,
  });

  // S-HARDEN Phase 3 — audit the HAL evaluation as a tool call (gated by TOOL_CALL_LOGGING; no-op default; never throws).
  void logToolCall({
    agentName: 'hal-pipeline',
    toolName: 'hal-evaluate',
    toolInput: { agent_id: input.agent_id, provider: input.provider_used ?? null },
    toolOutput: { hal_score, hal_decision: decision, score_event_id },
    repidAtCall: old_repid,
    confidenceAtCall: Number((signals as any).certainty_at_claim ?? 0.5),
    autonomyTier: 'just_do_it',
  });

  // Write to hal_classifications to record the HAL inference so /api/v1/hal/stats reports it
  try {
    const promptHash = crypto.createHash('sha256').update(input.prompt).digest('hex').slice(0, 32);
    const categoryMapping: Record<string, string> = {
      'factual': 'factual',
      'opinion': 'opinion',
      'math': 'math',
      'code': 'code',
      'creative': 'creative',
      'time-sensitive': 'time-sensitive'
    };
    const taskTypeClean = String(input.task_domain || '').toLowerCase().trim();
    const category = categoryMapping[taskTypeClean] || 'factual';

    // HONEST PROVENANCE (2026-07-08): this row previously HARDCODED
    // model='deterministic-extractor' on EVERY inference, so anyone reading
    // hal_classifications saw "extractor" even when a real cross-LLM fact-check
    // quorum produced the verdict (the 06-28 BCBV blind pass flagged exactly
    // this: 609/609 rows labelled deterministic-extractor). Record the ACTUAL
    // path that ran, from the same signals the score event uses (halMode +
    // quorumMet), so the label matches the truth already in the event metadata
    // (decision_source / hal_mode).
    const halModelLabel = halClassificationModelLabel({
      halError,
      halMode,
      quorumMet,
      families: (signals as Record<string, unknown>).families,
    });

    await db.from('hal_classifications').insert({
      prompt_hash: promptHash,
      category,
      confidence: 'high',
      latency_ms: 0,
      provider: canonicalizeProvider(input.provider_used) || 'trinity-task-bridge',
      model: halModelLabel,
    });
  } catch (err: any) {
    console.warn('[scoring/pipeline] Failed to write to hal_classifications:', err.message);
  }

  // 7. Update agent state (gated by WRITER_DIRECT_APPLY for single-applier cutover).
  // When false: insert event only (with full audit fields + idempotency_key); aggregator becomes sole applier.
  const WRITER_DIRECT_APPLY = process.env.WRITER_DIRECT_APPLY !== 'false';
  if (WRITER_DIRECT_APPLY) {
    await db
      .from('repid_agents')
      .update({
        current_repid: Math.round(new_repid),
        last_active_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      })
      .eq('id', input.agent_id);
  } else {
    // Event already written above with repid_before/after + delta. Aggregator will apply from watermark.
  }

  // 8. Queue ZK proof job (best-effort; failures don't block).
  if (triggerProof && zk_proof_id) {
    db.from('repid_proof_queue')
      .insert({
        job_id: zk_proof_id,
        agent_id: input.agent_id,
        event_id: score_event_id,
        status: 'pending',
        zkp_service_url: process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app',
      })
      .then(
        () => {
          fetch(`${process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app'}/zkp/repid-proof`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              agent_id: input.agent_id, 
              score: Math.round(new_repid),
              metadata: { job_id: zk_proof_id }
            })
          }).catch(err => console.error('[scoring/pipeline] proof service call failed:', err));
        },
        (err: unknown) => console.error('[scoring/pipeline] proof queue insert failed:', err)
      );
  }

  // 9. Leaderboard refresh — repid_leaderboard_public is a regular VIEW
  //    (not materialized) per Phase 1 schema query, so no refresh needed.

  return {
    score_event_id,
    hal_score,
    hal_decision: scoringDecision,
    signals,
    repid_delta_calculated: delta.delta_calculated,
    // The STORED applied delta, not the pre-decay/pre-clamp float. Callers surface
    // this as `repid_delta` on the API (routes/route.ts, agents-external-score.ts);
    // returning the earned delta there would report a movement the score never made.
    repid_delta_applied: applied.total_applied,
    old_repid,
    new_repid: Math.round(new_repid),
    zk_proof_triggered: triggerProof,
    zk_proof_id,
    reason: penaltySuppressed
      ? `${delta.reason} (S-DRAIN: penalty suppressed — no hallucination_caught)`
      : delta.reason,
  };
}

export async function applyValidationEvent(
  agent_id: string,
  event_type: 'VALIDATION_PASSED' | 'VALIDATION_FAILED' | 'VALIDATOR_REWARD' | 'VALIDATOR_PENALTY' | 'SERVICE_FULFILLED' | 'SERVICE_SATISFIED' | 'SERVICE_OUTCOME',
  delta: number,
  metadata: Record<string, any> = {},
  halOverride?: { hal_score: number; hal_decision: HALDecision; hal_signals?: any }
) {
  const agent = await loadAgent(agent_id);
  if (!agent) throw new Error(`Agent not found: ${agent_id}`);

  const old_repid = agent.current_repid;
  const decay = assessDecay({ currentRepid: old_repid, activity30d: agent.activity_30d });
  const decayBase = decayedScoreFor(decay);
  // Was Math.max(0, …): floor 0 against a DB floor of 10, and no ceiling at all.
  const new_repid = clampRepidLoud(decayBase + delta, {
    agentId: String(agent_id),
    eventType: event_type,
  });

  const triggerProof = await shouldTriggerProof(agent_id, Math.abs(delta));
  const zk_proof_id = triggerProof ? crypto.randomUUID() : null;

  // HAL enrichment (2026-05-22): callers may pass real HAL via halOverride.
  // Default (no override) preserves the prior 0.5/clean placeholder so the
  // existing 4-arg callers are byte-for-byte unchanged. decision_outcome now
  // tracks hal_decision (was always 'clean'); with no override it stays 'clean'.
  let certaintyAtClaim: number | null = null;
  let halScore = halOverride?.hal_score ?? 0.5;
  let halDecision: HALDecision = halOverride?.hal_decision ?? 'clean';
  let enrichedMetadata = halOverride?.hal_signals
    ? { ...metadata, hal_signals: halOverride.hal_signals }
    : metadata;

  const answerText = metadata?.answer_text || null;
  const promptText = metadata?.prompt_text || null;
  const taskDomain = metadata?.task_domain || 'finance';

  if (answerText && answerText.trim()) {
    try {
      const signals = extractHALSignals({
        text: answerText,
        domain: taskDomain,
        certainty: typeof halOverride?.hal_signals?.certainty_at_claim === 'number'
          ? halOverride.hal_signals.certainty_at_claim
          : (typeof metadata?.certainty === 'number'
              ? metadata.certainty
              : (typeof metadata?.certainty_at_claim === 'number'
                  ? metadata.certainty_at_claim
                  : 0.85))
      });
      certaintyAtClaim = signals.certainty_at_claim;
      
      if (!halOverride) {
        const scoreVal = (
          0.4 * signals.harm_probability +
          0.3 * signals.epistemic_uncertainty +
          0.2 * (1 - signals.evidence_quality) +
          0.1 * (1 - signals.scope_appropriateness)
        ) * (531441 / 524288);
        halScore = Math.min(1, scoreVal);
        halDecision = deriveHalDecision(halScore, halScore >= 0.25);
        enrichedMetadata = {
          ...metadata,
          hal_signals: signals
        };
      } else {
        certaintyAtClaim = typeof halOverride.hal_signals?.certainty_at_claim === 'number'
          ? halOverride.hal_signals.certainty_at_claim
          : 0.85;
      }
    } catch (err: any) {
      // Graceful by default (continue with override/defaults); HAL_STRICT_MODE
      // =true rethrows so extractor failures fail loudly during measurement.
      strictModeOrFallback('applyValidationEvent.extractHALSignals', err, () => {
        console.error('[applyValidationEvent] Failed to run extractHALSignals:', err.message);
      });
    }
  } else if (halOverride?.hal_signals) {
    certaintyAtClaim = typeof halOverride.hal_signals.certainty_at_claim === 'number'
      ? halOverride.hal_signals.certainty_at_claim
      : null;
  }

  // MONEY-PATH GATE (shadow-first; MONEY_PATH_GATE_MODE default 'shadow').
  //
  // This is the audit's 🔴 leak: applyValidationEvent applied the RAW caller
  // `delta` straight to current_repid with no quorum/purpose gate. The deterministic
  // Policy Gate (src/kernel/policy-gate.ts) is the single authorizer. In SHADOW we
  // only MEASURE what it would authorize (recorded on the event); in ENFORCE (after
  // the trust_receipts table + a measurement window, Sean GO) we apply
  // gate.authorized_delta instead of the raw delta. Never affects the write here.
  let gate_shadow: Record<string, unknown> | undefined;
  try {
    const _mode = moneyPathGateMode();
    if (_mode !== 'off') {
      const isSettlement =
        event_type === 'SERVICE_FULFILLED' || event_type === 'SERVICE_SATISFIED' || event_type === 'VALIDATION_PASSED';
      const g = evaluateEconomicMove({
        delta,
        settled_receipt_id: 'shadow', // measures evidence-gating; real receipt precondition tracked by receipt_present
        hal: {
          // The gate's decision union is clean|flagged|vetoed; the engine's HALDecision
          // also has 'abstain' → map it to 'flagged' (advisory, non-authorizing) for the gate.
          decision: halDecision === 'clean' || halDecision === 'vetoed' ? halDecision : 'flagged',
          hal_score: typeof halScore === 'number' ? halScore : undefined,
          providers_succeeded: Number((halOverride?.hal_signals as any)?.providers_used ?? 0),
        },
        settlement_confirmed: isSettlement,
        subject_n: 1, // proxy until the RepID ω lens lands (measures evidence gates, not zero-evidence)
        subject_u: 0.2,
        is_deliverable: isSettlement,
      });
      gate_shadow = {
        mode: _mode,
        receipt_present: false, // trust_receipts not yet wired — enforce stays blocked until it is
        would_decision: g.decision,
        would_authorize_delta: g.authorized_delta,
        raw_delta: Math.round(delta),
        diverges: g.authorized_delta !== Math.round(delta),
        reasons: g.reasons,
        note: 'subject_n/u are placeholders until the RepID lens lands',
      };
    }
  } catch {
    /* shadow measurement must never affect the score write */
  }

  const insertPayload = {
    agent_id,
    event_type,
    delta: Math.round(delta),
    repid_before: old_repid,
    repid_after: Math.round(new_repid),
    certainty_at_claim: certaintyAtClaim,
    hal_score: halScore,
    hal_decision: halDecision,
    repid_delta_calculated: Math.round(delta),
    repid_delta_applied: Math.round(new_repid - old_repid),
    zk_proof_triggered: triggerProof,
    zk_proof_id,
    decision_outcome: halDecision,
    metadata: { ...decayMetadata(decay), ...(enrichedMetadata as Record<string, unknown>), ...(gate_shadow ? { gate_shadow } : {}) },
    contract_id: metadata?.contract_id ?? null,
    // Lifted out of metadata onto its own column, exactly as contract_id above is. This
    // writer bypasses insertScoreEvent(), so its self-check is repeated rather than
    // inherited: a self-counterparty would otherwise hit the DB CHECK as a 23514 and, since
    // this function throws on insert error, take the whole delta down with it.
    counterparty_agent_id:
      metadata?.counterparty_agent_id && metadata.counterparty_agent_id !== agent_id
        ? metadata.counterparty_agent_id
        : null,
    answer_text: answerText,
    prompt_text: promptText,
    task_domain: taskDomain,
  };

  const { data: eventRow, error: evErr } = await db
    .from('repid_score_events')
    .insert(insertPayload)
    .select('id')
    .single();

  if (evErr) throw new Error(`score event insert failed: ${evErr.message}`);

  const score_event_id = (eventRow as any).id;

  // ZKP RepID — same wire on the second write site. This path carries a raw `delta`
  // rather than one from computeDelta, so in `shadow` it is the site most likely to
  // report an inconsistency — which is the point: an event whose delta did not come
  // from the formula is exactly what the statement is meant to surface.
  recordDeltaStatementDetached({
    agentId: String(agent_id),
    eventLabel: `score_event:${score_event_id}`,
    deltaApplied: Math.round(new_repid - old_repid),
    scoreBefore: old_repid,
    scoreAfter: Math.round(new_repid),
    halScore: typeof halScore === 'number' ? halScore : 0.5,
    halDecision: (halDecision ?? 'clean') as HALDecision,
    agentTier: String((agent as any).tier ?? 'ESTABLISHED'),
    vestingCliffActive: Boolean((agent as any).vesting_cliff_active),
  });

  // Gated by WRITER_DIRECT_APPLY for the single-applier cutover (D-054). When false: insert-event-only
  // (the event row above carries delta + repid_before/after); the aggregator applies it from the
  // watermark, so this SERVICE_FULFILLED path can't double-count after the flip. Mirrors runScoreEvent.
  const WRITER_DIRECT_APPLY = process.env.WRITER_DIRECT_APPLY !== 'false';
  if (WRITER_DIRECT_APPLY) {
    await db
      .from('repid_agents')
      .update({
        current_repid: Math.round(new_repid),
        last_active_at: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      })
      .eq('id', agent_id);
  }

  // Audit anchor for service-contract fulfilment. The
  // validation_queue path anchors at the queue level (validation-queue-
  // worker.ts); SERVICE_FULFILLED events flow through the service-contract
  // path (applyServiceFulfilledDeltas) which has no queue row, so the
  // anchor MUST happen here or hal_audit_chain has zero anchors for them.
  // Gated strictly to SERVICE_FULFILLED so the validation_queue events are
  // not double-anchored. Isolated try/catch: the score event is already
  // persisted; an anchor failure must NOT rethrow and falsely fail the
  // delta — but it is an audit surface, so it fails LOUDLY with a stack
  // (RULE-11), never silently. Mirrors validation-queue-worker.ts:171-189.
  if (event_type === 'SERVICE_FULFILLED') {
    try {
      await appendToAuditChain('repid_score_events', String(score_event_id), {
        event_type: 'SERVICE_FULFILLED',
        score_event_id,
        agent_id,
        role: metadata.role ?? null,
        contract_id: metadata.contract_id ?? null,
        service_id: metadata.service_id ?? null,
        delta: Math.round(delta),
        repid_before: old_repid,
        repid_after: Math.round(new_repid),
        hal_score: halScore,
        hal_decision: halDecision,
        phase_2_7_4_signature: true,
      });
    } catch (auditErr: any) {
      console.error(
        `[scoring/pipeline] hal_audit_chain append FAILED for repid_score_events ` +
          `${score_event_id} (SERVICE_FULFILLED recorded but NOT anchored — ` +
          `audit-surface gap):`,
        auditErr?.stack ?? auditErr
      );
    }
  }

  if (triggerProof && zk_proof_id) {
    db.from('repid_proof_queue')
      .insert({
        job_id: zk_proof_id,
        agent_id,
        event_id: (eventRow as any).id,
        status: 'pending',
        zkp_service_url: process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app',
      })
      .then(() => {
        fetch(`${process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app'}/zkp/repid-proof`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            agent_id, 
            score: Math.round(new_repid),
            metadata: { job_id: zk_proof_id }
          })
        }).catch((err: any) => console.error('[scoring/pipeline] proof service call failed:', err));
      }).then(undefined, (err: any) => console.error('[scoring/pipeline] proof queue insert failed:', err));
  }

  return { old_repid, new_repid, delta_applied: Math.round(new_repid - old_repid) };
}
