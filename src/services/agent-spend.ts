/**
 * AGENT SPEND, CAPPED ON-CHAIN (Sean's GO 2026-10-07, step d: "stake USDC and bind an agent so that
 * the agent can trade up to that amount and then test those transactions").
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
      const receipt = await tx.wait(1);
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
  | { ok: false; status: number; code: string; message: string; reads?: SpendReads };

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
  if (!decision.ok) return { ...decision, reads };

  let gasCostWei: bigint;
  try {
    gasCostWei = await chain.gasCost(key, req.owner, req.to, req.amount);
  } catch (e) {
    const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { ok: false, status: 409, code: 'would_revert', message: `the chain would refuse this transfer (${why}). Nothing was sent.`, reads };
  }
  if (agentEth < gasCostWei) {
    return {
      ok: false,
      status: 409,
      code: 'no_gas',
      message: `the agent's wallet needs Base Sepolia ETH for gas: it holds ${ethers.formatEther(agentEth)}, needs about ${ethers.formatEther(gasCostWei)}. Nothing was sent.`,
      reads,
    };
  }
  return { ok: true, agentAddress: address, agentKey: key, reads, gasCostWei };
}

export async function executeSpend(chain: SpendChain, checked: Extract<CheckOutcome, { ok: true }>, req: SpendRequest): Promise<SpendResult> {
  const sent = await chain.send(checked.agentKey, req.owner, req.to, req.amount);
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
