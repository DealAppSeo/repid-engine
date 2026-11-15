/**
 * Stake vault — reponomics quadratic authority engine.
 *
 * Stake math (from sprint Phase 3):
 *   combinedScore = (R * W * C) / 1_000_000        // scales to ~[0, 40000]
 *   stakeSqrt     = babylonianSqrt(stakeAmount)    // integer sqrt
 *   authority     = stakeSqrt * combinedScore / 10_000n
 *
 * Floor protection: builder.current_repid < 5000 ⇒ authority = 0n.
 *
 * Withdrawals are blocked while the builder has open linked_bets
 * (one-way valve: the bet must resolve before the stake can move).
 */

import { db } from '../db';
import { config } from '../config';
import { emitAuditEvent } from './audit-emit';
import { BUILDER_FLOOR, computeAuthority, babylonianSqrt, type FloorCheck } from './authority-math';
import { recordSponsorship } from './sponsorship'; // R3 exercise + GA handoff
import { verifyDeposit } from './deposit-verifier';
import { escrowRefund } from './escrow-refunder';
import { ownerBudgetMode, supabaseOwnerBudget } from './owner-budget';

/** owner_spend_ledger.agent_id for a stake-withdrawal hold, which belongs to no agent. */
export const WITHDRAWAL_HOLD_AGENT = '00000000-0000-0000-0000-000000000000';

export { BUILDER_FLOOR, computeAuthority };

// Per-builder withdrawal serialization (in-process). The engine runs a single
// replica, so this closes the concurrent-withdrawal TOCTOU Strix flagged on #1261:
// two parallel withdrawStake calls for one builder would otherwise both read the
// same realTotal before either debits, both pass the amount check, and both
// broadcast a refund out of the pooled escrow. A DURABLE guard for a multi-replica
// deployment or a cross-request retry after a failed debit (a DB reservation /
// unique constraint written BEFORE the broadcast) is a follow-up migration — a
// shared-DB DDL decision. Until the real-staking signer key is provisioned the
// whole path is fail-closed and Base-Sepolia-only, so no real value is exposed.
const withdrawChains = new Map<string, Promise<unknown>>();
export function serializeWithdraw<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = withdrawChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run after the prior holder settles, either way
  const tail = run.then(() => undefined, () => undefined);
  withdrawChains.set(key, tail);
  void tail.then(() => { if (withdrawChains.get(key) === tail) withdrawChains.delete(key); });
  return run;
}

// ---------------------------------------------------------------------------
// DB-backed operations
// ---------------------------------------------------------------------------

export interface DepositResult {
  ok: boolean;
  builder_id: string;
  total_active_stake: string;
  authority_after: string;
  is_simulated: boolean;
  error?: string;
  verified?: boolean;      // true only on the real-staking verified path
  tx_hash?: string;        // the recorded deposit tx hash
}

// A tx_hash that is a placeholder/simulated marker, never a real chain tx.
function isSimulatedTxHash(txHash?: string): boolean {
  return !txHash || txHash.startsWith('simulated:');
}

export async function depositStake(
  builderAddress: string,
  amount: bigint,
  txHash?: string,
): Promise<DepositResult> {
  // A deposit only ever adds. Withdrawals are negative rows in the same column, so a negative
  // "deposit" was indistinguishable from a debit of whatever account it named (Strix on #1550).
  if (amount <= 0n) {
    return { ok: false, builder_id: '', total_active_stake: '0', authority_after: '0', is_simulated: true, error: 'amount must be a positive number of micro-USDC' };
  }
  const lower = builderAddress.toLowerCase();
  const { data: builder, error: bErr } = await db
    .from('builders')
    .select('id, current_repid')
    .ilike('address', lower)
    .maybeSingle();
  if (bErr || !builder) {
    return { ok: false, builder_id: '', total_active_stake: '0', authority_after: '0', is_simulated: true, error: 'builder not found' };
  }

  // -------------------------------------------------------------------------
  // REAL STAKING PATH (flag ON) — verified-deposit escrow model.
  // Requires a real on-chain tx_hash, verified on Base Sepolia, before we
  // record a REAL (is_simulated=false) stake. Rejects simulated/unverified/
  // duplicate(replayed) tx_hashes. Every refusal says is_simulated: true: nothing on it was
  // verified as real stake, and only the one success below may say false (Grok r5 on #1550).
  // -------------------------------------------------------------------------
  if (config.realStakingEnabled) {
    if (isSimulatedTxHash(txHash)) {
      return { ok: false, builder_id: builder.id, total_active_stake: '0', authority_after: '0', is_simulated: true, verified: false, error: 'real staking enabled: a real on-chain tx_hash is required' };
    }
    if (!config.stakeEscrowAddress) {
      return { ok: false, builder_id: builder.id, total_active_stake: '0', authority_after: '0', is_simulated: true, verified: false, error: 'STAKE_ESCROW_ADDRESS not configured' };
    }

    // Duplicate / replay guard: this tx_hash must not already back a REAL stake. Real rows only:
    // the simulated path stores whatever hash the caller sends, so counting simulated rows let a
    // practice deposit naming someone's real transfer block that transfer's claim forever
    // (Strix on #1550). Same scope as stake_deposits_real_tx_hash_uniq.
    const { data: existing } = await db
      .from('stake_deposits')
      .select('id')
      .eq('deposit_tx_hash', txHash!)
      .eq('is_simulated', false)
      .limit(1);
    if (existing && existing.length > 0) {
      return { ok: false, builder_id: builder.id, total_active_stake: '0', authority_after: '0', is_simulated: true, verified: false, error: 'duplicate tx_hash: this deposit was already recorded' };
    }

    const v = await verifyDeposit({
      txHash: txHash!,
      claimedAmount: amount,
      escrowAddress: config.stakeEscrowAddress,
      tokenAddress: config.usdcTokenAddress,
      minConfirmations: config.stakeMinConfirmations,
      fromAddress: lower,
    });
    if (!v.verified) {
      return { ok: false, builder_id: builder.id, total_active_stake: '0', authority_after: '0', is_simulated: true, verified: false, error: `deposit verification failed: ${v.reason ?? 'unknown'}` };
    }

    const { error: realInsErr } = await db.from('stake_deposits').insert({
      builder_id: builder.id,
      amount: amount.toString(),
      status: 'active',
      is_simulated: false,
      deposit_tx_hash: txHash!,
      // No token_address: stake_deposits has no such column (it has `asset`, default 'USDC'), so
      // writing it failed EVERY verified deposit at this insert, after the chain check passed
      // [MEASURED 2026-11-14]. verifyDeposit already pins the token to config.usdcTokenAddress.
    });
    if (realInsErr) {
      // 23505 = stake_deposits_real_tx_hash_uniq: a concurrent claim of the same transfer got there
      // first. Same answer as the read-side guard above, which a race can slip past.
      if ((realInsErr as { code?: string }).code === '23505') {
        return { ok: false, builder_id: builder.id, total_active_stake: '0', authority_after: '0', is_simulated: true, verified: false, error: 'duplicate tx_hash: this deposit was already recorded' };
      }
      return { ok: false, builder_id: builder.id, total_active_stake: '0', authority_after: '0', is_simulated: true, verified: true, error: realInsErr.message };
    }

    const realTotal = await getCurrentStake(builder.id);
    const realAuth = await snapshotAuthority(builder.id, realTotal);
    await emitAuditEvent({
      event_type: 'stake_deposit',
      source_table: 'stake_deposits',
      source_id: `deposit-${builder.id}-${Date.now()}`,
      payload: {
        builder_id: builder.id,
        amount: amount.toString(),
        total_active_stake: realTotal.toString(),
        authority_after: realAuth.authority.toString(),
        is_simulated: false,
        verified: true,
        tx_hash: txHash!,
        observed_amount: v.observedAmount?.toString(),
        confirmations: v.confirmations,
      },
    });
    return {
      ok: true,
      builder_id: builder.id,
      total_active_stake: realTotal.toString(),
      authority_after: realAuth.authority.toString(),
      is_simulated: false,
      verified: true,
      tx_hash: txHash!,
    };
  }

  // -------------------------------------------------------------------------
  // SIMULATED PATH (flag OFF) — unchanged existing accounting behavior.
  // -------------------------------------------------------------------------
  const { error: insErr } = await db.from('stake_deposits').insert({
    builder_id: builder.id,
    amount: amount.toString(),
    status: 'active',
    // Always simulated: nothing on this path checks the chain. It used to read
    // `!process.env.X402_REAL_RPC`, which labelled an UNVERIFIED deposit real whenever that
    // variable was set; the one is_simulated=false row in production is exactly that, a
    // `simulated:deposit:` row [MEASURED 2026-11-14]. Only the verified path above writes false.
    is_simulated: true,
    deposit_tx_hash: txHash ?? `simulated:deposit:${Date.now()}`,
  });
  if (insErr) {
    return { ok: false, builder_id: builder.id, total_active_stake: '0', authority_after: '0', is_simulated: true, error: insErr.message };
  }

  // R3: also write to agent_stakes for substrate exercise >N=1
  (db.from('agent_stakes').insert({
    staker_agent: builder.id,
    stake_amount: Number(amount) / 1_000_000,
    dimension: 'builder_stake',
    status: 'active',
    target_model: 'general'
  }) as any).catch(() => {});

  const total = await getCurrentStake(builder.id);
  const auth = await snapshotAuthority(builder.id, total);

  await emitAuditEvent({
    event_type: 'stake_deposit',
    source_table: 'stake_deposits',
    source_id: `deposit-${builder.id}-${Date.now()}`,
    payload: {
      builder_id: builder.id,
      amount: amount.toString(),
      total_active_stake: total.toString(),
      authority_after: auth.authority.toString(),
      is_simulated: true, // simulated path: nothing here checked the chain
    },
  });

  return {
    ok: true,
    builder_id: builder.id,
    total_active_stake: total.toString(),
    authority_after: auth.authority.toString(),
    is_simulated: true,
  };
}

export interface WithdrawResult {
  ok: boolean;
  total_active_stake: string;
  authority_after: string;
  error?: string;
  refund?: RefundInitiation;   // present on the real-staking path
}

export interface RefundInitiation {
  initiated: boolean;
  stub: boolean;               // true until the on-chain escrow->builder send is wired
  amount: string;
  to?: string;                 // builder payout address
  note?: string;
  txHash?: string;             // the real escrow->builder refund tx, only on a broadcast send
  /**
   * The refund was BROADCAST but its outcome is unknown (the receipt wait failed). It may have
   * moved USDC, so it is handled as sent: the debit row is written and the stake cannot be
   * withdrawn a second time from the shared escrow. Reconcile against the chain.
   */
  unconfirmed?: boolean;
}

/** Any spelling Postgres accepts for a uuid (no hyphens, braces, upper case) in one canonical form. */
export function canonicalUuid(id: string): string | null {
  const s = String(id).replace(/[{}-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export async function withdrawStake(rawBuilderId: string, amount: bigint): Promise<WithdrawResult> {
  // One spelling per account, before the per-builder lock or any query: Postgres resolves an id
  // without hyphens, in braces or in upper case to the same builder, and the in-process withdrawal
  // lock compares strings, so two spellings took two locks and both refunded one stake from the
  // shared escrow (Strix on #1550). A non-uuid id is left as it is; no builder row matches it.
  const builderId = canonicalUuid(rawBuilderId) ?? rawBuilderId;
  // Block if any agent under this builder has open bets.
  // (One-way valve: bets must resolve before stake can move — applies in BOTH
  // simulated and real modes.)
  const { data: openBets } = await db
    .from('linked_bets')
    .select('id, agent_id, repid_agents!inner(builder_id)')
    .eq('status', 'open')
    .eq('repid_agents.builder_id', builderId)
    .limit(1);
  if (openBets && openBets.length > 0) {
    return { ok: false, total_active_stake: '0', authority_after: '0', error: 'cannot withdraw with open bets' };
  }

  const total = await getCurrentStake(builderId);
  if (amount > total) {
    return { ok: false, total_active_stake: total.toString(), authority_after: '0', error: 'amount exceeds active stake' };
  }

  // -------------------------------------------------------------------------
  // REAL STAKING WITHDRAWAL (flag ON) — checks a REAL recorded stake backs the
  // requested amount, then (stub) initiates the escrow->builder refund.
  // Custody / withdrawal-authorization model is FLAGGED for human review.
  // -------------------------------------------------------------------------
  if (config.realStakingEnabled) {
    // Serialize per builder: read realTotal -> broadcast refund -> debit happens as
    // one critical section, so two concurrent withdrawals cannot both pass the check.
    return serializeWithdraw(builderId, async (): Promise<WithdrawResult> => {
    const realTotal = await getRealStake(builderId);
    if (amount > realTotal) {
      return { ok: false, total_active_stake: total.toString(), authority_after: '0', error: 'amount exceeds real (verified) active stake' };
    }

    // OWNER BUDGET: stake that backs agent spending already made or reserved stays put, or the
    // owner's agents would have spent against collateral that left (same invariant as
    // reserve_owner_spend, src/services/owner-budget.ts). In enforce mode the withdrawal HOLDS its
    // amount through that same function, under the same per-owner lock, before the refund is sent,
    // so a concurrent spend sees it as committed and cannot take it. After the refund, the debit
    // row and the release happen in one transaction (complete_stake_withdrawal). The hold is
    // released on its own only when the refund definitely did not happen; anything unclear keeps it.
    // This comment used to say every real withdrawal was refused because the refund was a stub.
    // FALSE in production: the escrow signer is set and GET /api/v1/stake/escrow/health reports
    // "a real escrow→builder refund can be broadcast" [MEASURED 2026-11-14].
    const budgetMode = ownerBudgetMode();
    let hold: string | null = null;
    if (budgetMode === 'enforce') {
      let r;
      try {
        r = await supabaseOwnerBudget.reserve(builderId, WITHDRAWAL_HOLD_AGENT, amount);
      } catch {
        return { ok: false, total_active_stake: total.toString(), authority_after: '0', error: 'owner_budget_not_checked' };
      }
      if (!r.ok || !r.id) {
        return { ok: false, total_active_stake: total.toString(), authority_after: '0', error: 'stake_backs_agent_spend' };
      }
      hold = r.id;
    } else if (budgetMode === 'shadow') {
      try {
        const s = await supabaseOwnerBudget.status(builderId);
        if (s.budget - amount < s.committed) {
          console.warn(`[owner-budget] shadow: WOULD REFUSE withdrawal of ${amount} by builder ${builderId}: committed agent spend ${s.committed} of funded ${s.budget}`);
        }
      } catch (e: unknown) {
        console.warn(`[owner-budget] shadow: budget read failed for builder ${builderId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const endHold = (state: 'released' | 'unknown', txHash: string | null, why: string) =>
      hold
        ? supabaseOwnerBudget.finish(hold, state, txHash, why).catch((e: unknown) =>
            console.error(`[owner-budget] withdrawal hold ${hold} could not be marked ${state}; it stays reserved and keeps counting: ${e instanceof Error ? e.message : String(e)}`))
        : Promise.resolve();

    // Builder payout address (where the escrow refund is sent).
    const { data: builder } = await db
      .from('builders')
      .select('address')
      .eq('id', builderId)
      .maybeSingle();

    // FAIL-CLOSED: attempt the escrow->builder refund FIRST. The ledger debit
    // (negative stake_deposits row) is only committed when a REAL, broadcast
    // refund is confirmed. If the refund is still a stub (not broadcast
    // on-chain) or otherwise did not actually initiate, we write NOTHING to the
    // ledger and refuse — otherwise the ledger would show the stake withdrawn
    // while the USDC was never sent (funds stranded).
    const refund = await refundInitiator(builderId, amount, builder?.address ?? undefined);
    if (refund.stub || !refund.initiated) {
      await endHold('released', null, 'withdrawal refused: the refund was not sent');
      return {
        ok: false,
        total_active_stake: total.toString(),
        authority_after: '0',
        error: 'refund_unavailable_stub',
        refund,
      };
    }

    // Refund is real + broadcast — safe to record the withdrawal as REAL. The
    // negative row keeps getCurrentStake / getRealStake consistent.
    // Tie the ledger debit to the real on-chain refund tx (not a sentinel), so the
    // row is auditable and a later idempotency/dedupe guard has a key to match on.
    const debitHash = refund.txHash ?? `pending-refund:${Date.now()}`;
    if (hold) {
      // ENFORCE: release the hold and write the debit row in ONE transaction
      // (complete_stake_withdrawal). As two steps, funded dropped while the hold still counted, so
      // committed briefly exceeded funded, and a failed release left the hold stuck after a
      // withdrawal that had succeeded (Grok r6 on #1550).
      try {
        await supabaseOwnerBudget.completeWithdrawal(hold, builderId, amount, debitHash);
      } catch (e: unknown) {
        // The refund WAS sent but nothing was recorded: funded still reads high, so the hold must
        // keep counting until someone reconciles this against the chain.
        const msg = e instanceof Error ? e.message : String(e);
        await endHold('unknown', refund.txHash ?? null, `refund sent, debit not recorded: ${msg}`);
        return { ok: false, total_active_stake: total.toString(), authority_after: '0', error: msg };
      }
    } else {
      const { error: wErr } = await db.from('stake_deposits').insert({
        builder_id: builderId,
        amount: (-amount).toString(),
        status: 'withdrawn',
        is_simulated: false,
        // No token_address: the column does not exist (see the deposit insert above).
        deposit_tx_hash: debitHash,
      });
      if (wErr) {
        return { ok: false, total_active_stake: total.toString(), authority_after: '0', error: wErr.message };
      }
    }

    const newTotal = await getCurrentStake(builderId);
    const auth = await snapshotAuthority(builderId, newTotal);
    await emitAuditEvent({
      event_type: 'stake_withdraw',
      source_table: 'stake_deposits',
      source_id: `withdraw-${builderId}-${Date.now()}`,
      payload: {
        builder_id: builderId,
        amount: amount.toString(),
        total_active_stake: newTotal.toString(),
        authority_after: auth.authority.toString(),
        is_simulated: false,
        refund_stub: refund.stub,
        refund_to: refund.to,
        refund_tx_hash: refund.txHash ?? null,
        refund_unconfirmed: refund.unconfirmed === true,
      },
    });
    return { ok: true, total_active_stake: newTotal.toString(), authority_after: auth.authority.toString(), refund };
    });
  }

  // -------------------------------------------------------------------------
  // SIMULATED WITHDRAWAL (flag OFF) — unchanged existing accounting behavior.
  // -------------------------------------------------------------------------
  await db.from('stake_deposits').insert({
    builder_id: builderId,
    amount: (-amount).toString(),
    status: 'withdrawn',
    is_simulated: true, // simulated: no refund was sent, so it must not reduce REAL stake (owner_funded_stake counts real negative rows)
    deposit_tx_hash: `simulated:withdraw:${Date.now()}`,
  });

  const newTotal = await getCurrentStake(builderId);
  const auth = await snapshotAuthority(builderId, newTotal);
  return { ok: true, total_active_stake: newTotal.toString(), authority_after: auth.authority.toString() };
}

/**
 * Sum of REAL (is_simulated=false) stake rows for a builder — the amount the
 * escrow actually custodies and can refund. Simulated rows are excluded.
 */
export async function getRealStake(builderId: string): Promise<bigint> {
  const { data } = await db
    .from('stake_deposits')
    .select('amount')
    .eq('builder_id', builderId)
    .eq('is_simulated', false);
  if (!data) return 0n;
  return data.reduce((acc, r) => acc + BigInt(r.amount), 0n);
}

/**
 * STUB: escrow -> builder USDC refund. Returns an initiation record but does
 * NOT sign/broadcast an on-chain transfer yet. Wiring the real send depends on
 * the custody / withdrawal-authorization model (FLAGGED for Sean's review).
 */
export async function initiateEscrowRefund(
  builderId: string,
  amount: bigint,
  to?: string,
): Promise<RefundInitiation> {
  return {
    initiated: true,
    stub: true,
    amount: amount.toString(),
    to,
    note: 'escrow->builder refund not yet broadcast on-chain (custody model pending review)',
  };
}

// Injectable seam (mirrors deposit-verifier's __setProviderFactory) so the
// fail-closed withdrawal guard can be exercised against a REAL (non-stub)
// refund in unit tests without wiring a live escrow signer. Defaults to the
// real stub above; production behavior is unchanged.
type RefundInitiator = (
  builderId: string,
  amount: bigint,
  to?: string,
) => Promise<RefundInitiation>;

// DEFAULT: the real escrow->builder refunder (escrow-refunder.ts). It is FAIL-CLOSED —
// with STAKE_ESCROW_SIGNER_KEY unset it returns a stub and withdrawal refuses, exactly as
// the bare stub did, so production is unchanged until the key is set. Tests override via
// __setRefundInitiator; initiateEscrowRefund above remains the explicit stub.
let refundInitiator: RefundInitiator = escrowRefund;

export function __setRefundInitiator(f?: RefundInitiator): void {
  refundInitiator = f ?? initiateEscrowRefund;
}

export async function getCurrentStake(builderId: string): Promise<bigint> {
  const { data } = await db
    .from('stake_deposits')
    .select('amount')
    .eq('builder_id', builderId);
  if (!data) return 0n;
  return data.reduce((acc, r) => acc + BigInt(r.amount), 0n);
}

// ---------------------------------------------------------------------------
// Snapshot — recomputes authority for a builder using their owned-agent
// roster. Used by the demo timeline + on every deposit/withdraw.
// ---------------------------------------------------------------------------

export interface SnapshotResult {
  authority: bigint;
  basis: {
    stake: string;
    stake_sqrt: string;
    builder_repid: number;
    agents: Array<{ id: string; name: string; current_repid: number; wisdom_score: number; character_score: number }>;
    combined_score_used: string;
    /** LOSSY — `floor_check !== 'FAILED'`. Reports true for a bypass that never ran the floor. */
    floor_passed: boolean;
    /** AUTHORITATIVE: whether BUILDER_FLOOR was actually evaluated, and what it said. */
    floor_check: FloorCheck;
  };
}

export async function snapshotAuthority(builderId: string, totalStake?: bigint): Promise<SnapshotResult> {
  const stake = totalStake ?? await getCurrentStake(builderId);

  const { data: builder } = await db
    .from('builders')
    .select('id, current_repid, auth_method')
    .eq('id', builderId)
    .single();
  const builderRepId = Number(builder?.current_repid ?? 0);

  const { data: agents } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, wisdom_score, character_score, last_active_at')
    .eq('builder_id', builderId);

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const active = (agents ?? []).filter(a => {
    const ts = a.last_active_at ? new Date(a.last_active_at).getTime() : Date.now();
    return ts > sevenDaysAgo;
  });
  const meanR = active.length > 0
    ? Math.round(active.reduce((s, a) => s + Number(a.current_repid ?? 0), 0) / active.length)
    : 0;
  const meanW = active.length > 0
    ? Math.round(active.reduce((s, a) => s + Number(a.wisdom_score ?? 1000), 0) / active.length)
    : 1000;
  const meanC = active.length > 0
    ? Math.round(active.reduce((s, a) => s + Number(a.character_score ?? 1000), 0) / active.length)
    : 1000;

  const isDemoBuilder = builder?.auth_method === 'token_only';

  const auth = computeAuthority({
    stakeAmount: stake,
    agentRepId: meanR,
    agentWisdom: meanW,
    agentCharacter: meanC,
    builderRepId,
    isDemoBuilder,
  });

  await db.from('stake_authority_snapshots').insert({
    builder_id: builderId,
    computed_authority: auth.authority.toString(),
    basis: {
      stake: stake.toString(),
      stake_sqrt: auth.breakdown.stakeSqrt,
      builder_repid: builderRepId,
      agent_count_active: active.length,
      mean_R: meanR,
      mean_W: meanW,
      mean_C: meanC,
      combined_score_used: auth.breakdown.combinedScore,
      floor_passed: auth.breakdown.builderFloorPassed,
      // The authoritative one. `floor_passed` above is lossy — it reads true for a bypass
      // that never evaluated the floor — and is kept only so existing readers of these rows
      // do not change meaning underneath them.
      floor_check: auth.breakdown.floorCheck,
    },
  });

  return {
    authority: auth.authority,
    basis: {
      stake: stake.toString(),
      stake_sqrt: auth.breakdown.stakeSqrt,
      builder_repid: builderRepId,
      agents: (agents ?? []).map(a => ({
        id: a.id,
        name: a.agent_name,
        current_repid: Number(a.current_repid ?? 0),
        wisdom_score: Number(a.wisdom_score ?? 1000),
        character_score: Number(a.character_score ?? 1000),
      })),
      combined_score_used: auth.breakdown.combinedScore,
      floor_passed: auth.breakdown.builderFloorPassed,
      // The authoritative one. `floor_passed` above is lossy — it reads true for a bypass
      // that never evaluated the floor — and is kept only so existing readers of these rows
      // do not change meaning underneath them.
      floor_check: auth.breakdown.floorCheck,
    },
  };
}

// R3: clean GA handoff + exercise >N=1. Call recordDeposit multiple times for varied flows.
export async function recordDeposit(agentId: string, amountUsdc: number | bigint, txHash?: string) {
  return depositStake(String(agentId), BigInt(amountUsdc), txHash);
}

export { recordSponsorship } from './sponsorship';
