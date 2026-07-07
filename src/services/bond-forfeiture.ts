/**
 * Anti-Sybil MVP (2026-07-07) — detection→FORFEITURE wiring (spec §3–§4).
 *
 * Wires a PROVEN red-team violation to the DEPLOYED penalty primitive
 * apply_repid_penalty(p_agent, p_new_repid, p_event) + repid_agents.floor_override
 * (both verified live 2026-07-07). T2 §4 rank 5: the primitive exists but "isn't
 * wired to fire on farming" — this is the wire, with due process.
 *
 * REGULATORY (spec §3/§7): "bond forfeiture" / "penalty", NEVER "slashing".
 * DUE PROCESS: forfeiture is proposed on a PROVEN violation (confidence ≥
 * bond_forfeiture_confidence_min), then an APPEAL window elapses before it is
 * upheld — never on accusation. This module encodes the boundary; the appeal
 * adjudication itself is a placeholder pending Sean's due-process parameters (§9.3).
 *
 * FLAG-GATED OFF: does nothing unless REPID_BOND_FORFEITURE_ENABLED === 'true'.
 * Depends on the bond/probe/forfeiture tables (migration FILE
 * 20260707130000_agent_bonds_and_forfeiture.sql — NOT applied), so it is inert
 * until Sean applies the schema + sets parameters. No auto-run wiring is added
 * here; this is the callable primitive the red-team worker will invoke.
 */
import { db } from '../db';

export interface RedTeamViolation {
  targetAgentId: string;
  probeId: string;
  reason: string;
  confidence: number;          // 0..1
  /** New (demoted) RepID to write via apply_repid_penalty. Sean parameter drives
   *  partial vs full; caller computes it (e.g. floor to PROVISIONAL band). */
  newRepid: number;
  bondId?: string | null;
  forfeitedAmountUsdcRaw?: number;
}

export interface ForfeitureOutcome {
  applied: boolean;
  reason: string;
  forfeitureId?: string | null;
}

function forfeitureEnabled(): boolean {
  return process.env.REPID_BOND_FORFEITURE_ENABLED === 'true';
}

async function getConfigNumber(key: string, fallback: number): Promise<number> {
  try {
    const { data } = await db.from('repid_config').select('value').eq('key', key).maybeSingle();
    const n = Number((data as any)?.value);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Propose a bond forfeiture on a PROVEN violation. Writes the due-process ledger
 * row (status 'proposed', appeal window open) and — only after the appeal window
 * is designed to elapse — applies the deployed apply_repid_penalty. In this MVP
 * scaffold the penalty is applied here ONLY when the flag is on AND confidence
 * clears the configured floor; the appeal adjudication is a placeholder that a
 * follow-up (Sean's due-process params) will insert BEFORE the penalty call.
 *
 * Returns applied=false (with a reason) whenever the flag is off, confidence is
 * insufficient, or any step fails — never throws into the caller.
 */
export async function proposeBondForfeiture(v: RedTeamViolation): Promise<ForfeitureOutcome> {
  if (!forfeitureEnabled()) {
    return { applied: false, reason: 'forfeiture_disabled' };
  }

  const confidenceMin = await getConfigNumber('bond_forfeiture_confidence_min', 0.9);
  if (!(v.confidence >= confidenceMin)) {
    return { applied: false, reason: `confidence_below_min (${v.confidence} < ${confidenceMin})` };
  }

  const appealHours = await getConfigNumber('bond_appeal_window_hours', 72);
  const now = new Date();
  const appealCloses = new Date(now.getTime() + appealHours * 60 * 60 * 1000);

  // 1) Due-process ledger row FIRST (proposed + appeal window). Never penalize
  //    without a recorded, appealable proposal (spec §3: proven + appeal, mercy).
  let forfeitureId: string | null = null;
  try {
    const { data, error } = await db.from('repid_bond_forfeitures').insert({
      agent_id: v.targetAgentId,
      bond_id: v.bondId ?? null,
      probe_id: v.probeId,
      reason: v.reason,
      forfeited_amount_usdc_raw: v.forfeitedAmountUsdcRaw ?? 0,
      repid_penalty_applied: 0,
      status: 'proposed',
      appeal_opens_at: now.toISOString(),
      appeal_closes_at: appealCloses.toISOString(),
    }).select('id').maybeSingle();
    if (error) return { applied: false, reason: `ledger_insert_failed: ${error.message}` };
    forfeitureId = (data as any)?.id ?? null;
  } catch (e: any) {
    return { applied: false, reason: `ledger_insert_error: ${e?.message ?? String(e)}` };
  }

  // 2) APPEAL PLACEHOLDER — Sean's due-process (§9.3) inserts here: hold until
  //    appeal_closes_at, honor an overturn, apply partial/full per policy. Until
  //    that ships, the scaffold does NOT auto-apply the penalty on proposal.
  //    The penalty call below is the wired primitive, ready for the adjudicator.
  return {
    applied: false,
    reason: 'proposed_pending_appeal_window',
    forfeitureId,
  };
}

/**
 * The wired forfeiture action: apply the deployed apply_repid_penalty primitive.
 * Called by the appeal adjudicator once a forfeiture is UPHELD (not here on
 * proposal). Separated so the penalty is never one accidental call away from a
 * mere accusation. Flag-gated + non-throwing.
 */
export async function applyUpheldForfeiture(
  forfeitureId: string,
  agentId: string,
  newRepid: number,
  eventMeta: Record<string, unknown>,
): Promise<ForfeitureOutcome> {
  if (!forfeitureEnabled()) return { applied: false, reason: 'forfeiture_disabled' };
  try {
    const { error } = await db.rpc('apply_repid_penalty', {
      p_agent: agentId,
      p_new_repid: newRepid,
      p_event: { source: 'bond_forfeiture', forfeiture_id: forfeitureId, ...eventMeta },
    });
    if (error) return { applied: false, reason: `penalty_rpc_failed: ${error.message}`, forfeitureId };

    await db.from('repid_bond_forfeitures')
      .update({ status: 'upheld', repid_penalty_applied: newRepid, resolved_at: new Date().toISOString() })
      .eq('id', forfeitureId);
    return { applied: true, reason: 'forfeiture_upheld_and_applied', forfeitureId };
  } catch (e: any) {
    return { applied: false, reason: `penalty_error: ${e?.message ?? String(e)}`, forfeitureId };
  }
}
