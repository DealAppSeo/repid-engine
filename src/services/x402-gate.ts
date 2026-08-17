/**
 * S-WIRE-MVP Phase 5 — x402 payment authority gate.
 *
 * Decides whether an agent may settle an x402 transaction of a given USDC amount, based on its
 * RepID tier, available stake, today's spend, and any open disputes. Every decision is logged to
 * `x402_payment_gates` for audit. Tier ceilings escalate with reputation; PROBATIONARY agents
 * cannot transact at all, and lower tiers must have stake covering the transfer.
 *
 * The decision logic (`decideAuthority`) is pure and unit-tested; all DB reads are injected via the
 * context so the policy can be verified without a database.
 *
 * ⚠️ WHAT THIS MODULE ACTUALLY READS FOR "STAKE" — AND WHY THAT IS A KNOWN DEFECT
 *
 * This header used to claim stake was "summed from active `staking_deposits`". That was wrong in
 * the most expensive way a comment can be wrong: **`staking_deposits` has ZERO rows and no code
 * writes it** [V 2026-08-11]. The comment named a table that does not participate in the system
 * at all, so anyone auditing the money path — including Claude, on 2026-08-10 — queried the empty
 * table, read "0 active stakes", and drew a conclusion about production that was false.
 *
 * What the code below ACTUALLY sums (see `loadContext`):
 *   - `agent_stakes(staker_agent, stake_amount, status)`
 *   - `sponsorship_records(sponsored_agent, collateral_usdc, status)`
 *
 * **`agent_stakes` is a PREDICTION MARKET, not collateral.** Its columns are `target_model`,
 * `dimension`, `stake_position`, `actual_consensus`, `deviation`, `slash_amount` — an agent
 * wagering how a model will score, slashed on deviation. Summing it as authority-backing
 * collateral means winning bets on model scores buy the right to spend real money.
 *
 * Posted collateral actually lands in `stake_deposits(builder_id, amount, asset, is_simulated,
 * status)`, written by `services/stake-vault.ts#depositStake` — and this module never reads it.
 * So real collateral earns NO authority while wagers do. 50 active deposits are invisible here.
 *
 * DO NOT "FIX" THIS BY REPOINTING THE QUERY. 49 of 50 active deposits are `is_simulated`, and
 * `stake_deposits` is keyed on `builder_id` (a human) while this module reasons about an agent —
 * a link that currently resolves for ZERO rows. A naive repoint grants REAL spending power
 * against DEMO money: today's defect fails CLOSED (under-granting), that one fails OPEN.
 *
 * The corrected computation exists, is pure, is tested, and is SHADOW-ONLY with no caller:
 * `services/stake-authority-resolver.ts`. Full analysis and the flip criteria:
 * `reports/2026-08-11/STAKE_AUTHORITY_DEFECT.md`.
 *
 * Other columns verified against prod: repid_agents(agent_name, tier, current_repid,
 * conservator_address); x402_payment_gates(... requested_at, authorized);
 * dispute_claims(defendant_agent, status). repid_agents has NO stake_amount column.
 */
import { db } from '../db';
import { observeOwnerCeiling } from './owner-ceiling-shadow';

export type Tier = 'PROBATIONARY' | 'EARNING' | 'ESTABLISHED' | 'AUTONOMOUS' | 'VETERAN';

export interface TierLimit { per_tx: number; daily: number; requires_stake: boolean; }

/** Per-tier x402 ceilings, in USDC. PROBATIONARY is fully gated (must earn its way in). */
export const TIER_LIMITS: Record<Tier, TierLimit> = {
  PROBATIONARY: { per_tx: 0, daily: 0, requires_stake: true },
  EARNING: { per_tx: 10, daily: 50, requires_stake: true },
  ESTABLISHED: { per_tx: 100, daily: 1000, requires_stake: true },
  AUTONOMOUS: { per_tx: 1000, daily: 10000, requires_stake: false },
  VETERAN: { per_tx: 5000, daily: 50000, requires_stake: false },
};

const DEFAULT_LIMIT: TierLimit = TIER_LIMITS.PROBATIONARY;

export function limitForTier(tier: string | null | undefined): TierLimit {
  return TIER_LIMITS[(tier ?? '').toUpperCase() as Tier] ?? DEFAULT_LIMIT;
}

export interface AuthorityContext {
  tier: string | null;
  stake_available: number;
  daily_used: number;
  open_disputes: number;
}

export interface AuthorityDecision {
  authorized: boolean;
  denial_reason: string | null;
  tier: string;
  per_tx_limit: number;
  daily_limit: number;
  daily_used: number;
  daily_remaining: number;
  stake_available: number;
  open_disputes: number;
}

/** Pure policy decision — all live state injected via ctx. Order of checks is the order of precedence. */
export function decideAuthority(amount: number, ctx: AuthorityContext): AuthorityDecision {
  const tier = (ctx.tier ?? 'PROBATIONARY').toUpperCase();
  const limit = limitForTier(tier);
  const daily_remaining = Math.max(0, limit.daily - ctx.daily_used);
  let denial_reason: string | null = null;

  if (!(amount > 0)) denial_reason = 'invalid_amount';
  else if (limit.per_tx <= 0) denial_reason = `tier_${tier.toLowerCase()}_cannot_transact`;
  else if (ctx.open_disputes > 0) denial_reason = 'open_disputes';
  else if (amount > limit.per_tx) denial_reason = 'exceeds_per_tx_limit';
  else if (ctx.daily_used + amount > limit.daily) denial_reason = 'exceeds_daily_limit';
  else if (limit.requires_stake && ctx.stake_available < amount) denial_reason = 'insufficient_stake';

  return {
    authorized: denial_reason === null,
    denial_reason,
    tier,
    per_tx_limit: limit.per_tx,
    daily_limit: limit.daily,
    daily_used: ctx.daily_used,
    daily_remaining,
    stake_available: ctx.stake_available,
    open_disputes: ctx.open_disputes,
  };
}

const startOfUtcDay = (): string => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };
const sumUsdc = (rows: any[] | null) => (rows ?? []).reduce((s, r) => s + Number(r.amount_usdc ?? 0), 0);

export interface FullContext extends AuthorityContext {
  current_repid: number | null;
  conservator_address: string | null;
}

/** Load live authority context for an agent: tier/repid/custodian + active stake + today's authorized spend + open disputes. */
export async function loadAuthorityContext(agent: string): Promise<FullContext> {
  const since = startOfUtcDay();
  const shortId = agent.replace(/^trinity-/i, '').toUpperCase();
  const [agentRes, ownStakesRes, sponsorStakesRes, gateRes, dispRes] = await Promise.all([
    db.from('repid_agents').select('tier, current_repid, conservator_address').eq('agent_name', agent).maybeSingle(),
    db.from('agent_stakes').select('stake_amount').eq('staker_agent', shortId).eq('status', 'active'),
    db.from('sponsorship_records').select('collateral_usdc').eq('sponsored_agent', shortId).eq('status', 'active'),
    db.from('x402_payment_gates').select('amount_usdc').eq('agent_name', agent).eq('authorized', true).gte('requested_at', since),
    db.from('dispute_claims').select('id').eq('defendant_agent', agent).in('status', ['filed', 'reviewing', 'appealed']),
  ]);
  const agentRow: any = agentRes.data ?? {};
  const repid = Number(agentRow.current_repid ?? 0);
  const tier = agentRow.tier ?? 'PROBATIONARY';
  const limit = limitForTier(tier);

  // Sum own stakes (staker_agent = shortId)
  // stake_amount is in micro-USDC, convert to USD/USDC
  const ownStakes = (ownStakesRes.data ?? []) as any[];
  const ownStakeUSD = ownStakes.reduce((sum, row) => sum + Number(row.stake_amount ?? 0) / 1_000_000, 0);

  // Sum sponsored collateral (sponsored_agent = shortId)
  // collateral_usdc is in USDC (USD)
  const sponsorStakes = (sponsorStakesRes.data ?? []) as any[];
  const sponsorStakeUSD = sponsorStakes.reduce((sum, row) => sum + Number(row.collateral_usdc ?? 0), 0);

  // Compute effective backing: S_effective = S_own + S_sponsor / 3
  const effectiveStakeUSD = ownStakeUSD + (sponsorStakeUSD / 3);

  // A = min(R, 100 * sqrt(S_effective))
  const mathAuthority = Math.min(repid, 100 * Math.sqrt(effectiveStakeUSD));

  // Enforce 4x own-exposure cap: A = min(A, 4 * ownStakeUSD)
  const finalAuthority = Math.min(mathAuthority, 4 * ownStakeUSD);

  // If requires_stake is false, default to repid
  const stakeAvailable = limit.requires_stake ? finalAuthority : repid;

  return {
    tier: agentRow.tier ?? null,
    current_repid: agentRow.current_repid ?? null,
    conservator_address: agentRow.conservator_address ?? null,
    stake_available: stakeAvailable,
    daily_used: sumUsdc(gateRes.data as any[]),
    open_disputes: (dispRes.data ?? []).length,
  };
}

export interface AuthorizeInput { agent: string; transaction_type: string; amount: number; }

/** Full authorization: load context, decide, and log the attempt to x402_payment_gates (non-blocking). */
export async function checkTransactionAuthority(
  input: AuthorizeInput,
): Promise<AuthorityDecision & { agent_exists: boolean }> {
  const ctx = await loadAuthorityContext(input.agent);
  const agent_exists = ctx.tier !== null;
  const decision = decideAuthority(input.amount, ctx);
  if (!agent_exists) { decision.authorized = false; decision.denial_reason = 'agent_not_found'; }

  // Audit the gate decision. A logging failure must never fail the authorization response.
  void db
    .from('x402_payment_gates')
    .insert({
      agent_name: input.agent,
      transaction_type: input.transaction_type,
      amount_usdc: input.amount,
      repid_at_request: ctx.current_repid,
      tier_at_request: decision.tier,
      stake_available: decision.stake_available,
      authorized: decision.authorized,
      denial_reason: decision.denial_reason,
      custodian_address: ctx.conservator_address,
      processed_at: new Date().toISOString(),
    })
    .then(({ error }: any) => { if (error) console.error('[x402-gate] audit insert failed:', error.message); });

  // OWNER→CEILING INHERITANCE, IN SHADOW. Nothing about the human who owns this
  // agent currently narrows what it may spend; `decideAuthority` above reads the
  // agent's own tier and nothing else. This call computes what the ceiling WOULD
  // be if the owner's limits attenuated it, records the comparison, and returns a
  // value this function ignores — the decision above is unchanged and is what the
  // caller acts on. Inert unless OWNER_CEILING_SHADOW_ENABLED is set: with it
  // unset the observer performs no reads and no writes.
  void observeOwnerCeiling({ agent: input.agent, amount: input.amount, decision }).catch(() => {
    /* observeOwnerCeiling catches its own failures; this guards the promise itself. */
  });

  return { ...decision, agent_exists };
}
