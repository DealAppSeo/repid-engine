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
 * Columns verified against prod: repid_agents(agent_name, tier, current_repid, conservator_address);
 * staking_deposits(agent_name, amount_usdc, status); x402_payment_gates(... requested_at, authorized);
 * dispute_claims(defendant_agent, status). repid_agents has NO stake_amount column — stake is summed
 * from active staking_deposits.
 */
import { db } from '../db';

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
  const [agentRes, stakeRes, gateRes, dispRes] = await Promise.all([
    db.from('repid_agents').select('tier, current_repid, conservator_address').eq('agent_name', agent).maybeSingle(),
    db.from('staking_deposits').select('amount_usdc').eq('agent_name', agent).eq('status', 'active'),
    db.from('x402_payment_gates').select('amount_usdc').eq('agent_name', agent).eq('authorized', true).gte('requested_at', since),
    db.from('dispute_claims').select('id').eq('defendant_agent', agent).in('status', ['filed', 'reviewing', 'appealed']),
  ]);
  const agentRow: any = agentRes.data ?? {};
  return {
    tier: agentRow.tier ?? null,
    current_repid: agentRow.current_repid ?? null,
    conservator_address: agentRow.conservator_address ?? null,
    stake_available: sumUsdc(stakeRes.data as any[]),
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

  return { ...decision, agent_exists };
}
