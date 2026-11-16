/**
 * AGENT SPEND, CAPPED ON-CHAIN (Sean's GO 2026-10-07, step d: "stake USDC and bind an agent so that
 * the agent can trade up to that amount and then test those transactions").
 *
 * (This header describes AGENT_SPEND_SOURCE=wallet, the default. With `stake`, the escrow pays out
 * of the owner's stake instead and the owner budget is the only cap: see agentSpendSource below.)
 *
 * THE CAP IS THE USDC CONTRACT, NOT THIS FILE. The person approves their agent's own wallet to move
 * up to N USDC from theirs (`USDC.approve(agentWallet, N)`, signed in their own wallet, never by
 * us). The agent then pays with `transferFrom(owner, payee, amount)`. If it asks for more than is
 * left, the token contract reverts — whatever this server, a prompt or a bug decides. Lowering the
 * approval to 0 stops the agent at once. Nothing here can raise the cap.
 *
 * What this file adds on top: every refusal the chain would make, made BEFORE anything is signed
 * (so a refused spend costs no gas and leaves no failed transaction), plus the ones the chain would
 * not make for us — the wrong chain, paying itself, no gas.
 *
 * TESTNET ONLY. Base Sepolia (84532) and its USDC, checked against the RPC's own chain id on every
 * request, not trusted from config. The agent's key is the custodied one (agent-wallet-manager.ts),
 * whose header says it must not touch real user funds without sign-off; testnet USDC is not that.
 * The route that calls this is OFF unless AGENT_SPEND_ENABLED=true (a dry run always works).
 */
import { ethers } from 'ethers';

export const SPEND_CHAIN_ID = 84532n;
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const USDC_DECIMALS = 6;
export const BASESCAN_TX = 'https://sepolia.basescan.org/tx/';

export const ERC20_SPEND_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
] as const;

/** "1.5" → 1_500_000n. Positive, at most 6 decimals, plain digits only. Anything else is null. */
export function parseUsdc(input: unknown): bigint | null {
  const s = typeof input === 'number' ? String(input) : input;
  if (typeof s !== 'string' || !/^\d+(\.\d{1,6})?$/.test(s.trim())) return null;
  const v = ethers.parseUnits(s.trim(), USDC_DECIMALS);
  return v > 0n ? v : null;
}

export const formatUsdc = (v: bigint) => ethers.formatUnits(v, USDC_DECIMALS);

export interface SpendRequest {
  owner: string;
  to: string;
  amount: bigint;
}

/** What the chain says, read before deciding. */
export interface SpendReads {
  chainId: bigint;
  /** How much the owner has approved the agent's wallet to move. The cap. */
  allowance: bigint;
  ownerBalance: bigint;
  agentEth: bigint;
}

export type SpendDecision = { ok: true } | { ok: false; status: number; code: string; message: string };

const refuse = (status: number, code: string, message: string): SpendDecision => ({ ok: false, status, code, message });

/**
 * Pure. Every refusal that can be decided from the request and the reads, in the order a person
 * would want to hear them. Gas is checked separately, after the chain has estimated it.
 */
export function decideSpend(req: SpendRequest, agentAddress: string, reads: SpendReads): SpendDecision {
  if (reads.chainId !== SPEND_CHAIN_ID) {
    return refuse(409, 'wrong_chain', `the RPC is on chain ${reads.chainId}, not Base Sepolia (84532). Nothing was sent.`);
  }
  if (!ethers.isAddress(req.owner)) return refuse(400, 'bad_owner', 'owner_address is not an address.');
  if (!ethers.isAddress(req.to)) return refuse(400, 'bad_payee', 'to_address is not an address.');
  const to = ethers.getAddress(req.to);
  const owner = ethers.getAddress(req.owner);
  const agent = ethers.getAddress(agentAddress);
  if (to === ethers.ZeroAddress) return refuse(400, 'bad_payee', 'to_address is the zero address.');
  if (owner === agent) return refuse(400, 'owner_is_agent', 'the owner and the agent are the same wallet, so there is no cap to spend under.');
  if (to === agent) {
    return refuse(400, 'pays_itself', 'the agent cannot pay its own wallet: moved there, the money would sit outside the cap you set.');
  }
  if (req.amount > reads.allowance) {
    return refuse(
      409,
      'over_cap',
      reads.allowance === 0n
        ? 'you have not approved this agent to spend any USDC (the cap is 0). Nothing was sent.'
        : `over the cap you approved: ${formatUsdc(req.amount)} USDC asked, ${formatUsdc(reads.allowance)} USDC left. Nothing was sent.`,
    );
  }
  if (req.amount > reads.ownerBalance) {
    return refuse(409, 'owner_balance', `the owner's wallet holds ${formatUsdc(reads.ownerBalance)} USDC, less than ${formatUsdc(req.amount)}. Nothing was sent.`);
  }
  return { ok: true };
}

/** The chain-facing pieces, injectable so the decision can be tested without a network. */
export interface SpendChain {
  chainId(): Promise<bigint>;
  allowance(owner: string, spender: string): Promise<bigint>;
  balanceOf(account: string): Promise<bigint>;
  ethBalance(account: string): Promise<bigint>;
  /** Wei the transfer would cost at current prices, with headroom. Throws if the chain would revert. */
  gasCost(agentKey: string, owner: string, to: string, amount: bigint): Promise<bigint>;
  send(agentKey: string, owner: string, to: string, amount: bigint): Promise<{ hash: string; blockNumber: number | null; status: number | null }>;
}

/**
 * The receipt inside an ethers v6 "transaction execution reverted" error, when it proves status 0.
 * Anything else (a timeout, a dropped connection, a replaced tx) is NOT a revert: the transfer may
 * have landed, so the caller must not release budget on it.
 */
export function revertedReceipt(e: unknown): { blockNumber: number | null } | null {
  const err = e as { code?: unknown; receipt?: { status?: unknown; blockNumber?: unknown } } | null;
  if (err?.code !== 'CALL_EXCEPTION' || err.receipt?.status !== 0) return null;
  return { blockNumber: typeof err.receipt.blockNumber === 'number' ? err.receipt.blockNumber : null };
}

export function rpcSpendChain(rpcUrl: string, usdc: string = USDC_BASE_SEPOLIA): SpendChain {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const read = new ethers.Contract(usdc, ERC20_SPEND_ABI, provider);
  const as = (key: string) => new ethers.Contract(usdc, ERC20_SPEND_ABI, new ethers.Wallet(key, provider));
  return {
    chainId: async () => (await provider.getNetwork()).chainId,
    allowance: (o, s) => read.getFunction('allowance')(o, s) as Promise<bigint>,
    balanceOf: (a) => read.getFunction('balanceOf')(a) as Promise<bigint>,
    ethBalance: (a) => provider.getBalance(a),
    gasCost: async (key, owner, to, amount) => {
      const gas = await as(key).getFunction('transferFrom').estimateGas(owner, to, amount);
      const fee = await provider.getFeeData();
      const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
      return gas * price * 2n;
    },
    send: async (key, owner, to, amount) => {
      const tx = await as(key).getFunction('transferFrom')(owner, to, amount);
      let receipt;
      try {
        receipt = await tx.wait(1);
      } catch (e) {
        // ethers v6 THROWS on a status-0 receipt instead of returning it. Without this, a reverted
        // spend surfaced as a generic error and its owner-budget reservation stayed `unknown`
        // (still counting) instead of being released (found reviewing #1550).
        const reverted = revertedReceipt(e);
        if (reverted) return { hash: tx.hash as string, blockNumber: reverted.blockNumber, status: 0 };
        throw e;
      }
      return { hash: tx.hash as string, blockNumber: receipt?.blockNumber ?? null, status: receipt?.status ?? null };
    },
  };
}

export interface SpendResult {
  tx_hash: string;
  basescan_url: string;
  block_number: number | null;
  from_owner: string;
  to: string;
  agent_wallet: string;
  amount_usdc: string;
  cap_before_usdc: string;
  cap_after_usdc: string | null;
}

export type CheckOutcome =
  | { ok: true; agentAddress: string; agentKey: string; reads: SpendReads; gasCostWei: bigint }
  | { ok: false; status: number; code: string; message: string; reads?: SpendReads; agentAddress?: string };

/**
 * Everything short of signing: load the agent's own key, read the chain, decide, estimate gas.
 * `loadAgent` returns the agent's custodied key and the wallet address on record.
 */
export async function checkSpend(
  chain: SpendChain,
  loadAgent: () => Promise<{ key: string | null; walletAddress: string | null }>,
  req: SpendRequest,
): Promise<CheckOutcome> {
  const { key, walletAddress } = await loadAgent();
  if (!key) return { ok: false, status: 409, code: 'no_wallet', message: 'this agent has no wallet of its own to spend from.' };
  const address = new ethers.Wallet(key).address;
  if (!walletAddress || address.toLowerCase() !== walletAddress.toLowerCase()) {
    return { ok: false, status: 409, code: 'wallet_mismatch', message: "this agent's key is not for its recorded wallet. Nothing was sent." };
  }
  if (!ethers.isAddress(req.owner)) return { ok: false, status: 400, code: 'bad_owner', message: 'owner_address is not an address.' };
  const [chainId, allowance, ownerBalance, agentEth] = await Promise.all([
    chain.chainId(),
    chain.allowance(req.owner, address),
    chain.balanceOf(req.owner),
    chain.ethBalance(address),
  ]);
  const reads: SpendReads = { chainId, allowance, ownerBalance, agentEth };
  const decision = decideSpend(req, address, reads);
  if (!decision.ok) return { ...decision, reads, agentAddress: address };

  let gasCostWei: bigint;
  try {
    gasCostWei = await chain.gasCost(key, req.owner, req.to, req.amount);
  } catch (e) {
    const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { ok: false, status: 409, code: 'would_revert', message: `the chain would refuse this transfer (${why}). Nothing was sent.`, reads, agentAddress: address };
  }
  if (agentEth < gasCostWei) {
    return {
      ok: false,
      status: 409,
      code: 'no_gas',
      message: `the agent's wallet needs Base Sepolia ETH for gas: it holds ${ethers.formatEther(agentEth)}, needs about ${ethers.formatEther(gasCostWei)}. Nothing was sent.`,
      reads,
      agentAddress: address,
    };
  }
  return { ok: true, agentAddress: address, agentKey: key, reads, gasCostWei };
}

/**
 * The receipt says status 0: the transfer reverted and no USDC moved. Only this case may release
 * an owner-budget reservation. Any other failure (a throw, no receipt) may have landed.
 */
export class SpendRevertedError extends Error {
  constructor(readonly txHash: string) {
    super(`transfer ${txHash} did not succeed on-chain (status 0)`);
    this.name = 'SpendRevertedError';
  }
}

/**
 * WHERE AN AGENT'S SPEND COMES FROM (AGENT_SPEND_SOURCE; Sean chose option B, 2026-11-15).
 *
 *   wallet (default)  everything above: the agent's wallet calls transferFrom(owner, payee) under
 *                     the owner's approval. With the owner budget on, the same amount ALSO stays
 *                     locked in escrow for good, so every spend cost the owner twice.
 *   stake             the ESCROW pays the payee out of the owner's stake (escrow-refunder.ts, the
 *                     same guarded send a refund uses). The stake is a prepaid balance: no approval,
 *                     no gas in the agent's wallet, and what is spent is what left the escrow.
 *                     The owner budget is then the ONLY cap, so the route refuses unless
 *                     OWNER_BUDGET_MODE=enforce, and a withdrawal always checks the ledger.
 *
 * Any other value is 'invalid': the route refuses every spend, and withdrawals treat it as stake
 * (ledger checked). A typo in a money control fails closed.
 */
export type SpendSource = 'wallet' | 'stake' | 'invalid';

export function agentSpendSource(raw: string | undefined = process.env.AGENT_SPEND_SOURCE): SpendSource {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'wallet') return 'wallet';
  if (v === 'stake') return 'stake';
  console.error(`[agent-spend] AGENT_SPEND_SOURCE=${JSON.stringify(raw)} is not wallet or stake: refusing spends (fail closed).`);
  return 'invalid';
}

/** Pure. The payee refusals for a spend paid from the stake, before anything is reserved. */
export function decideStakeSpend(to: string, escrow: string, agentWallet: string | null): SpendDecision {
  if (!ethers.isAddress(to)) return refuse(400, 'bad_payee', 'to_address is not an address.');
  const payee = ethers.getAddress(to);
  if (payee === ethers.ZeroAddress) return refuse(400, 'bad_payee', 'to_address is the zero address.');
  // Compare the raw 20 bytes, not ethers' checksummed form: a mixed-case value with a bad EIP-55
  // checksum fails ethers.isAddress, and a guard written that way would silently skip (Grok r1b on #1551).
  const raw = (a: string | null) => (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null);
  const p = payee.toLowerCase();
  if (raw(escrow) === p) {
    return refuse(400, 'pays_escrow', 'the payee is the escrow itself: the money would not leave, and the budget would still be used up.');
  }
  if (raw(agentWallet) === p) {
    return refuse(400, 'pays_itself', "the agent cannot pay its own wallet: from there it could spend outside its owner's budget.");
  }
  return { ok: true };
}

export async function executeSpend(chain: SpendChain, checked: Extract<CheckOutcome, { ok: true }>, req: SpendRequest): Promise<SpendResult> {
  const sent = await chain.send(checked.agentKey, req.owner, req.to, req.amount);
  if (sent.status === 0) throw new SpendRevertedError(sent.hash);
  if (sent.status !== 1) throw new Error(`transfer ${sent.hash} did not succeed on-chain (status ${sent.status})`);
  let after: bigint | null = null;
  try {
    after = await chain.allowance(req.owner, checked.agentAddress);
  } catch {
    after = null; // the receipt stands; the read-back is reported as unknown, not guessed
  }
  return {
    tx_hash: sent.hash,
    basescan_url: `${BASESCAN_TX}${sent.hash}`,
    block_number: sent.blockNumber,
    from_owner: ethers.getAddress(req.owner),
    to: ethers.getAddress(req.to),
    agent_wallet: checked.agentAddress,
    amount_usdc: formatUsdc(req.amount),
    cap_before_usdc: formatUsdc(checked.reads.allowance),
    cap_after_usdc: after === null ? null : formatUsdc(after),
  };
}

/**
 * WHAT AN UNBIND LEAVES ON CHAIN (R4, 2026-11-16).
 *
 * Unbinding writes `revoked_at` on the binding and nothing else. In AGENT_SPEND_SOURCE=wallet the
 * owner gave the agent's wallet a USDC approval, and an ERC-20 approval changes only when the
 * OWNER's wallet calls approve (or the spender uses it up). So the approval outlives the unbind.
 * This server refuses every spend by an unbound agent (routes/agent-spend.ts, not_bound), but the
 * agent wallet's key is still custodied here, so "nothing can spend it" would be a claim about this
 * code, not about the chain. The unbind answer therefore states the live allowance, read from the
 * chain, and how to end it. Stake mode has no approval, so it reads 0.
 *
 * A failed read is NOT_CHECKED, never "0". [V 2026-11-16, block 59404267: every owner -> agent
 * wallet pair on record, the one revoked binding included, reads 0; the E2E runs used stake mode.]
 */
export type UnbindApproval =
  | { checked: true; live: false; allowance_usdc: string; note?: string }
  | { checked: true; live: true; allowance_usdc: string; agent_wallet: string; statement: string; how_to_end: string }
  | { checked: false; reason: string };

const UNBIND_READ_TIMEOUT_MS = 10_000;

export async function approvalAfterUnbind(
  read: Pick<SpendChain, 'chainId' | 'allowance'>,
  owner: string | null | undefined,
  agentWallet: string | null | undefined,
): Promise<UnbindApproval> {
  if (!agentWallet) return { checked: true, live: false, allowance_usdc: '0.0', note: 'This agent has no wallet, so no approval to it can exist.' };
  if (!owner || !ethers.isAddress(owner) || !ethers.isAddress(agentWallet)) {
    return { checked: false, reason: 'The owner or agent wallet on record is not an address, so the on-chain approval was not read.' };
  }
  let allowance: bigint;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${UNBIND_READ_TIMEOUT_MS} ms`)), UNBIND_READ_TIMEOUT_MS);
    });
    const [chainId, a] = await Promise.race([Promise.all([read.chainId(), read.allowance(owner, agentWallet)]), timeout]);
    if (chainId !== SPEND_CHAIN_ID) return { checked: false, reason: `The RPC answered for chain ${chainId}, not Base Sepolia, so the approval was not read.` };
    allowance = a;
  } catch (e: unknown) {
    // Never echo the RPC error (Strix on #1559): ethers puts the request URL in its message, and a
    // provider URL can carry an API key (https://<provider>/v2/<key>). The text goes to the server log.
    const msg = (e as Error)?.message ?? String(e);
    console.error('[agent-spend] unbind approval read failed:', msg);
    const why = /no answer in \d+ ms/.test(msg) ? 'the RPC did not answer in time' : 'the RPC read failed';
    return { checked: false, reason: `Could not read the approval from the chain: ${why}. It may still be live.` };
  } finally {
    clearTimeout(timer);
  }
  if (allowance === 0n) return { checked: true, live: false, allowance_usdc: '0.0' };
  const wallet = ethers.getAddress(agentWallet);
  return {
    checked: true,
    live: true,
    allowance_usdc: formatUsdc(allowance),
    agent_wallet: wallet,
    statement:
      `Unbinding does not change your on-chain USDC approval. Your wallet still allows this agent's wallet (${wallet}) ` +
      `to move up to ${formatUsdc(allowance)} USDC. This server refuses every spend by an unbound agent, but the approval ` +
      `itself stays live on Base Sepolia until your wallet sets it to 0.`,
    how_to_end: `From your wallet, call USDC.approve(${wallet}, 0) on Base Sepolia (USDC ${USDC_BASE_SEPOLIA}).`,
  };
}
