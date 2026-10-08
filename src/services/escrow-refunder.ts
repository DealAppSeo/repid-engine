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
  // getFunction returns a defined ContractMethod (satisfies noUncheckedIndexedAccess,
  // which makes `usdc.transfer` typed as possibly-undefined).
  const tx = await usdc.getFunction('transfer')(to, amount);
  const receipt = await tx.wait(Math.max(1, config.stakeMinConfirmations));
  if (!receipt || receipt.status !== 1) throw new Error('refund tx not confirmed');
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
    const { txHash } = await send(to, amount);
    return { initiated: true, stub: false, amount: amount.toString(), to, txHash };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return refused(amount, to, `escrow refund failed: ${msg}`);
  }
}
