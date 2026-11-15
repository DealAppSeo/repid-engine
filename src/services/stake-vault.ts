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

import { randomUUID } from 'crypto';
import { db } from '../db';
import { config } from '../config';
import { emitAuditEvent } from './audit-emit';
import { BUILDER_FLOOR, computeAuthority, babylonianSqrt, type FloorCheck } from './authority-math';
import { recordSponsorship } from './sponsorship'; // R3 exercise + GA handoff
import { verifyDeposit } from './deposit-verifier';
import { escrowRefund } from './escrow-refunder';
import { ownerBudgetMode, supabaseOwnerBudget } from './owner-budget';

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
    const escrowAddress = config.stakeEscrowAddress;
    // ONE SPELLING PER TRANSFER: a tx hash is hex, and a claim spelled in other letter case is the same
    // transfer. The lock key below was lower-cased but the replay check and the insert used the hash as
    // given, so two claims differing only in case each saw no earlier row (Grok r15b on #1550).
    const hash = String(txHash).toLowerCase();

    // ONE CLAIM PER TRANSFER AT A TIME. The guard below is a read, then several chain round trips,
    // then the insert; two parallel claims of one transfer both passed the read and both inserted,
    // crediting 2x the stake, wherever the unique index (stake_deposits_real_tx_hash_uniq) is not
    // applied yet (Strix on #1550). Serialized per hash in-process: the engine runs one replica.
    return serializeWithdraw(`deposit:${hash}`, async (): Promise<DepositResult> => {
    // Duplicate / replay guard: this tx_hash must not already back a REAL stake. Real rows only:
    // the simulated path stores whatever hash the caller sends, so counting simulated rows let a
    // practice deposit naming someone's real transfer block that transfer's claim forever
    // (Strix on #1550). Same scope as stake_deposits_real_tx_hash_uniq.
    const { data: existing } = await db
      .from('stake_deposits')
      .select('id')
      .eq('deposit_tx_hash', hash)
      .eq('is_simulated', false)
      .limit(1);
    if (existing && existing.length > 0) {
      return { ok: false, builder_id: builder.id, total_active_stake: '0', authority_after: '0', is_simulated: true, verified: false, error: 'duplicate tx_hash: this deposit was already recorded' };
    }

    const v = await verifyDeposit({
      txHash: hash,
      claimedAmount: amount,
      escrowAddress,
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
      deposit_tx_hash: hash,
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
        tx_hash: hash,
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
      tx_hash: hash,
    };
    });
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

    // ONE RECORD, WRITTEN BEFORE THE MONEY MOVES. The debit row (status 'withdrawing') is written
    // before the escrow refund is sent, and no refund is attempted unless it landed. Negative rows
    // always count, both in the owner's shared budget (owner_funded_stake) and in the refund bound
    // (getRealStake), so from that moment the stake can be neither spent by agents nor refunded a
    // second time. After the refund it is stamped 'withdrawn' with the refund hash, or zeroed as
    // 'withdraw_failed' (kept for the audit trail) when the refund definitely did not happen; if
    // either write fails, the row keeps counting, which is the safe direction for the shared escrow.
    // In enforce mode the debit is written by begin_stake_withdrawal, under the per-owner lock, only
    // if the stake left still covers the owner's committed agent spend. Two earlier designs used a
    // separate ledger hold and wrote the debit afterwards; each left a window where the two
    // disagreed (Grok r6; Strix, both on #1550). An earlier comment here also said every real
    // withdrawal was refused because the refund was a stub: FALSE in production, where the escrow
    // signer is set and GET /api/v1/stake/escrow/health reports a real refund can be broadcast
    // [MEASURED 2026-11-14].
    const budgetMode = ownerBudgetMode();
    let pendingDebit: string;
    if (budgetMode === 'enforce') {
      let r;
      try {
        r = await supabaseOwnerBudget.beginWithdrawal(builderId, amount);
      } catch {
        return { ok: false, total_active_stake: total.toString(), authority_after: '0', error: 'owner_budget_not_checked' };
      }
      if (!r.ok || !r.debitId) {
        return { ok: false, total_active_stake: total.toString(), authority_after: '0', error: 'stake_backs_agent_spend' };
      }
      pendingDebit = r.debitId;
    } else {
      if (budgetMode === 'shadow') {
        try {
          const s = await supabaseOwnerBudget.status(builderId);
          if (s.budget - amount < s.committed) {
            console.warn(`[owner-budget] shadow: WOULD REFUSE withdrawal of ${amount} by builder ${builderId}: committed agent spend ${s.committed} of funded ${s.budget}`);
          }
        } catch (e: unknown) {
          console.warn(`[owner-budget] shadow: budget read failed for builder ${builderId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      pendingDebit = randomUUID();
      const { error: pErr } = await db.from('stake_deposits').insert({
        id: pendingDebit,
        builder_id: builderId,
        amount: (-amount).toString(),
        status: 'withdrawing',
        is_simulated: false,
        // No token_address: the column does not exist (see the deposit insert above).
        deposit_tx_hash: `pending-refund:${pendingDebit}`,
      });
      if (pErr) {
        return { ok: false, total_active_stake: total.toString(), authority_after: '0', error: `could not record the withdrawal before the refund, so no refund was sent: ${pErr.message}` };
      }
    }

    // Builder payout address (where the escrow refund is sent).
    const { data: builder } = await db
      .from('builders')
      .select('address')
      .eq('id', builderId)
      .maybeSingle();

    // FAIL-CLOSED: a refund that is a stub or definitely did not happen voids the debit.
    const refund = await refundInitiator(builderId, amount, builder?.address ?? undefined);
    if (refund.stub || !refund.initiated) {
      // Retried: a void that never lands leaves the builder's stake reading short with no payout
      // (Grok r12 on #1550). If every attempt fails it is logged with the row id to fix by hand.
      let vErr: { message: string } | null = null;
      for (let i = 0; i < 3; i++) {
        ({ error: vErr } = await db.from('stake_deposits').update({ amount: '0', status: 'withdraw_failed' }).eq('id', pendingDebit));
        if (!vErr) break;
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
      if (vErr) console.error(`[stake-vault] pending debit ${pendingDebit} could not be voided after a refund that was not sent; the stake reads LOW until fixed: ${vErr.message}`);
      return {
        ok: false,
        total_active_stake: total.toString(),
        authority_after: '0',
        error: 'refund_unavailable_stub',
        refund,
      };
    }

    // The refund was sent (or may have been): stamp the debit with it. Tie the ledger debit to the
    // real on-chain refund tx (not a sentinel), so the row is auditable. If the stamp fails the row
    // stays a pending debit, which still counts, so nothing is refundable twice.
    const debitHash = refund.txHash ?? `pending-refund:${pendingDebit}`;
    // An UNCONFIRMED refund (broadcast, outcome unknown) keeps its debit counting so the stake cannot
    // be refunded again, but it is not reported as done: status withdraw_unconfirmed and ok:false,
    // so it is visible to reconcile against the chain instead of passing as a finished withdrawal.
    const finalStatus = refund.unconfirmed ? 'withdraw_unconfirmed' : 'withdrawn';
    const { error: sErr } = await db.from('stake_deposits').update({ status: finalStatus, deposit_tx_hash: debitHash }).eq('id', pendingDebit);
    if (sErr) console.error(`[stake-vault] withdrawal debit ${pendingDebit} (refund ${debitHash}) could not be stamped; it still counts as withdrawn: ${sErr.message}`);
    if (refund.unconfirmed) {
      await emitAuditEvent({
        event_type: 'stake_withdraw',
        source_table: 'stake_deposits',
        source_id: `withdraw-${builderId}-${Date.now()}`,
        payload: { builder_id: builderId, amount: amount.toString(), is_simulated: false, refund_tx_hash: refund.txHash ?? null, refund_unconfirmed: true },
      });
      return { ok: false, total_active_stake: total.toString(), authority_after: '0', error: 'refund_unconfirmed', refund };
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
        refund_unconfirmed: false, // an unconfirmed refund returned above with its own audit entry
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
/**
 * Stake the escrow actually received, the bound on a REAL escrow refund. Same rule as
 * owner_funded_stake (supabase/migrations/20261114200000_owner_spend_ledger.sql): a positive row
 * counts only with a real 0x transaction hash; a withdrawal (negative row) always counts. It used
 * to trust the is_simulated label alone, and production holds a 50 USDC row labelled real that is
 * a `simulated:deposit:` row, so that account could be refunded real USDC from the escrow other
 * builders funded (Strix on #1550).
 */
export async function getRealStake(builderId: string): Promise<bigint> {
  const { data } = await db
    .from('stake_deposits')
    .select('amount, deposit_tx_hash')
    .eq('builder_id', builderId)
    .eq('is_simulated', false);
  if (!data) return 0n;
  return data.reduce((acc: bigint, r: { amount: unknown; deposit_tx_hash?: unknown }) => {
    const a = BigInt(String(r.amount));
    return a < 0n || /^0x[0-9a-fA-F]{64}$/.test(String(r.deposit_tx_hash ?? '')) ? acc + a : acc;
  }, 0n);
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
