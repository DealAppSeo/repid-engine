/**
 * service-quality-hook.ts — ask HAL whether delivered work was any GOOD, on the
 * one path where real deliverable work actually happens.
 *
 * WHY THIS EXISTS [MEASURED 2026-09-04, recorded in scripts/sql/repid-ledger-audit.sql §8]
 * ------------------------------------------------------------------------------------
 * RepID is not mis-tuned, it is STARVED. Of 39,135 HAL scoring events since
 * 2026-07-01, exactly 81 (0.21%) carried `purpose: deliverable`, and the last
 * one was 2026-08-17. Everything else is the system evaluating itself —
 * peer-verify, cron chores, adversarial drills — which the purpose gate
 * correctly refuses to score in EITHER direction. No weight change fixes that.
 * Deliverable traffic does.
 *
 * Meanwhile the service-contract path is alive and paying: `trinity-nexus` took
 * +580 and `trinity-orch` +370 since August, through SERVICE_FULFILLED (+10) and
 * SERVICE_SATISFIED (+30), with events as recent as 2026-09-03. So the system
 * already pays for DELIVERY. It has never once asked about QUALITY:
 * `service-handler-base.ts` contains no HAL reference at all.
 *
 * This hook closes that, and it is deliberately the smallest thing that can:
 * `service_contract` is already the first entry in `DELIVERABLE_DOMAINS`, so
 * submitting the fulfilment artifact with `task_domain: 'service_contract'`
 * classifies as `purpose: deliverable` at weight 1.0 with no classifier change.
 *
 * WHY IT IS OFF BY DEFAULT AND SCOPED TO TWO AGENTS
 * ------------------------------------------------
 * Turning this on makes real agent reputation depend on a HAL verdict for the
 * first time. That is a scoring decision, not a cleanup, so it lands inert:
 * `SERVICE_QUALITY_HOOK_MODE` defaults to `off`, and even at `shadow` it is
 * restricted to an explicit agent allowlist. The default enrolment is the two
 * agents that actually deliver — nobody else can be affected by a flag flip
 * alone.
 *
 * THE THING THIS MUST NOT DO, AND THE REASON IT IS BUILT THIS WAY
 * --------------------------------------------------------------
 * A verdict nobody actually checked must never be recorded as a verdict. That
 * exact defect cost this system a 12-day outage (NOT_CHECKED scored as FAILED in
 * the cascade) and 25,299 false-positive penalties. Two guards here:
 *
 *   1. In SHADOW, where nothing downstream evaluates, it calls HAL at
 *      STRICTNESS 2 explicitly — the discriminative, provider-backed path. The
 *      strictness-1 style extractor is NOT decision-eligible (AUC ~0.375, below
 *      chance on the 109-case labelled corpus), and a quality signal built on it
 *      would manufacture exactly the unearned reward the pipeline's own guard
 *      exists to stop. In ENFORCE this module evaluates nothing: `runScoreEvent`
 *      does, at whatever strictness `getHalConfig()` resolves — so the guarantee
 *      there is the pipeline's, not this file's, and this file does not restate
 *      it as though it were its own.
 *   2. When the agent cannot be resolved, the artifact is empty, HAL throws, or
 *      HAL reports that ZERO providers succeeded (`reward_suppressed`, the
 *      shadow path's floor), the observation is `checked: false` WITH A REASON.
 *      It is never a pass, never a fail, and it never carries a `would_apply`
 *      number — because a number derived from no evidence is worse than no
 *      number: it is a number someone will quote.
 *
 * SHADOW MEANS SHADOW. In `shadow` this module reads the ledger and writes
 * nothing to it: the observation goes to `service_contracts.metadata`, beside
 * the artifact it describes. `repid_score_events` is not touched and no score
 * moves. Only `enforce` calls `runScoreEvent`.
 *
 * It NEVER throws. Fulfilment already succeeded and the buyer already has the
 * artifact by the time this runs; failing the contract because a quality probe
 * failed would turn an observability feature into an outage.
 */

import { db } from '../db';
import { halService } from '../hal/service';
import { buildFactCheckProviders } from '../hal/fact-check';
import { deriveHalDecision, runScoreEvent, type ScoreEventInput } from '../scoring/pipeline';
import { computeDelta, type HALDecision } from '../scoring/repid-delta';
import { classifyTaskPurpose } from '../scoring/task-purpose';

/** The task_domain that classifies as `purpose: deliverable`. Already in DELIVERABLE_DOMAINS. */
export const SERVICE_TASK_DOMAIN = 'service_contract';

export type ServiceQualityMode = 'off' | 'shadow' | 'enforce';

export interface ServiceQualityConfig {
  mode: ServiceQualityMode;
  /** Agent NAMES enrolled. Empty set means nobody, even in shadow. */
  agents: Set<string>;
}

/**
 * The two agents measured as actually delivering ON THIS PATH. Overridable via
 * SERVICE_QUALITY_HOOK_AGENTS, but the default is deliberately not "everyone" —
 * a flag flip should widen blast radius on purpose, never by omission.
 *
 * CORRECTED 2026-09-04. This list read `['trinity-nexus', 'trinity-orch']`, and
 * it was measured against the wrong ROLE. `trinity-nexus` is the most active
 * agent on service contracts — as the BUYER. As a provider it has fulfilled
 * exactly one contract, in early July. The hook resolves the agent by
 * `providerAgentId`, so nexus could never have been enrolled by it: every
 * fulfilment would have reported `agent_not_enrolled`, forever, and the hook
 * would have looked wired while being incapable of ever producing an
 * observation. That is the same defect class as the peer-verification panel —
 * attached to a path that cannot fire — shipped by the same hand that
 * documented it.
 *
 * `trinity-shofet` replaces it: it is the dominant provider by volume, by a
 * factor of three over the next, and it provided the most recent fulfilment.
 * `trinity-orch` stays — it is a genuine provider and third by volume.
 *
 * The lesson is not the two names. "Most active agent" is not a fact until you
 * say active AT WHAT; a table with `provider_agent_id` and `buyer_agent_id`
 * will happily answer the question you did not mean to ask.
 */
export const DEFAULT_ENROLLED_AGENTS = ['trinity-shofet', 'trinity-orch'] as const;

/**
 * Observable status for /health. Reports whether the hook is switched on and
 * whether its allowlist came from the environment — never a secret value, the
 * same contract operator_pager keeps.
 *
 * This exists because "is the flag set?" was unanswerable from outside the
 * Railway dashboard, and an unanswerable question does not stay unanswered — it
 * gets guessed. It is derived from serviceQualityConfig() rather than re-reading
 * the environment, so /health cannot drift from what the hook actually does.
 */
export function serviceQualityStatus(): {
  mode: ServiceQualityMode;
  enrolled_count: number;
  allowlist: 'env' | 'default';
} {
  const agentsRaw = process.env['SERVICE_QUALITY_HOOK_AGENTS'];
  const fromEnv = typeof agentsRaw === 'string' && agentsRaw.trim().length > 0;
  const { mode, agents } = serviceQualityConfig();
  return { mode, enrolled_count: agents.size, allowlist: fromEnv ? 'env' : 'default' };
}

export function serviceQualityConfig(): ServiceQualityConfig {
  const raw = (process.env['SERVICE_QUALITY_HOOK_MODE'] ?? 'off').toLowerCase();
  const mode: ServiceQualityMode =
    raw === 'enforce' ? 'enforce' : raw === 'shadow' ? 'shadow' : 'off';

  const agentsRaw = process.env['SERVICE_QUALITY_HOOK_AGENTS'];
  const agents =
    typeof agentsRaw === 'string' && agentsRaw.trim().length > 0
      ? agentsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [...DEFAULT_ENROLLED_AGENTS];

  return { mode, agents: new Set(agents) };
}

/**
 * What the hook observed. `checked` is the load-bearing field: false means NO
 * VERDICT WAS REACHED, and the caller must not read the absence of a decision as
 * a pass. `would_apply` is present ONLY on a checked shadow observation.
 */
export interface ServiceQualityObservation {
  mode: ServiceQualityMode;
  /** False = NOT_CHECKED. Never conflate with a clean verdict. */
  checked: boolean;
  reason: string;
  agent_name?: string;
  hal_score?: number;
  hal_decision?: HALDecision;
  purpose?: string;
  purpose_weight?: number;
  /** SHADOW ONLY — the delta that WOULD have moved the score. Nothing moved. */
  would_apply?: number;
  /** ENFORCE ONLY — what actually moved. */
  applied?: number;
  score_event_id?: number;
  observed_at: string;
}

export interface ServiceQualityArgs {
  contractId: string;
  providerAgentId: string;
  serviceType: string;
  /** The handler's fulfilment result — the artifact HAL is asked about. */
  result: Record<string, unknown>;
  /** Existing contract metadata, so the shadow write is additive. */
  contractMetadata?: Record<string, unknown> | null;
}

/**
 * Render the fulfilment result as the text HAL evaluates.
 *
 * A handler returns an arbitrary object. Stringifying the whole thing would feed
 * HAL its own bookkeeping (ids, timestamps, verdict fields) as if it were a
 * factual claim, so prefer an explicit textual field and fall back to the JSON
 * only when there is none — recording WHICH, because "HAL scored the JSON
 * envelope" and "HAL scored the answer" are different measurements.
 */
export function artifactText(result: Record<string, unknown>): { text: string; source: string } {
  for (const key of ['answer', 'output', 'text', 'summary', 'content', 'result_text']) {
    const v = result[key];
    if (typeof v === 'string' && v.trim().length > 0) return { text: v, source: key };
  }
  return { text: JSON.stringify(result ?? {}), source: 'json_envelope' };
}

/**
 * Ask HAL about delivered work. Returns an observation; never throws.
 */
export async function recordServiceQuality(
  args: ServiceQualityArgs,
): Promise<ServiceQualityObservation> {
  const observed_at = new Date().toISOString();
  const cfg = serviceQualityConfig();

  if (cfg.mode === 'off') {
    return { mode: 'off', checked: false, reason: 'hook_disabled', observed_at };
  }

  try {
    const { data: agent } = await db
      .from('repid_agents')
      .select('id, agent_name, current_repid, tier')
      .eq('id', args.providerAgentId)
      .maybeSingle();

    const agentName = (agent as any)?.agent_name as string | undefined;
    if (!agent || !agentName) {
      return { mode: cfg.mode, checked: false, reason: 'provider_agent_not_found', observed_at };
    }
    if (!cfg.agents.has(agentName)) {
      return {
        mode: cfg.mode, checked: false, reason: 'agent_not_enrolled',
        agent_name: agentName, observed_at,
      };
    }

    const { text, source } = artifactText(args.result);
    if (!text || text.trim().length === 0) {
      return {
        mode: cfg.mode, checked: false, reason: 'empty_artifact',
        agent_name: agentName, observed_at,
      };
    }

    // ENFORCE goes straight to the real pipeline and does NOT pre-evaluate.
    //
    // An earlier draft called halService here first and then runScoreEvent,
    // which evaluates again: two provider round-trips per contract, and two
    // verdicts on the same artifact that can disagree — at which point the one
    // recorded in the ledger and the one reported to the caller are different
    // measurements wearing the same name. runScoreEvent already carries every
    // guard this module would duplicate (quorum, the reward-requires-a-provider
    // floor, the purpose gate), so the only honest thing to add is the routing.
    if (cfg.mode === 'enforce') {
      const input: ScoreEventInput = {
        agent_id: args.providerAgentId,
        prompt: `service_contract:${args.serviceType}`,
        answer: text,
        task_domain: SERVICE_TASK_DOMAIN,
        contract_id: args.contractId,
        idempotency_key: `service-quality:v1:${args.contractId}`,
      };
      const res = await runScoreEvent(input);
      const purposeEnforced = classifyTaskPurpose(SERVICE_TASK_DOMAIN, null);
      return {
        mode: 'enforce', checked: true, reason: `scored (artifact_source=${source})`,
        agent_name: agentName,
        hal_score: res.hal_score,
        hal_decision: res.hal_decision,
        purpose: purposeEnforced.purpose,
        purpose_weight: purposeEnforced.weight,
        applied: res.repid_delta_applied,
        score_event_id: res.score_event_id,
        observed_at,
      };
    }

    // SHADOW — evaluate here, because nothing downstream will.
    // STRICTNESS 2: the provider-backed discriminative path, mirroring
    // src/scoring/pipeline.ts. Not the strictness-1 extractor: see header.
    const r = await halService.evaluate({
      text,
      context: { domain: SERVICE_TASK_DOMAIN, certainty: 0.85 },
      strictness: 2,
      providersFn: () => buildFactCheckProviders(),
    });

    // A REWARD REQUIRES A PROVIDER. `reward_suppressed` is HalService reporting
    // that zero providers succeeded behind this verdict. That is NOT_CHECKED —
    // recording a score from it would be the unearned-reward defect, and in the
    // enforce direction it would move a real agent's reputation on nothing.
    if ((r as any).reward_suppressed !== undefined) {
      return {
        mode: cfg.mode, checked: false, reason: 'no_provider_evidence',
        agent_name: agentName, observed_at,
      };
    }

    const hal_score = Number.isFinite(r.hal_score as number) ? (r.hal_score as number) : null;
    if (hal_score === null) {
      return {
        mode: cfg.mode, checked: false, reason: 'hal_score_not_finite',
        agent_name: agentName, observed_at,
      };
    }

    const hal_decision = deriveHalDecision(hal_score, (r as any).decision === 'vetoed', null);
    const purpose = classifyTaskPurpose(SERVICE_TASK_DOMAIN, null);

    // Compute the counterfactual, write NOTHING to repid_score_events.
    // vesting_cliff_active is false: `repid_agents` has no such column
    // [MEASURED 2026-09-04], so the live pipeline reads undefined here too.
    const delta = computeDelta({
      hal_score,
      hal_decision,
      current_repid: Number((agent as any).current_repid ?? 0),
      agent_tier: String((agent as any).tier ?? 'PROBATIONARY'),
      vesting_cliff_active: false,
    });

    const observation: ServiceQualityObservation = {
      mode: 'shadow', checked: true, reason: `evaluated (artifact_source=${source})`,
      agent_name: agentName,
      hal_score,
      hal_decision,
      purpose: purpose.purpose,
      purpose_weight: purpose.weight,
      would_apply: Math.round(delta.delta_applied * purpose.weight * 10) / 10,
      observed_at,
    };

    // Additive write beside the artifact. Not the ledger — shadow means shadow.
    const { error } = await db
      .from('service_contracts')
      .update({
        metadata: {
          ...((args.contractMetadata as Record<string, unknown>) ?? {}),
          hal_quality_shadow: observation,
        },
      })
      .eq('id', args.contractId);

    if (error) {
      console.error(
        `[service-quality-hook] shadow observation write failed for contract ${args.contractId}:`,
        error.message,
        new Error().stack,
      );
    }

    return observation;
  } catch (e: any) {
    // Loud, per the handler-base convention — but never rethrown. Fulfilment has
    // already succeeded; a failed quality probe must not undo it.
    console.error(
      `[service-quality-hook] evaluation failed for contract ${args.contractId}:`,
      e?.message ?? String(e),
      e?.stack ?? new Error().stack,
    );
    return {
      mode: cfg.mode, checked: false,
      reason: `hal_error: ${e?.message ?? String(e)}`,
      observed_at,
    };
  }
}
