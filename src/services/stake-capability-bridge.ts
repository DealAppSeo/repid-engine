/**
 * Stake → capability bridge (sprint 2026-05-28, Phase 3).
 *
 * Closes the previously-cold tail of the ownership/stake loop:
 *
 *   stake_deposits → stake_authority_snapshots   (stake-vault.ts)
 *       → repid_agent_stakes.max_transaction_usdc (THIS FILE)
 *       → capability gate on repid_agents (autonomous_cap)  (THIS FILE)
 *
 * `repid_agent_stakes` had ZERO writers anywhere in the codebase — the table
 * was designed but the call site was never built (Cold Module). This bridge is
 * that missing call site. It is invoked from depositStake / withdrawStake after
 * the authority snapshot, and the slash hook below is invoked from the existing
 * RepID slash path (substance-gate-writer.slashRepIDForGateFail).
 *
 * SIMULATION-ONLY. No real funds move. `custody_type='simulated'` and
 * `trustescrow_id` carry a sim marker; the upstream stake_deposits row is
 * is_simulated=true unless X402_REAL_RPC is set (Sean-only).
 *
 * UNITS: authority and stake are 6-decimal micro-USDC bigints upstream (100
 * USDC = 100_000_000). repid_agent_stakes.*_usdc columns are numeric in whole
 * USDC, so we divide by 1e6 at the boundary.
 */

import { db } from '../db';

const MICRO_PER_USDC = 1_000_000n;
const SIM_MARKER = 'simulated:cc-2026-05-28';

/** Convert a 6-decimal micro-USDC bigint to whole-USDC number. */
function microToUsdc(micro: bigint): number {
  // Safe for sim magnitudes (≪ Number.MAX_SAFE_INTEGER). Keep 6-dp precision.
  return Number(micro) / Number(MICRO_PER_USDC);
}

export interface CapabilityResult {
  builder_id: string;
  agents_updated: number;
  per_agent_max_transaction_usdc: number;
  autonomous_cap: number;
}

/**
 * Materialize a builder's bonded authority onto each owned agent's stake row
 * and capability caps. Idempotent per agent (select-then-update/insert; the
 * table has no unique constraint on agent_id, so we don't rely on upsert).
 *
 * Policy (sim): each owned agent's per-transaction ceiling = the builder's
 * bonded authority, and repid_agents.autonomous_cap = floor(that, in USDC).
 * The aggregate-vs-per-agent distribution policy and the api_rate_limit /
 * model-routing tier mapping are NOT invented here — see the gated TODOs
 * below (XC Phase 4 canonical tiering).
 */
export async function applyStakeCapability(
  builderId: string,
  authorityMicro: bigint,
  stakeTotalMicro: bigint,
  opts: { isSimulated?: boolean } = {},
): Promise<CapabilityResult> {
  const isSimulated = opts.isSimulated ?? !process.env.X402_REAL_RPC;
  const maxTxUsdc = microToUsdc(authorityMicro);
  const stakeUsdc = microToUsdc(stakeTotalMicro);
  const autonomousCap = Math.floor(maxTxUsdc);

  const { data: agents, error: agErr } = await db
    .from('repid_agents')
    .select('id')
    .eq('builder_id', builderId);
  if (agErr) {
    console.error('[stake-capability] agent lookup failed:', agErr.message);
    return { builder_id: builderId, agents_updated: 0, per_agent_max_transaction_usdc: maxTxUsdc, autonomous_cap: autonomousCap };
  }

  let updated = 0;
  for (const a of agents ?? []) {
    const agentId = (a as any).id as string;

    // Find the existing active stake row for this agent (no unique constraint
    // on agent_id, so we explicitly look it up rather than upsert).
    const { data: existing } = await db
      .from('repid_agent_stakes')
      .select('id, locked_for_claim_id')
      .eq('agent_id', agentId)
      .eq('status', 'active')
      .limit(1)
      .maybeSingle();

    // Preserve any slash-lock: locked stake is not "available".
    const locked = existing && (existing as any).locked_for_claim_id != null;
    const availableUsdc = locked ? 0 : maxTxUsdc;

    const row = {
      agent_id: agentId,
      stake_amount_usdc: stakeUsdc,
      stake_currency: 'USDC',
      custody_type: isSimulated ? 'simulated' : 'onchain',
      status: 'active',
      max_transaction_usdc: maxTxUsdc,
      available_amount: availableUsdc,
      trustescrow_id: isSimulated ? SIM_MARKER : null,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      const { error } = await db.from('repid_agent_stakes').update(row).eq('id', (existing as any).id);
      if (error) { console.error(`[stake-capability] update failed for ${agentId}:`, error.message); continue; }
    } else {
      const { error } = await db.from('repid_agent_stakes').insert(row);
      if (error) { console.error(`[stake-capability] insert failed for ${agentId}:`, error.message); continue; }
    }

    // Capability gate on repid_agents. autonomous_cap is the direct, defensible
    // mapping (your autonomous transaction cap = your bonded authority in USDC).
    // TODO(XC Phase 4): api_rate_limit and model-routing tier need the canonical
    // stake→tier schedule; do NOT write fake values until that formula lands.
    const { error: capErr } = await db
      .from('repid_agents')
      .update({ autonomous_cap: autonomousCap })
      .eq('id', agentId);
    if (capErr) { console.error(`[stake-capability] cap update failed for ${agentId}:`, capErr.message); continue; }

    updated++;
  }

  return {
    builder_id: builderId,
    agents_updated: updated,
    per_agent_max_transaction_usdc: maxTxUsdc,
    autonomous_cap: autonomousCap,
  };
}

export interface SlashStakeResult {
  ok: boolean;
  agent_id: string;
  slashed_usdc: number;
  remaining_stake_usdc: number;
  locked_for_claim_id: number | null;
  reason?: string;
}

/**
 * SIM slash hook — reduce an agent's bonded stake on a RepID slash / dispute
 * loss and lock it to the originating claim. Wired into the EXISTING slash path
 * (substance-gate-writer.slashRepIDForGateFail); does not invent a new path.
 *
 * SIM POLICY (placeholder, clearly labeled): slash a fixed fraction of bonded
 * stake per gate-fail. The real slash schedule (proportional to delta / dispute
 * severity / repeat offenses) is an XC/Sean economic decision — NOT faked here.
 */
export const SIM_SLASH_FRACTION = 0.1; // TODO(XC/Sean): canonical slash schedule

export async function slashAgentStake(
  agentId: string,
  claimId: number | null,
  fraction: number = SIM_SLASH_FRACTION,
): Promise<SlashStakeResult> {
  const { data: stake, error } = await db
    .from('repid_agent_stakes')
    .select('id, stake_amount_usdc, max_transaction_usdc, available_amount')
    .eq('agent_id', agentId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (error || !stake) {
    // No bonded stake to slash — not an error in the loop (agent may be unstaked).
    return { ok: false, agent_id: agentId, slashed_usdc: 0, remaining_stake_usdc: 0, locked_for_claim_id: null, reason: 'no active stake' };
  }

  const s = stake as any;
  const current = Number(s.stake_amount_usdc ?? 0);
  const slashed = Math.max(0, current * fraction);
  const remaining = Math.max(0, current - slashed);
  // Reduce both the bonded amount and the derived transaction ceiling; lock the
  // remainder to the claim (one-way valve until the dispute resolves).
  const newMaxTx = Math.min(Number(s.max_transaction_usdc ?? remaining), remaining);

  const { error: upErr } = await db
    .from('repid_agent_stakes')
    .update({
      stake_amount_usdc: remaining,
      max_transaction_usdc: newMaxTx,
      available_amount: 0, // locked to the claim
      locked_for_claim_id: claimId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', s.id);

  if (upErr) {
    return { ok: false, agent_id: agentId, slashed_usdc: 0, remaining_stake_usdc: current, locked_for_claim_id: null, reason: upErr.message };
  }

  // Keep the capability cap consistent with the reduced stake.
  await db.from('repid_agents').update({ autonomous_cap: Math.floor(newMaxTx) }).eq('id', agentId);

  return { ok: true, agent_id: agentId, slashed_usdc: slashed, remaining_stake_usdc: remaining, locked_for_claim_id: claimId };
}
