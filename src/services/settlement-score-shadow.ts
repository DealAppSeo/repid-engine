/**
 * settlement-score-shadow.ts — what a SETTLED service_contract WOULD score,
 * measured without moving a single agent's RepID.
 *
 * THE GAP THIS MEASURES
 * ---------------------
 * A settled A2A contract can reach `settled` and move NO score. The award path
 * (`a2a-negotiation.ts`) is RepID-neutral by construction; RepID is only ever
 * moved downstream on the awarded contract by the fulfilled/satisfied/outcome
 * path. The satisfied leg is applied by `applyServiceSatisfiedDeltas`
 * (validation-repid-delta.ts) → `applyValidationEvent` (scoring/pipeline.ts),
 * which inserts a `repid_score_events` row and updates
 * `repid_agents.current_repid`. But that leg only runs when settlement goes
 * through `finalizeSettledContract` (i.e. `POST /contracts/:id/satisfy` or the
 * x402 release-retry worker). A contract that reaches `settled` by any other
 * route — including a direct table write — emits nothing. There is no
 * server-side driver that finalizes A2A contracts that reach `fulfilled`.
 *
 * WHAT THIS MODULE DOES — AND DELIBERATELY DOES NOT DO
 * ----------------------------------------------------
 * It computes what the settled contract WOULD score, using the SAME constant the
 * live writer applies (`SERVICE_SATISFIED_DELTA_BASE`, imported — one source, no
 * drift), and records that observation to `trinity_agent_logs` (a monitoring
 * surface). It reads `repid_agents.current_repid` to show the before-value.
 *
 * It NEVER writes `repid_agents` and NEVER writes `repid_score_events`. It does
 * not call `applyServiceSatisfiedDeltas`, `applyValidationEvent`, `updateRepId`,
 * or enqueue `repid_proof_queue`. It cannot move RepID. Turning a settlement into
 * a real score move is an ORIGINAL change to live scoring and is Sean-gated: the
 * ratified step is to have a server-side settlement driver call the EXISTING
 * `applyServiceSatisfiedDeltas`. This module produces the measurement that
 * decision needs, and nothing else.
 *
 * FLAG, DEFAULT OFF (mirrors `OWNER_CEILING_SHADOW_ENABLED`)
 * ---------------------------------------------------------
 * `SETTLEMENT_SCORE_SHADOW_ENABLED`, read PER CALL so a deploy can flip it
 * without a restart and a test can flip it without a reimport. While OFF the
 * observer is INERT: no reads, no writes, returns `disabled`. While ON it reads
 * (current_repid, sim flag) and records ONE `trinity_agent_logs` row — and still
 * writes nothing to the two live score tables. The batch measurement
 * (`scripts/measure/settlement-score-shadow.ts`) is read-only and independent of
 * this flag, so the table for Sean is produced regardless.
 *
 * WHY THE WOULD-BE DELTA IS NOT THE FINAL current_repid. The live writer applies
 * `clamp(decay(current_repid) + delta)`.
 *
 * This comment used to add "and runs it through the money-path gate
 * (`MONEY_PATH_GATE_MODE`)". THERE IS NO SUCH GATE AND NO SUCH VARIABLE
 * [MEASURED 2026-09-08]: `MONEY_PATH_GATE_MODE` appeared nowhere in this
 * repository except this sentence — not in code, not in the generated env
 * registry. A named env var reads as a real control, so the sentence invented a
 * safety mechanism a reader would then assume was protecting the money path. The
 * real money-path gate is `X402_ENFORCEMENT_ENABLED` (`src/index.ts`,
 * `processCascadeQueue`), and it gates escrow admission, not the delta.
 *
 * This module reports the raw satisfied delta and a
 * NAIVE `current_repid + delta` preview, both explicitly labelled — it does not
 * reproduce decay, the [10,10000] clamp, or the gate, because doing so would be a
 * second copy of the writer's arithmetic drifting out of sight. The delta is the
 * honest, driftless number; the applied score is whatever the writer computes at
 * apply time.
 */
import { db } from '../db';
import { logAgentEvent, buildAgentLogRow } from '../engine/agent-log';
import { SERVICE_SATISFIED_DELTA_BASE, contractRowIsSimulated } from './validation-repid-delta';

/**
 * Default OFF. Read per call, never cached at import — same rationale as
 * `ownerCeilingShadowEnabled()`.
 */
export function settlementScoreShadowEnabled(): boolean {
  return String(process.env['SETTLEMENT_SCORE_SHADOW_ENABLED'] ?? '').toLowerCase() === 'true';
}

/** The minimum contract shape the observer needs. Matches the settled row `finalizeSettledContract` holds. */
export interface SettlementContract {
  id: string;
  provider_agent_id: string;
  buyer_agent_id: string;
  buyer_satisfaction_score: number | null;
  status?: string | null;
  metadata?: unknown;
  payload?: unknown;
  x402_payment_id?: string | null;
}

/** The would-be satisfied deltas for both parties. Pure — see `computeSettlementScoreDeltas`. */
export interface SettlementScoreDeltas {
  event_type: 'SERVICE_SATISFIED';
  /** round(30 * satisfaction), or 0 when simulated. */
  providerDelta: number;
  /** round(15 * satisfaction), or 0 when simulated. */
  buyerDelta: number;
  /** The satisfaction score used, clamped to [0,1] as the DB CHECK requires. */
  satisfactionScore: number;
  isSimulated: boolean;
}

export type SettlementScoreVerdict =
  /** Flag on; deltas computed and the observation recorded. Nothing was applied. */
  | 'observed'
  /** Simulated contract — both deltas are 0 by the same gate the live writer uses. */
  | 'observed_simulated'
  /** The shadow path itself failed. Recorded, never propagated. */
  | 'error'
  /** The flag is off; nothing was computed. Present so an empty dataset is legible. */
  | 'disabled';

export interface SettlementScoreObservation {
  verdict: SettlementScoreVerdict;
  contractId: string;
  providerAgentId: string;
  buyerAgentId: string;
  satisfactionScore: number | null;
  isSimulated: boolean;
  event_type: 'SERVICE_SATISFIED';
  wouldProviderDelta: number;
  wouldBuyerDelta: number;
  /** current_repid at observation time. NOT_CHECKED (null) when the row was not read. */
  providerRepidBefore: number | null;
  buyerRepidBefore: number | null;
  /**
   * NAIVE preview only: `before + delta`, WITHOUT decay, the [10,10000] clamp, or
   * the money-path gate the live writer applies. Never treat as the applied score.
   */
  wouldProviderRepidAfterNaive: number | null;
  wouldBuyerRepidAfterNaive: number | null;
  detail: string;
  observedAt: string;
}

/**
 * PURE. Reproduces `applyServiceSatisfiedDeltas` exactly: both parties' base is
 * multiplied by the satisfaction score and rounded (`Math.round`), and a
 * simulated contract zeroes both. Given the same inputs it returns the same
 * deltas — no clock, no I/O.
 */
export function computeSettlementScoreDeltas(input: {
  satisfactionScore: number | null | undefined;
  isSimulated: boolean;
}): SettlementScoreDeltas {
  // The DB CHECK constrains buyer_satisfaction_score to [0,1]; a null score
  // means "never rated", which scores nothing rather than guessing a value.
  const raw = typeof input.satisfactionScore === 'number' && Number.isFinite(input.satisfactionScore)
    ? input.satisfactionScore
    : 0;
  const score = Math.max(0, Math.min(1, raw));
  const providerDelta = input.isSimulated ? 0 : Math.round(SERVICE_SATISFIED_DELTA_BASE.provider * score);
  const buyerDelta = input.isSimulated ? 0 : Math.round(SERVICE_SATISFIED_DELTA_BASE.buyer * score);
  return {
    event_type: 'SERVICE_SATISFIED',
    providerDelta,
    buyerDelta,
    satisfactionScore: score,
    isSimulated: input.isSimulated,
  };
}

/**
 * Observe (never apply) the settlement score for one contract.
 *
 * NEVER THROWS into the caller and NEVER writes `repid_agents` /
 * `repid_score_events`. Returns the observation so a caller or test can assert on
 * it; production callers ignore the return value.
 */
export async function observeSettlementScore(input: {
  contract: SettlementContract;
  now?: Date;
}): Promise<SettlementScoreObservation> {
  const c = input.contract;
  const observedAt = (input.now ?? new Date()).toISOString();

  const base = {
    contractId: c.id,
    providerAgentId: c.provider_agent_id,
    buyerAgentId: c.buyer_agent_id,
    satisfactionScore: c.buyer_satisfaction_score,
    event_type: 'SERVICE_SATISFIED' as const,
    observedAt,
  };

  if (!settlementScoreShadowEnabled()) {
    return {
      ...base,
      verdict: 'disabled',
      isSimulated: false,
      wouldProviderDelta: 0,
      wouldBuyerDelta: 0,
      providerRepidBefore: null,
      buyerRepidBefore: null,
      wouldProviderRepidAfterNaive: null,
      wouldBuyerRepidAfterNaive: null,
      detail: 'SETTLEMENT_SCORE_SHADOW_ENABLED is not set — nothing read, nothing recorded, nothing observed.',
    };
  }

  try {
    const isSimulated = await contractRowIsSimulated({
      metadata: (c.metadata ?? {}) as any,
      payload: (c.payload ?? {}) as any,
      x402_payment_id: c.x402_payment_id ?? null,
    });
    const deltas = computeSettlementScoreDeltas({ satisfactionScore: c.buyer_satisfaction_score, isSimulated });

    // Read-only: current_repid for both parties, for the before/after preview.
    const [providerBefore, buyerBefore] = await Promise.all([
      readCurrentRepid(c.provider_agent_id),
      readCurrentRepid(c.buyer_agent_id),
    ]);

    const observation: SettlementScoreObservation = {
      ...base,
      verdict: isSimulated ? 'observed_simulated' : 'observed',
      isSimulated,
      wouldProviderDelta: deltas.providerDelta,
      wouldBuyerDelta: deltas.buyerDelta,
      providerRepidBefore: providerBefore,
      buyerRepidBefore: buyerBefore,
      wouldProviderRepidAfterNaive: providerBefore === null ? null : providerBefore + deltas.providerDelta,
      wouldBuyerRepidAfterNaive: buyerBefore === null ? null : buyerBefore + deltas.buyerDelta,
      detail: isSimulated
        ? 'simulated contract — the live writer would zero both deltas; recorded for coverage, not as a score move'
        : 'would-be SERVICE_SATISFIED deltas (raw); live apply adds decay + [10,10000] clamp + money-path gate',
    };

    await record(observation);
    return observation;
  } catch (err) {
    const observation: SettlementScoreObservation = {
      ...base,
      verdict: 'error',
      isSimulated: false,
      wouldProviderDelta: 0,
      wouldBuyerDelta: 0,
      providerRepidBefore: null,
      buyerRepidBefore: null,
      wouldProviderRepidAfterNaive: null,
      wouldBuyerRepidAfterNaive: null,
      detail: `settlement-score shadow failed (nothing applied, settlement unaffected): ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
    // Best-effort record; a failed record must not mask that the observation failed.
    await record(observation).catch(() => undefined);
    return observation;
  }
}

/** Read-only current_repid lookup. Returns null (NOT_CHECKED) rather than guessing on any miss. */
async function readCurrentRepid(agentId: string): Promise<number | null> {
  const { data, error } = await db
    .from('repid_agents')
    .select('current_repid')
    .eq('id', agentId)
    .maybeSingle();
  if (error || !data) return null;
  const v = (data as { current_repid: number | null }).current_repid;
  return typeof v === 'number' ? v : null;
}

/**
 * Record the observation to `trinity_agent_logs` via the shared builder — the
 * same guard `owner-ceiling-shadow` uses, and for the same reason: a shadow log
 * that is silently empty looks exactly like a shadow that found nothing.
 * `warn`, not `info`, so the sampler never drops it and biases the dataset.
 */
async function record(o: SettlementScoreObservation): Promise<void> {
  try {
    await logAgentEvent(
      buildAgentLogRow({
        agent: o.providerAgentId,
        agent_name: o.providerAgentId,
        action: 'settlement_score_shadow',
        content: `${o.verdict}: contract=${o.contractId} provider_delta=${o.wouldProviderDelta} buyer_delta=${o.wouldBuyerDelta} satisfaction=${String(o.satisfactionScore)}`,
        metadata: { ...o, shadowMode: true, movesRepid: false },
      }),
      'warn',
    );
  } catch (err) {
    console.error(
      `[settlement-score-shadow] observation NOT recorded: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read the shadow observations back. `observed` rows are the settlements that
 * WOULD have moved score; `observed_simulated` rows would not. Sum
 * `wouldProviderDelta` to size the provider-side RepID the settlement leg is
 * currently not applying.
 */
export const SETTLEMENT_SCORE_SHADOW_SQL = `
select
  metadata->>'verdict'                                                as verdict,
  count(*)                                                            as observations,
  count(distinct metadata->>'contractId')                            as contracts,
  sum((metadata->>'wouldProviderDelta')::int)                        as sum_provider_would_delta,
  sum((metadata->>'wouldBuyerDelta')::int)                           as sum_buyer_would_delta,
  min(created_at)                                                    as first_seen,
  max(created_at)                                                    as last_seen
from trinity_agent_logs
where action = 'settlement_score_shadow'
group by 1
order by observations desc;
`.trim();
