/**
 * Escrow refunder — the WITHDRAWAL leg of the verified-deposit escrow model, the
 * mirror of deposit-verifier.ts. Broadcasts a real escrow -> builder USDC transfer
 * on Base Sepolia so a real stake can actually be withdrawn end-to-end.
 *
 * FAIL-CLOSED BY DEFAULT. Until STAKE_ESCROW_SIGNER_KEY is set this returns a STUB
 * (`stub: true`), and stake-vault's withdrawStake refuses on a stub — so a refund is
 * never recorded in the ledger while the USDC was not actually sent. Setting the key
 * is the only thing that turns on a real send; nothing else changes.
 *
 * Three invariants a real send must satisfy, or it refuses (and withdrawal fails closed):
 *   1. CHAIN   — eth_chainId is 84532. Any other id, or an unreadable id, refuses.
 *                This box never sends on a chain that is not Base Sepolia testnet.
 *   2. SIGNER  — the configured key's address EQUALS stakeEscrowAddress. A refund must
 *                debit the escrow that custodies the stake; a different signer would
 *                move someone else's funds and desync the ledger.
 *   3. PAYEE   — `to` is a valid address. A missing/invalid payee refuses before any send.
 *
 * Any failure (bad payee, wrong chain, signer != escrow, revert, rpc error) returns
 * `{ initiated: false }` — never a silent partial. The ethers signer is injectable
 * (__setEscrowSender) so this is unit-testable without a live RPC or a funded key.
 */

import { ethers } from 'ethers';
import { config } from '../config';
import { BASE_SEPOLIA_CHAIN_ID } from './testnet-only';
import type { RefundInitiation } from './stake-vault';
import { revertedReceipt } from './agent-spend';

/**
 * The refund transaction was BROADCAST and then the wait for its receipt failed (a timeout, a
 * dropped RPC). It may have moved USDC. escrowRefund reports it as initiated + unconfirmed, never
 * as "did not happen": before this, a broadcast refund whose wait threw was reported as not sent,
 * so no debit row was written and the same stake could be withdrawn again from the shared escrow
 * (found reviewing #1550).
 */
export class RefundBroadcastUnconfirmed extends Error {
  constructor(readonly txHash: string, detail: string) {
    super(`refund ${txHash} was broadcast but its outcome is unknown: ${detail}`);
    this.name = 'RefundBroadcastUnconfirmed';
  }
}

/**
 * The broadcast call itself failed. Only an explicit rejection by the node means the transaction
 * was not accepted; a timeout or a lost reply may still have put it in the mempool, so that is
 * unconfirmed (handled as sent). NONCE_EXPIRED is not decided here: realSender looks up our own
 * receipt first (nonceExpiredOutcome); reaching this function with it means unconfirmed.
 */
const NODE_REJECTED = new Set(['INSUFFICIENT_FUNDS', 'REPLACEMENT_UNDERPRICED']);
/** A node reply that means the transaction IS in the mempool, so it may still land. */
const NODE_SAYS_IN_MEMPOOL = /already known|known transaction|already imported|already in (the )?(mem|tx)pool/i;

/** The node's own JSON-RPC error reply, if the failure carries one (ethers keeps it on `error` or `info.error`). */
function nodeReply(e: unknown): string | null {
  const x = e as { error?: { message?: unknown } | null; info?: { error?: { message?: unknown } | null } | null } | null;
  const m = x?.error?.message ?? x?.info?.error?.message;
  return typeof m === 'string' && m.trim() !== '' ? m : null;
}

/**
 * Which JSON-RPC request the failure belongs to. ethers v6 `broadcastTransaction` resolves
 * eth_blockNumber and eth_chainId TOGETHER with eth_sendRawTransaction, so an error reply on one of
 * the reads can sink the call while the send itself was accepted (Strix on #1550). Only a reply to
 * the send proves the refund was refused.
 */
function failedMethod(e: unknown): string | null {
  const x = e as { payload?: { method?: unknown } | null; info?: { payload?: { method?: unknown } | null } | null } | null;
  const m = x?.payload?.method ?? x?.info?.payload?.method;
  return typeof m === 'string' ? m : null;
}

/**
 * The broadcast call failed. A failure that carries the NODE'S OWN reply is the node refusing the
 * transaction, so nothing was sent; ethers turns most refusals ("transaction underpriced",
 * "intrinsic gas too low", "max fee per gas less than block base fee", "invalid sender") into
 * UNKNOWN_ERROR with that reply attached, and counting them as "may have landed" stamped a debit
 * `withdrawn` while no USDC moved (Strix on #1550). The exception is a reply saying the
 * transaction is already in the mempool. A failure with NO reply (a timeout, a dropped connection,
 * an HTTP error) may have reached the node: unconfirmed. NONCE_EXPIRED is decided by realSender
 * first (nonceExpiredOutcome).
 */
export function broadcastFailure(e: unknown, txHash: string): Error {
  const code = (e as { code?: unknown } | null)?.code;
  const detail = e instanceof Error ? e.message.split('\n')[0] ?? '' : String(e);
  // A reply proves a refusal only when it answers the SEND; a failed co-batched read proves nothing.
  if (failedMethod(e) !== 'eth_sendRawTransaction') {
    return new RefundBroadcastUnconfirmed(txHash, `broadcast outcome unknown (${failedMethod(e) ?? 'no request named'}): ${detail}`);
  }
  if (typeof code === 'string' && NODE_REJECTED.has(code)) return new Error(`refund ${txHash} rejected by the node before broadcast (${code}): ${detail}`);
  const reply = nodeReply(e);
  if (reply !== null && !NODE_SAYS_IN_MEMPOOL.test(reply)) return new Error(`refund ${txHash} rejected by the node: ${reply}`);
  return new RefundBroadcastUnconfirmed(txHash, `broadcast reply not received: ${detail}`);
}

/**
 * "nonce too low" on broadcast: that nonce is already used by a MINED transaction. If our own
 * hash has a receipt, it was ours and its status decides; if it has none, another transaction took
 * the nonce and ours can never be mined, so nothing was sent. Classifying it as unconfirmed (as a
 * blanket rule) debited a builder whose refund never went out when two withdrawals raced the one
 * escrow nonce (Grok r9 on #1550). `undefined` = the lookup itself failed: unconfirmed.
 */
export function nonceExpiredOutcome(receipt: { status: number | null } | null | undefined, txHash: string): { txHash: string } | Error {
  if (receipt === undefined) return new RefundBroadcastUnconfirmed(txHash, 'nonce too low and the receipt lookup failed');
  if (receipt === null) return new Error(`refund ${txHash} was not sent: its nonce was used by another transaction, so it can never be mined`);
  if (receipt.status === 1) return { txHash };
  if (receipt.status === 0) return new Error(`refund ${txHash} reverted on-chain (status 0)`);
  return new RefundBroadcastUnconfirmed(txHash, `nonce too low; receipt status ${receipt.status}`);
}

/**
 * ONE escrow wallet means ONE nonce sequence: refunds for different builders (different
 * withdrawal locks) raced it and collided (Grok r9 on #1550), so every send runs one at a time.
 * ponytail: in-process. Correct while this is the only code that signs with the escrow key (it is)
 * and the engine runs one replica (numReplicas 1, read 2026-10-04); move to a Postgres advisory
 * lock if either changes.
 */
let escrowQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = escrowQueue.then(fn, fn);
  escrowQueue = run.catch(() => undefined);
  return run;
}

/**
 * After broadcast, only PROOF settles the outcome; anything else may have moved USDC (unconfirmed).
 * Proof that nothing was sent: a status-0 receipt, or ethers v6's TRANSACTION_REPLACED with
 * `cancelled: true` (a different transaction was mined under our nonce, so ours never will be).
 * Proof that it WAS sent: TRANSACTION_REPLACED 'repriced' (the same transfer re-sent at a higher fee)
 * with a status-1 receipt, under the replacement's hash. Treating every replacement as "may have
 * landed" booked a cancelled refund as paid with no USDC sent (Strix on #1550).
 */
export function refundWaitFailure(e: unknown, txHash: string): Error | { txHash: string } {
  if (revertedReceipt(e)) return new Error(`refund ${txHash} reverted on-chain (status 0)`);
  const r = e as { code?: unknown; cancelled?: unknown; reason?: unknown; hash?: unknown; receipt?: { status?: unknown; hash?: unknown } | null } | null;
  if (r?.code === 'TRANSACTION_REPLACED') {
    if (r.cancelled === true) return new Error(`refund ${txHash} was ${String(r.reason)} before it was mined: nothing was sent`);
    if (r.reason === 'repriced' && r.receipt?.status === 0) return new Error(`refund ${txHash} was re-priced and the replacement reverted (status 0)`);
    if (r.reason === 'repriced' && r.receipt?.status === 1) {
      const landed = typeof r.receipt.hash === 'string' ? r.receipt.hash : typeof r.hash === 'string' ? r.hash : null;
      if (landed) return { txHash: landed };
    }
  }
  return new RefundBroadcastUnconfirmed(txHash, e instanceof Error ? e.message.split('\n')[0] ?? '' : String(e));
}

const ERC20_ABI = ['function transfer(address to, uint256 value) returns (bool)'];
const ERC20_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)'];

/** The chain write, abstracted so tests exercise the guard logic without a live chain. */
export type EscrowSender = (to: string, amount: bigint) => Promise<{ txHash: string }>;

let sender: EscrowSender | null = null;

/** Test seam: inject a fake on-chain sender. Call with undefined to reset to the real one. */
export function __setEscrowSender(s?: EscrowSender | null): void {
  sender = s ?? null;
}

function isAddress(a: unknown): a is string {
  return typeof a === 'string' && ethers.isAddress(a);
}

function eqAddr(a: string, b: string): boolean {
  try {
    return ethers.getAddress(a) === ethers.getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

function stub(amount: bigint, to: string | undefined, note: string): RefundInitiation {
  return { initiated: true, stub: true, amount: amount.toString(), to, note };
}

function refused(amount: bigint, to: string | undefined, note: string): RefundInitiation {
  // initiated:false, stub:false — a real refund was ATTEMPTED and did not happen.
  // stake-vault treats this exactly like a stub: it refuses and writes no ledger debit.
  return { initiated: false, stub: false, amount: amount.toString(), to, note };
}

/**
 * The real escrow -> builder send. Refuses unless the chain is Base Sepolia and the
 * signer IS the escrow address. Throws on any failure so escrowRefund fails closed.
 */
async function realSender(to: string, amount: bigint): Promise<{ txHash: string }> {
  if (!config.stakeEscrowSignerKey) throw new Error('escrow signer not configured');
  if (!config.stakeEscrowAddress) throw new Error('STAKE_ESCROW_ADDRESS not configured');
  const provider = new ethers.JsonRpcProvider(config.baseSepoliaRpc);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`refusing: chain ${net.chainId} is not Base Sepolia (${BASE_SEPOLIA_CHAIN_ID})`);
  }
  const wallet = new ethers.Wallet(config.stakeEscrowSignerKey, provider);
  if (!eqAddr(wallet.address, config.stakeEscrowAddress)) {
    throw new Error('escrow signer address does not match STAKE_ESCROW_ADDRESS');
  }
  const usdc = new ethers.Contract(config.usdcTokenAddress, ERC20_ABI, wallet);
  // SIGN LOCALLY, THEN BROADCAST, so the hash is known before anything goes on the wire. As one
  // call (`usdc.transfer(...)`), a broadcast whose RPC reply was lost (a timeout after the node had
  // accepted it) threw with no hash, escrowRefund reported "did not happen", no debit was written,
  // and the refund could still land (Grok r8 on #1550). Anything that fails BEFORE the broadcast
  // (building the transaction, a gas estimate that reverts) still means nothing was sent.
  // getFunction returns a defined ContractMethod (satisfies noUncheckedIndexedAccess).
  const unsigned = await wallet.populateTransaction(await usdc.getFunction('transfer').populateTransaction(to, amount));
  const signed = await wallet.signTransaction(unsigned);
  const hash = ethers.Transaction.from(signed).hash;
  if (!hash) throw new Error('refusing: could not derive the refund tx hash before broadcast');
  let tx: ethers.TransactionResponse;
  try {
    tx = await provider.broadcastTransaction(signed);
  } catch (e: unknown) {
    if ((e as { code?: unknown } | null)?.code === 'NONCE_EXPIRED') {
      // Was the mined transaction holding this nonce ours? Re-check briefly: a load-balanced RPC
      // can answer "nonce too low" from a node that is ahead of the one serving the receipt.
      let mine: Awaited<ReturnType<typeof provider.getTransactionReceipt>> | undefined;
      for (let i = 0; i < 4; i++) {
        mine = await provider.getTransactionReceipt(hash).catch(() => undefined);
        if (mine !== null) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      const out = nonceExpiredOutcome(mine, hash);
      if (out instanceof Error) throw out;
      return out;
    }
    throw broadcastFailure(e, hash);
  }
  // From here the transfer is on the wire.
  let receipt;
  try {
    receipt = await tx.wait(Math.max(1, config.stakeMinConfirmations));
  } catch (e: unknown) {
    const outcome = refundWaitFailure(e, tx.hash);
    if (outcome instanceof Error) throw outcome;
    return outcome; // re-priced and landed: the replacement's hash is the refund
  }
  if (receipt?.status === 0) throw new Error(`refund ${tx.hash} reverted on-chain (status 0)`);
  if (!receipt || receipt.status !== 1) throw new RefundBroadcastUnconfirmed(tx.hash, `no confirmed receipt (status ${receipt?.status ?? 'none'})`);
  return { txHash: tx.hash };
}

// --- Read-only escrow health (verify config WITHOUT spending or exposing the key) ---
//
// Answers the one question an operator has right after setting STAKE_ESCROW_ADDRESS +
// STAKE_ESCROW_SIGNER_KEY in Railway: "did I set it right?" — without broadcasting a
// transaction and without the private key ever leaving the process. It reports only
// public facts (the escrow ADDRESS, on-chain balances) and booleans; never the key.

/** What the chain reader fetches. Injected so this is unit-testable without an RPC. */
export interface EscrowChainReading {
  chainId: number | null; // null = RPC unreachable (NOT_CHECKED, never asserted as agreeing)
  usdc: bigint | null; // escrow USDC balance (6dp raw), null = not read
  eth: bigint | null; // escrow native ETH balance (wei), null = not read
}
export type EscrowChainReader = (escrowAddress: string) => Promise<EscrowChainReading>;

let chainReader: EscrowChainReader | null = null;

/** Test seam: inject a fake chain reader. Call with undefined to reset to the real one. */
export function __setEscrowChainReader(r?: EscrowChainReader | null): void {
  chainReader = r ?? null;
}

async function realChainReader(escrowAddress: string): Promise<EscrowChainReading> {
  const out: EscrowChainReading = { chainId: null, usdc: null, eth: null };
  const provider = new ethers.JsonRpcProvider(config.baseSepoliaRpc);
  try {
    const net = await provider.getNetwork();
    out.chainId = Number(net.chainId);
  } catch {
    return out; // RPC unreachable → leave everything NOT_CHECKED
  }
  try {
    out.eth = await provider.getBalance(escrowAddress);
  } catch {
    /* leave null */
  }
  try {
    const usdc = new ethers.Contract(config.usdcTokenAddress, ERC20_BALANCE_ABI, provider);
    out.usdc = (await usdc.getFunction('balanceOf')(escrowAddress)) as bigint;
  } catch {
    /* leave null */
  }
  return out;
}

export interface EscrowHealth {
  configured: boolean; // both key + address present
  escrowAddress: string | null; // public; never the key
  // Derived from the key in-process and compared to STAKE_ESCROW_ADDRESS. A refund
  // REFUSES unless this is VERIFIED, so FAILED means "withdrawals cannot send".
  signerMatchesAddress: 'VERIFIED' | 'FAILED' | 'NOT_CHECKED';
  chain: { expected: number; reported: number | null; agrees: boolean | null };
  balances: { usdc: string | null; eth: string | null }; // human units; null = NOT_CHECKED
  realStakingEnabled: boolean;
  // ready = a real withdrawal could actually send right now: configured, signer matches,
  // chain agrees, AND the escrow holds USDC (to pay out) and ETH (for gas).
  ready: boolean;
  notes: string[];
}

/**
 * Read-only escrow configuration + funding health. No transaction, no key in the output.
 * `reader` is injectable for tests; the default reads Base Sepolia live.
 */
export async function escrowHealth(reader?: EscrowChainReader): Promise<EscrowHealth> {
  // Precedence: explicit arg → injected test seam → real RPC reader.
  const read: EscrowChainReader = reader ?? chainReader ?? realChainReader;
  const notes: string[] = [];
  const escrowAddress = config.stakeEscrowAddress ?? null;
  const configured = !!(config.stakeEscrowSignerKey && config.stakeEscrowAddress);

  let signerMatchesAddress: EscrowHealth['signerMatchesAddress'] = 'NOT_CHECKED';
  if (!configured) {
    notes.push('STAKE_ESCROW_SIGNER_KEY and/or STAKE_ESCROW_ADDRESS not set — withdrawal is a stub and fails closed.');
  } else {
    try {
      const derived = new ethers.Wallet(config.stakeEscrowSignerKey as string).address;
      signerMatchesAddress = eqAddr(derived, config.stakeEscrowAddress as string) ? 'VERIFIED' : 'FAILED';
      if (signerMatchesAddress === 'FAILED') {
        notes.push('The signer key derives a DIFFERENT address than STAKE_ESCROW_ADDRESS — every refund will refuse. The two values must come from the same wallet account.');
      }
    } catch {
      signerMatchesAddress = 'FAILED';
      notes.push('STAKE_ESCROW_SIGNER_KEY is not a valid private key — refunds will refuse. Expect 64 hex chars (with or without 0x).');
    }
  }

  let reported: number | null = null;
  let usdcRaw: bigint | null = null;
  let ethRaw: bigint | null = null;
  if (escrowAddress && isAddress(escrowAddress)) {
    try {
      const r = await read(escrowAddress);
      reported = r.chainId;
      usdcRaw = r.usdc;
      ethRaw = r.eth;
    } catch {
      notes.push('Could not read the chain — balances and chain id NOT_CHECKED.');
    }
  } else if (configured) {
    notes.push('STAKE_ESCROW_ADDRESS is not a valid address.');
  }
  const agrees = reported === null ? null : reported === BASE_SEPOLIA_CHAIN_ID;
  if (agrees === false) {
    notes.push(`RPC reports chain ${reported}, not Base Sepolia (${BASE_SEPOLIA_CHAIN_ID}) — refunds will refuse.`);
  }

  // Format balances honestly: null stays null (NOT_CHECKED), never a stand-in zero.
  const usdcHuman = usdcRaw === null ? null : ethers.formatUnits(usdcRaw, 6);
  const ethHuman = ethRaw === null ? null : ethers.formatUnits(ethRaw, 18);
  if (usdcRaw !== null && usdcRaw === 0n) notes.push('Escrow holds 0 USDC — fund it before a withdrawal can pay out.');
  if (ethRaw !== null && ethRaw === 0n) notes.push('Escrow holds 0 ETH — fund a little Base Sepolia ETH for refund gas.');

  const ready =
    configured &&
    signerMatchesAddress === 'VERIFIED' &&
    agrees === true &&
    usdcRaw !== null && usdcRaw > 0n &&
    ethRaw !== null && ethRaw > 0n;
  if (ready) notes.push('READY: a real escrow→builder refund can be broadcast.');

  return {
    configured,
    escrowAddress,
    signerMatchesAddress,
    chain: { expected: BASE_SEPOLIA_CHAIN_ID, reported, agrees },
    balances: { usdc: usdcHuman, eth: ethHuman },
    realStakingEnabled: config.realStakingEnabled,
    ready,
    notes,
  };
}

/**
 * Initiate the escrow -> builder refund. Default-OFF: with no signer key this stubs,
 * and withdrawal fails closed. With the key set, it broadcasts a real Base Sepolia
 * USDC transfer under the three invariants above.
 *
 * `builderId` is accepted for signature parity with the stake-vault seam; the payee
 * is `to` (the builder's payout address), which stake-vault resolves from `builders`.
 */
export async function escrowRefund(
  _builderId: string,
  amount: bigint,
  to?: string,
): Promise<RefundInitiation> {
  if (!config.stakeEscrowSignerKey) {
    return stub(amount, to, 'escrow->builder refund not configured (STAKE_ESCROW_SIGNER_KEY unset)');
  }
  if (!isAddress(to)) {
    return refused(amount, to, 'builder payout address missing or invalid');
  }
  if (amount <= 0n) {
    return refused(amount, to, 'refund amount must be positive');
  }
  try {
    const send = sender ?? realSender;
    const { txHash } = await oneAtATime(() => send(to, amount));
    return { initiated: true, stub: false, amount: amount.toString(), to, txHash };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof RefundBroadcastUnconfirmed) {
      return { initiated: true, stub: false, unconfirmed: true, amount: amount.toString(), to, txHash: e.txHash, note: msg };
    }
    return refused(amount, to, `escrow refund failed: ${msg}`);
  }
}
