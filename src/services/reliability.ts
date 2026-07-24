/**
 * DEFENSIBILITY — P0 of the peer-assessed trust lens (channel: SPEC).
 * Spec: E:\dev\living-docs\03_specs\DEFENSIBILITY_DISCERNMENT_LENS_SPEC_v0.md
 * (v0.2 — Grok cross-validated, D-054 CONCUR, 2026-07-23).
 *
 * RE-SOURCED 2026-07-23: the previous feed (peer_verification_queue, driven by a
 * DB trigger on every low-certainty HAL_SCORE_EVENT) was ~91–98% internal drill/
 * cron chatter — not verifiable claims. It is RETIRED from this lens (Grok: no
 * dual-write; HAL/ops feed banned). Defensibility now derives from a SUBSTANTIVE,
 * STAKED claim: a service-contract deliverable judged "to-spec" at FINAL
 * disposition. One narrow, honestly-labelled channel — defensibility_spec.
 *
 *   upheld (to-spec)  — provider's "meets spec" claim survived: a resolved dispute
 *                       that is NOT provider_at_fault, or a settled contract with
 *                       buyer_satisfaction_score >= threshold.
 *   not_upheld        — provider_at_fault, or settled with low satisfaction.
 *   non_conclusive    — fulfilled-but-unadjudicated / pending-dispute / cancelled /
 *                       expired — EXCLUDED from the denominator (Grok).
 *   independence      — buyer_agent_id <> provider_agent_id (v1). Graph-based
 *                       independence (shared keys / funding / controller cluster)
 *                       is a REQUIRED follow-up before any public surfacing.
 *
 * PROVISIONAL + SHADOW. Min-sample gate → null. With ~25 conclusive contract
 * dispositions ecosystem-wide today, this correctly returns insufficient_sample
 * for ~every agent — the honest cold-start Grok specced (never a flattering
 * default, never a prior bootstrapped from the contaminated HAL history).
 * Discernment (P1), stake/difficulty weighting + Wilson/Beta ranking bound,
 * hold-window finality, and the pred/chat channels are later phases per the spec.
 */

import { db } from '../db';

const MIN_CONCLUSIVE = Number(process.env.RELIABILITY_MIN_SAMPLE ?? 20);
const SATISFACTION_THRESHOLD = Number(process.env.RELIABILITY_SATISFACTION_THRESHOLD ?? 0.6);

// dispute_verdict values meaning the PROVIDER's claim did NOT survive.
const PROVIDER_FAULT_VERDICTS = new Set(['provider_at_fault']);
// dispute_verdict values meaning the provider's claim SURVIVED (fault elsewhere).
const PROVIDER_UPHELD_VERDICTS = new Set([
  'buyer_at_fault',
  'no_fault',
  'provider_not_at_fault',
  'upheld',
]);

export interface DefensibilitySpec {
  agent_id: string;
  channel: 'spec';
  defensibility: number | null; // raw upheld/conclusive — DISPLAY primitive; null below min-sample
  upheld: number;
  not_upheld: number;
  conclusive: number; // upheld + not_upheld
  non_conclusive: number; // excluded from the ratio
  sample_ok: boolean;
  min_sample: number;
  provisional: true;
  independence: string;
  basis: string;
  as_of: string;
}

interface ContractRow {
  status: string | null;
  dispute_verdict: string | null;
  buyer_satisfaction_score: number | null;
}

/**
 * Classify one contract's FINAL disposition from the provider's point of view.
 * Pure — exposed for tests. Unknown verdicts are treated as non-conclusive
 * (never guessed into upheld/not_upheld).
 */
export function classifyContractDisposition(
  c: ContractRow,
  satisfactionThreshold = SATISFACTION_THRESHOLD,
): 'upheld' | 'not_upheld' | 'non_conclusive' {
  const status = (c.status ?? '').toLowerCase();
  const verdict = (c.dispute_verdict ?? '').toLowerCase();

  if (status === 'resolved' && verdict) {
    if (PROVIDER_FAULT_VERDICTS.has(verdict)) return 'not_upheld';
    if (PROVIDER_UPHELD_VERDICTS.has(verdict)) return 'upheld';
    return 'non_conclusive'; // unknown verdict — do not guess
  }
  if (status === 'settled' && c.buyer_satisfaction_score !== null && c.buyer_satisfaction_score !== undefined) {
    return c.buyer_satisfaction_score >= satisfactionThreshold ? 'upheld' : 'not_upheld';
  }
  // fulfilled-but-unadjudicated, pending dispute, cancelled, expired, escrowed …
  return 'non_conclusive';
}

/** Pure: raw rate (display primitive) + min-sample gate. Exposed for tests. */
export function scoreDefensibility(
  counts: { upheld?: number; not_upheld?: number; non_conclusive?: number },
  minSample = MIN_CONCLUSIVE,
): Omit<DefensibilitySpec, 'agent_id' | 'channel' | 'independence' | 'basis' | 'as_of'> {
  const upheld = counts.upheld ?? 0;
  const not_upheld = counts.not_upheld ?? 0;
  const conclusive = upheld + not_upheld;
  const sample_ok = conclusive >= minSample;
  return {
    defensibility: sample_ok ? Number((upheld / conclusive).toFixed(4)) : null,
    upheld,
    not_upheld,
    conclusive,
    non_conclusive: counts.non_conclusive ?? 0,
    sample_ok,
    min_sample: minSample,
    provisional: true,
  };
}

/**
 * Defensibility (SPEC channel) for an agent, from its service-contract final
 * dispositions. Read-only; independence v1 = exclude self-dealt contracts.
 */
export async function computeDefensibilitySpec(agentId: string): Promise<DefensibilitySpec> {
  const { data, error } = await db
    .from('service_contracts')
    .select('status, dispute_verdict, buyer_satisfaction_score')
    .eq('provider_agent_id', agentId)
    .neq('buyer_agent_id', agentId); // independence v1: no self-dealt contracts

  const rows = (error ? [] : (data ?? [])) as ContractRow[];
  let upheld = 0;
  let not_upheld = 0;
  let non_conclusive = 0;
  for (const r of rows) {
    const d = classifyContractDisposition(r);
    if (d === 'upheld') upheld += 1;
    else if (d === 'not_upheld') not_upheld += 1;
    else non_conclusive += 1;
  }

  return {
    agent_id: agentId,
    channel: 'spec',
    ...scoreDefensibility({ upheld, not_upheld, non_conclusive }),
    independence: 'buyer<>provider (v1; graph-based independence required before public surfacing)',
    basis:
      "defensibility_spec = of an agent's service-contract deliverables that reached a FINAL disposition, " +
      'the share judged to-spec (provider not at fault / buyer satisfied); non-conclusive contracts excluded. ' +
      'HAL / peer-verification-queue feed retired (was ~91–98% drill noise). Provisional + shadow.',
    as_of: new Date().toISOString(),
  };
}
